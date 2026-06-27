/**
 * RelayServer — the untrusted dumb pipe (invariant #1, #5).
 *
 * Responsibilities (and ONLY these): authenticate peers (shared token, Phase 0), maintain a routing
 * table keyed by `deviceId`, forward application frames OPAQUELY (raw bytes, never parsed), report
 * daemon presence to browsers, and keep connections alive with heartbeats.
 *
 * Explicitly NOT responsibilities: reading/altering payloads, holding session content, inspecting
 * sessionId/clientInstanceId for routing, or enforcing any policy. The daemon is the security boundary.
 *
 * Routing:
 *   browser frame  -> the single daemon registered for that deviceId
 *   daemon  frame  -> broadcast to every browser registered for that deviceId
 * Routing uses the connection's REGISTERED deviceId (set at handshake), so a peer cannot cross-route
 * by spoofing `deviceId` inside a frame.
 */

import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  isRelayRegister,
  type RelayError,
  type RelayPeer,
  type RelayRegistered,
  type RelayRole,
} from "./messages.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

export interface RelayServerOptions {
  port: number;
  /** Shared bearer token peers must present (Phase 0). */
  token: string;
  host?: string;
  /** Ping interval; a socket that misses a pong between pings is terminated. Default 30s. */
  heartbeatMs?: number;
  /** A connection must send relay_register within this window or be dropped. Default 10s. */
  registerTimeoutMs?: number;
  /** Max bytes per frame. Default 16 MiB. */
  maxPayloadBytes?: number;
  logger?: Logger;
}

interface Conn {
  ws: WebSocket;
  role?: RelayRole;
  deviceId?: string;
  clientInstanceId?: string;
  registered: boolean;
  isAlive: boolean;
  registerTimer?: NodeJS.Timeout;
}

interface DeviceBucket {
  daemon?: Conn;
  browsers: Set<Conn>;
}

const DEFAULTS = {
  heartbeatMs: 30_000,
  registerTimeoutMs: 10_000,
  maxPayloadBytes: 16 * 1024 * 1024,
};

export class RelayServer {
  private readonly opts: Required<Omit<RelayServerOptions, "logger" | "host">> &
    Pick<RelayServerOptions, "host"> & { logger: Logger };
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly devices = new Map<string, DeviceBucket>();
  private readonly conns = new Set<Conn>();

  constructor(options: RelayServerOptions) {
    this.opts = {
      port: options.port,
      token: options.token,
      host: options.host,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      registerTimeoutMs: options.registerTimeoutMs ?? DEFAULTS.registerTimeoutMs,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes,
      logger: options.logger ?? defaultLogger,
    };
  }

