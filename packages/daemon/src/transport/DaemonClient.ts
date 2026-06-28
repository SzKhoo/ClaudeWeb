/**
 * DaemonClient — the daemon's OUTBOUND connection to the relay (invariant: device is outbound-only,
 * never a listening server). It performs the relay-local handshake (relay_register, role "daemon"),
 * pumps relay frames to the Daemon, installs/clears the Daemon's outbound transport around the socket
 * lifetime, and auto-reconnects with capped exponential backoff so a flaky network self-heals.
 *
 * It separates the TWO frame planes:
 *   - relay-local control frames (relay_registered / relay_error / relay_peer) — consumed HERE,
 *   - everything else (ConnHello + TransportEnvelopes) — handed verbatim to Daemon.handleInbound.
 */

import { WebSocket, type RawData } from "ws";
import { Daemon } from "../Daemon.js";

export type ClientLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface DaemonClientOptions {
  /** Relay URL, e.g. ws://localhost:8787 */
  url: string;
  token: string;
  deviceId: string;
  daemon: Daemon;
  /** Reconnect on unexpected close. Default true. */
  reconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  logger?: ClientLogger;
}

const RELAY_FRAME_TYPES: ReadonlySet<string> = new Set([
  "relay_registered",
  "relay_error",
  "relay_peer",
]);

export class DaemonClient {
  private readonly opts: Required<Omit<DaemonClientOptions, "logger">> & { logger: ClientLogger };
  private ws: WebSocket | undefined;
  private stopped = false;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private registeredOnce: (() => void) | undefined;

  constructor(options: DaemonClientOptions) {
    this.opts = {
      url: options.url,
      token: options.token,
      deviceId: options.deviceId,
      daemon: options.daemon,
      reconnect: options.reconnect ?? true,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15_000,
      logger: options.logger ?? (() => {}),
    };
    this.backoff = this.opts.minBackoffMs;
  }

  /** Connect and resolve once the relay accepts our registration the first time. */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.registeredOnce = resolve;
      this.connect();
    });
  }

  /** Close the connection and stop reconnecting. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.opts.daemon.setTransport(undefined);
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      try {
        ws.close();
      } catch {
        resolve();
      }
    });
  }

  // ───────────────────────────── connection lifecycle ─────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.opts.logger("info", "relay socket open; registering");
      this.sendRegister(ws);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => this.onMessage(ws, data, isBinary));
    ws.on("close", () => this.onClose());
    ws.on("error", (err) => this.opts.logger("warn", "relay socket error", { err: String(err) }));
  }

  private sendRegister(ws: WebSocket): void {
    const register = {
      type: "relay_register",
      token: this.opts.token,
      role: "daemon",
      deviceId: this.opts.deviceId,
    };
    ws.send(JSON.stringify(register));
  }

  private onMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) return; // protocol is JSON text frames
    const text = data.toString();
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown }).type;
    } catch {
      this.opts.logger("warn", "dropping non-JSON relay frame");
      return;
    }

    if (typeof type === "string" && RELAY_FRAME_TYPES.has(type)) {
      this.handleRelayFrame(ws, type, text);
      return;
    }
    // End-to-end frame (ConnHello / TransportEnvelope) → the Daemon owns it.
    void this.opts.daemon.handleInbound(text);
  }

  private handleRelayFrame(ws: WebSocket, type: string, text: string): void {
    if (type === "relay_registered") {
      this.opts.logger("info", "registered with relay");
      this.backoff = this.opts.minBackoffMs; // reset backoff on a clean registration
      this.opts.daemon.setTransport((raw) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      });
      this.registeredOnce?.();
      this.registeredOnce = undefined;
      return;
    }
    if (type === "relay_error") {
      this.opts.logger("warn", "relay error frame", { frame: text });
      return;
    }
    // relay_peer (browser presence) — informational in Phase 0.
    this.opts.logger("debug", "relay peer frame", { frame: text });
  }

  private onClose(): void {
    this.opts.daemon.setTransport(undefined);
    this.ws = undefined;
    if (this.stopped || !this.opts.reconnect) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.opts.logger("info", "relay disconnected; reconnecting", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }
}
