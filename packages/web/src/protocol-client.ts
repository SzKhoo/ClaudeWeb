/**
 * Connection — the browser's transport client (mirror of the daemon's DaemonClient). It does the
 * relay-local handshake (relay_register, role "browser"), the E2E handshake (ConnHello/ConnAck),
 * SIGNS every command, orders/dedups inbound events by the global session seq, and on (re)connect
 * issues a `resume{sinceSeq, toolStreamOffsets}` to backfill what it missed (invariant #3).
 *
 * It references no DOM-only types (it takes a structural `WebSocketLike`), so the node e2e test imports
 * it directly and injects `ws`; in the browser it defaults to the global WebSocket.
 */

import {
  isTransportEnvelope,
  newEnvelope,
  signEnvelope,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ApplicationCommand,
  type ApplicationEvent,
  type Capability,
  type ConnHello,
  type TransportEnvelope,
} from "@wcc/shared";

const WS_OPEN = 1;

/** Minimal structural view of a WebSocket — satisfied by both the browser global and `ws`. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export type ConnectionStatus =
  | "connecting"
  | "registered"
  | "ready"
  | "daemon-offline"
  | "closed"
  | "error";

export interface ConnectionOptions {
  url: string;
  token: string;
  deviceId: string;
  sessionId: string;
  clientInstanceId: string;
  /** 32-byte Ed25519 secret used to sign commands. */
  secretKey: Uint8Array;
  capabilities?: Capability[];
  /** Inject a WebSocket implementation (tests pass `ws`); defaults to the global WebSocket. */
  WebSocketImpl?: WebSocketCtor;
  autoReconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onEvent?: (event: ApplicationEvent) => void;
  onStatus?: (status: ConnectionStatus) => void;
  logger?: (level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown) => void;
}

const DEFAULT_CAPS: Capability[] = ["stream", "tool-approval", "diff-preview", "interrupt", "resume"];

export class Connection {
  private readonly opts: Required<
    Omit<ConnectionOptions, "onEvent" | "onStatus" | "logger" | "WebSocketImpl" | "capabilities">
  > & Pick<ConnectionOptions, "onEvent" | "onStatus" | "WebSocketImpl"> & {
      capabilities: Capability[];
      logger: NonNullable<ConnectionOptions["logger"]>;
    };