  /** Start listening. Resolves with the actual bound port (useful when port=0 in tests). */
  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.opts.port,
        host: this.opts.host,
        maxPayload: this.opts.maxPayloadBytes,
      });
      this.wss = wss;
      wss.on("connection", (ws) => this.onConnection(ws));
      wss.on("error", (err) => this.opts.logger("error", "wss error", { err: String(err) }));
      wss.once("listening", () => {
        const addr = wss.address() as AddressInfo;
        this.heartbeat = setInterval(() => this.pingAll(), this.opts.heartbeatMs);
        // Don't keep the process alive solely for the heartbeat timer.
        this.heartbeat.unref?.();
        this.opts.logger("info", "relay listening", { port: addr.port });
        resolve({ port: addr.port });
      });
      wss.once("error", reject);
    });
  }

  /** Stop the relay: clear timers, close every socket, close the server. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      for (const c of this.conns) {
        if (c.registerTimer) clearTimeout(c.registerTimer);
        try {
          c.ws.terminate();
        } catch {
          /* ignore */
        }
      }
      this.conns.clear();
      this.devices.clear();
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  /** Current connection/device counts — for tests and ops. */
  stats(): { devices: number; connections: number; daemons: number; browsers: number } {
    let daemons = 0;
    let browsers = 0;
    for (const b of this.devices.values()) {
      if (b.daemon) daemons++;
      browsers += b.browsers.size;
    }
    return { devices: this.devices.size, connections: this.conns.size, daemons, browsers };
  }

  // ───────────────────────────── connection lifecycle ─────────────────────────────

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, registered: false, isAlive: true };
    this.conns.add(conn);

    conn.registerTimer = setTimeout(() => {
      if (!conn.registered) {
        this.sendError(ws, "register_timeout", "no relay_register within timeout");
        ws.close();
      }
    }, this.opts.registerTimeoutMs);
    conn.registerTimer.unref?.();

    ws.on("pong", () => {
      conn.isAlive = true;
    });
    ws.on("message", (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on("close", () => this.onClose(conn));
    ws.on("error", (err) =>
      this.opts.logger("warn", "socket error", { err: String(err), deviceId: conn.deviceId }),
    );
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (!conn.registered) {
      this.handleRegister(conn, data, isBinary);
      return;
    }
    // Registered: forward opaquely. The relay does not parse application frames.
    if (conn.role === "browser") {
      this.routeBrowserToDaemon(conn, data, isBinary);
    } else {
      this.routeDaemonToBrowsers(conn, data, isBinary);
    }
  }

  private handleRegister(conn: Conn, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendError(conn.ws, "bad_register", "first frame must be a JSON relay_register");
      conn.ws.close();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.sendError(conn.ws, "bad_register", "relay_register is not valid JSON");
      conn.ws.close();
      return;
    }
    if (!isRelayRegister(parsed)) {
      this.sendError(conn.ws, "bad_register", "malformed relay_register");
      conn.ws.close();
      return;
    }
    if (!this.tokenOk(parsed.token)) {
      this.sendError(conn.ws, "bad_token", "invalid token");
      conn.ws.close();
      return;
    }

    conn.registered = true;
    conn.role = parsed.role;
    conn.deviceId = parsed.deviceId;
    conn.clientInstanceId = parsed.clientInstanceId;
    if (conn.registerTimer) clearTimeout(conn.registerTimer);

    const bucket = this.bucketFor(parsed.deviceId);
    let peerOnline: boolean;

    if (parsed.role === "daemon") {
      if (bucket.daemon && bucket.daemon !== conn) {
        // Replace a stale daemon (reconnect). Terminate the old socket.
        const old = bucket.daemon;
        this.opts.logger("info", "replacing existing daemon", { deviceId: parsed.deviceId });
        try {
          old.ws.terminate();
        } catch {
          /* ignore */
        }
      }
      bucket.daemon = conn;
      peerOnline = bucket.browsers.size > 0;
      this.broadcastPeerState(bucket, true);
    } else {
      bucket.browsers.add(conn);
      peerOnline = !!bucket.daemon;
    }

    const ack: RelayRegistered = {
      type: "relay_registered",
      ok: true,
      role: parsed.role,
      deviceId: parsed.deviceId,
      peerOnline,
    };
    this.sendJson(conn.ws, ack);
    this.opts.logger("info", "registered", {
      role: parsed.role,
      deviceId: parsed.deviceId,
      clientInstanceId: parsed.clientInstanceId,
    });
  }

  private routeBrowserToDaemon(conn: Conn, data: RawData, isBinary: boolean): void {
    const bucket = this.devices.get(conn.deviceId!);
    const daemon = bucket?.daemon;
    if (!daemon || daemon.ws.readyState !== WebSocket.OPEN) {
      this.sendError(conn.ws, "device_offline", "no daemon connected for this device");
      return;
    }
    this.forward(daemon.ws, data, isBinary);
  }

  private routeDaemonToBrowsers(conn: Conn, data: RawData, isBinary: boolean): void {
    const bucket = this.devices.get(conn.deviceId!);
    if (!bucket) return;
    for (const b of bucket.browsers) {
      if (b.ws.readyState === WebSocket.OPEN) this.forward(b.ws, data, isBinary);
    }
  }

  private onClose(conn: Conn): void {
    if (conn.registerTimer) clearTimeout(conn.registerTimer);
    this.conns.delete(conn);
    if (!conn.registered || !conn.deviceId) return;
    const bucket = this.devices.get(conn.deviceId);
    if (!bucket) return;

    if (conn.role === "daemon") {
      if (bucket.daemon === conn) {
        bucket.daemon = undefined;
        this.broadcastPeerState(bucket, false);
        this.opts.logger("info", "daemon disconnected", { deviceId: conn.deviceId });
      }
    } else {
      bucket.browsers.delete(conn);
    }
    if (!bucket.daemon && bucket.browsers.size === 0) {
      this.devices.delete(conn.deviceId);
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private bucketFor(deviceId: string): DeviceBucket {
    let b = this.devices.get(deviceId);
    if (!b) {
      b = { browsers: new Set() };
      this.devices.set(deviceId, b);
    }
    return b;
  }

  private broadcastPeerState(bucket: DeviceBucket, online: boolean): void {
    const frame: RelayPeer = { type: "relay_peer", role: "daemon", online };
    for (const b of bucket.browsers) {
      if (b.ws.readyState === WebSocket.OPEN) this.sendJson(b.ws, frame);
    }
  }

  private tokenOk(provided: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(this.opts.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private forward(target: WebSocket, data: RawData, isBinary: boolean): void {
    target.send(data, { binary: isBinary });
  }

  private sendJson(ws: WebSocket, frame: RelayRegistered | RelayError | RelayPeer): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private sendError(ws: WebSocket, code: RelayError["code"], message: string): void {
    this.sendJson(ws, { type: "relay_error", ok: false, code, message });
  }

  private pingAll(): void {
    for (const conn of this.conns) {
      if (!conn.isAlive) {
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }
}

const defaultLogger: Logger = (level, message, meta) => {
  const line = `[relay] ${level} ${message}`;
  if (level === "error" || level === "warn") console.error(line, meta ?? "");
  else console.log(line, meta ?? "");
};