  private ws: WebSocketLike | undefined;
  private stopped = false;
  private seq = 0;
  private highestSeq = 0;
  private readonly toolOffsets = new Map<string, number>();
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ConnectionOptions) {
    this.opts = {
      url: options.url,
      token: options.token,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
      clientInstanceId: options.clientInstanceId,
      secretKey: options.secretKey,
      capabilities: options.capabilities ?? DEFAULT_CAPS,
      autoReconnect: options.autoReconnect ?? true,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15_000,
      ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      logger: options.logger ?? (() => {}),
    };
    this.backoff = this.opts.minBackoffMs;
    // Restore the outgoing seq high-water mark from localStorage so a page reload doesn't
    // collide with the daemon's ReplayGuard (which persists in-memory across the browser
    // reload but not across daemon restarts). See docs/notes on invariant #4.
    this.seq = readPersistedSeq(options.sessionId, options.clientInstanceId);
  }

  /** Highest session seq received so far (the resume cursor). */
  get cursor(): number {
    return this.highestSeq;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.setStatus("closed");
  }

  /** Sign and send a command. Returns false if the socket isn't ready. */
  async send(command: ApplicationCommand): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    const nextSeq = ++this.seq;
    writePersistedSeq(this.opts.sessionId, this.opts.clientInstanceId, nextSeq);
    const env = newEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.opts.deviceId,
      sessionId: this.opts.sessionId,
      clientInstanceId: this.opts.clientInstanceId,
      seq: nextSeq,
      payload: command,
    });
    const sig = await signEnvelope(env, this.opts.secretKey);
    ws.send(JSON.stringify({ ...env, sig }));
    return true;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  private open(): void {
    if (this.stopped) return;
    const Ctor = this.resolveWebSocket();
    this.setStatus("connecting");
    const ws = new Ctor(this.opts.url);
    this.ws = ws;
    ws.addEventListener("open", () => this.sendRegister(ws));
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data ?? "")));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => this.setStatus("error"));
  }

  private sendRegister(ws: WebSocketLike): void {
    ws.send(
      JSON.stringify({
        type: "relay_register",
        token: this.opts.token,
        role: "browser",
        deviceId: this.opts.deviceId,
        clientInstanceId: this.opts.clientInstanceId,
      }),
    );
  }

  private onMessage(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    const type = (frame as { type?: unknown }).type;

    if (type === "relay_registered") {
      this.setStatus("registered");
      this.sendHello();
      return;
    }
    if (type === "relay_error") {
      this.opts.logger("warn", "relay error", frame);
      return;
    }
    if (type === "relay_peer") {
      const online = (frame as { online?: unknown }).online === true;
      if (online) this.sendHello(); // daemon came back → re-handshake + resume
      else this.setStatus("daemon-offline");
      return;
    }
    if (type === "conn_ack") {
      const target = (frame as { clientInstanceId?: unknown }).clientInstanceId;
      if (target === undefined || target === "" || target === this.opts.clientInstanceId) {
        const ok = (frame as { ok?: unknown }).ok === true;
        this.setStatus(ok ? "ready" : "error");
        this.backoff = this.opts.minBackoffMs;
        if (ok) void this.sendResume();
      }
      return;
    }

    if (isTransportEnvelope(frame)) this.applyEnvelope(frame);
  }

  private applyEnvelope(env: TransportEnvelope): void {
    // Only frames addressed to us or broadcast.
    if (env.clientInstanceId !== "*" && env.clientInstanceId !== this.opts.clientInstanceId) return;
    const event = env.payload as ApplicationEvent;
    const seq = env.seq;
    // session_status/machine_state are idempotent snapshots; seq 0 is out-of-band (rejections).
    const alwaysApply = event.type === "session_status" || event.type === "machine_state" || seq === 0;
    if (!alwaysApply && seq <= this.highestSeq) return; // duplicate log event
    if (seq > this.highestSeq) this.highestSeq = seq;
    if (event.type === "tool_stream") {
      const next = event.offset + event.chunk.length; // next byte offset this client has consumed
      const prev = this.toolOffsets.get(event.toolId) ?? 0;
      this.toolOffsets.set(event.toolId, Math.max(prev, next));
    }
    this.opts.onEvent?.(event);
  }

  private sendHello(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    const hello: ConnHello = {
      type: "conn_hello",
      role: "browser",
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      capabilities: this.opts.capabilities,
      deviceId: this.opts.deviceId,
      clientInstanceId: this.opts.clientInstanceId,
    };
    ws.send(JSON.stringify(hello));
  }

  private async sendResume(): Promise<void> {
    await this.send({
      type: "resume",
      sinceSeq: this.highestSeq,
      ...(this.toolOffsets.size > 0 ? { toolStreamOffsets: Object.fromEntries(this.toolOffsets) } : {}),
    });
  }

  private onClose(): void {
    this.ws = undefined;
    if (this.stopped) return;
    this.setStatus("closed");
    if (!this.opts.autoReconnect) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private setStatus(status: ConnectionStatus): void {
    this.opts.onStatus?.(status);
  }

  private resolveWebSocket(): WebSocketCtor {
    const impl =
      this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!impl) throw new Error("No WebSocket implementation available");
    return impl;
  }
}

/**
 * Persist the outgoing envelope seq per (sessionId, clientInstanceId) in localStorage so a page
 * reload never regresses the counter and hits the daemon's ReplayGuard as a duplicate. In node
 * (tests) localStorage is absent, and seq lives only in memory for the Connection's lifetime.
 */
function seqStorageKey(sessionId: string, clientInstanceId: string): string {
  return `wcc.seq.v1.${sessionId}.${clientInstanceId}`;
}

function readPersistedSeq(sessionId: string, clientInstanceId: string): number {
  if (typeof localStorage === "undefined") return 0;
  try {
    const raw = localStorage.getItem(seqStorageKey(sessionId, clientInstanceId));
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writePersistedSeq(sessionId: string, clientInstanceId: string, seq: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(seqStorageKey(sessionId, clientInstanceId), String(seq));
  } catch {
    /* quota exceeded or storage disabled — best-effort only */
  }
}
