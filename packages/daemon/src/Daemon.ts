/**
 * Daemon — the security boundary (invariant #1). It owns the WorkspaceManager and the live Session,
 * verifies EVERY inbound command (signature + freshness + replay + authorization) before acting, and
 * frames every outbound event for the relay. The relay is an untrusted pipe; the Daemon never trusts
 * it, never executes on its say-so, and addresses clients itself via the envelope's clientInstanceId.
 *
 * Two inbound frame shapes arrive (both forwarded opaquely by the relay):
 *   - bare ConnHello (capability/version negotiation) → reply ConnAck (no signature; not a command),
 *   - TransportEnvelope wrapping a signed ApplicationCommand → verify → Session.handleCommand.
 *
 * Outbound events are unsigned TransportEnvelopes whose `clientInstanceId` is the ADDRESSEE ("*" =
 * broadcast, or a specific client for targeted resume backfill). The relay broadcasts daemon frames to
 * every browser on the device; each browser keeps only the frames addressed to it or to "*".
 */

import {
  isTransportEnvelope,
  negotiateCapabilities,
  negotiateVersion,
  newEnvelope,
  isCompatible,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ApplicationEvent,
  type Capability,
  type ConnAck,
  type ConnHello,
  type TransportEnvelope,
} from "@wcc/shared";
import { CommandVerifier, type PairingStore, type VerifyReason } from "./security/CommandVerifier.js";
import { Session, type OutgoingEvent } from "./session/Session.js";
import { SessionStorage } from "./storage/SessionStorage.js";
import type { JournalSink } from "./storage/journal.js";
import { WorkspaceManager, type WorkspaceConfig } from "./workspace/workspace.js";
import type { IAgentEngine } from "@wcc/shared";

export type DaemonLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => void;

/** Capabilities this daemon build understands (intersected with the browser's during the handshake). */
const DAEMON_CAPABILITIES: readonly Capability[] = [
  "stream",
  "tool-approval",
  "diff-preview",
  "interrupt",
  "resume",
  "conversation-resume",
  "multi-client",
];

export interface DaemonOptions {
  deviceId: string;
  sessionId: string;
  workspaces: WorkspaceConfig[];
  engine: IAgentEngine;
  journal: JournalSink;
  pairing: PairingStore;
  /** Resume a prior engine conversation, if any. */
  resumeCheckpoint?: string;
  maxSkewMs?: number;
  permissionTimeoutMs?: number;
  maxReplayEvents?: number;
  maxToolStreamBytes?: number;
  now?: () => number;
  logger?: DaemonLogger;
}

export class Daemon {
  readonly deviceId: string;
  readonly sessionId: string;
  private readonly workspaces: WorkspaceManager;
  private readonly verifier: CommandVerifier;
  private readonly session: Session;
  private readonly now: () => number;
  private readonly log: DaemonLogger;

  /** Outbound transport, installed by the transport layer (DaemonClient) once the WS is up. */
  private transmit: ((raw: string) => void) | undefined;

  private rejected = 0;
  private lastReject: VerifyReason | "wrong_session" | undefined;

  constructor(opts: DaemonOptions) {
    this.deviceId = opts.deviceId;
    this.sessionId = opts.sessionId;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? (() => {});
    this.workspaces = new WorkspaceManager(opts.workspaces);
    this.verifier = new CommandVerifier(opts.pairing, undefined, {
      ...(opts.maxSkewMs !== undefined ? { maxSkewMs: opts.maxSkewMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });

    const storage = new SessionStorage({
      sessionId: opts.sessionId,
      journal: opts.journal,
      ...(opts.maxReplayEvents !== undefined ? { maxReplayEvents: opts.maxReplayEvents } : {}),
      ...(opts.maxToolStreamBytes !== undefined ? { maxToolStreamBytes: opts.maxToolStreamBytes } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });

    this.session = new Session({
      sessionId: opts.sessionId,
      workspace: this.workspaces.active(),
      engine: opts.engine,
      storage,
      deliver: (out) => this.emit(out),
      ...(opts.permissionTimeoutMs !== undefined ? { permissionTimeoutMs: opts.permissionTimeoutMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });

    this.resumeCheckpoint = opts.resumeCheckpoint;
  }

  private readonly resumeCheckpoint: string | undefined;

  /**
   * Install (or clear) the outbound transport. DaemonClient sets it when the relay WS connects and
   * clears it on disconnect — the Daemon stays active and keeps buffering to the journal, so a dropped
   * browser re-hydrates via `resume` instead of the daemon stalling (invariant #3).
   */
  setTransport(transmit: ((raw: string) => void) | undefined): void {
    this.transmit = transmit;
  }

  /** Connect the engine + rebuild session state (recovers a dirty exit → UI unlock). */
  async start(): Promise<void> {
    await this.session.start(this.resumeCheckpoint);
  }

  /** Handle one raw inbound frame from the relay. Never throws to the caller. */
  async handleInbound(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("warn", "dropping non-JSON inbound frame");
      return;
    }

    // Bare protocol frame (handshake): has a `type` but no `payload`.
    if (isConnHello(parsed)) {
      this.handleHello(parsed);
      return;
    }

    if (isTransportEnvelope(parsed)) {
      await this.route(parsed);
      return;
    }

    this.log("warn", "dropping unrecognized inbound frame");
  }

  async dispose(): Promise<void> {
    await this.session.dispose();
  }

  /** Verification stats — for ops and the rejection tests. */
  stats(): { rejected: number; lastReject?: string } {
    return { rejected: this.rejected, ...(this.lastReject ? { lastReject: this.lastReject } : {}) };
  }

  // ───────────────────────────── inbound ─────────────────────────────

  private handleHello(hello: ConnHello): void {
    const compatible = isCompatible(hello.protocolVersion, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION);
    const ack: ConnAck = compatible
      ? {
          type: "conn_ack",
          ok: true,
          protocolVersion: negotiateVersion(PROTOCOL_VERSION, hello.protocolVersion),
          capabilities: negotiateCapabilities(hello.capabilities, DAEMON_CAPABILITIES),
        }
      : {
          type: "conn_ack",
          ok: false,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [],
          reason: `incompatible protocol ${hello.protocolVersion}`,
        };
    // Echo the target clientInstanceId so the right browser applies this ack (relay broadcasts).
    this.sendRaw({ ...ack, clientInstanceId: hello.clientInstanceId ?? "" });
    this.log("info", "handshake", { ok: ack.ok, client: hello.clientInstanceId });
  }

  private async route(env: TransportEnvelope): Promise<void> {
    const outcome = await this.verifier.verify(env);
    if (!outcome.ok) {
      this.reject(env, outcome.reason);
      return;
    }
    if (outcome.sessionId !== this.sessionId) {
      this.reject(env, "wrong_session");
      return;
    }
    await this.session.handleCommand(outcome.command, outcome.clientInstanceId);
  }

  private reject(env: TransportEnvelope, reason: VerifyReason | "wrong_session"): void {
    this.rejected++;
    this.lastReject = reason;
    this.log("warn", "rejected command", { reason, seq: env.seq });
    // Reflect an out-of-band error to the claimed sender (seq 0: not part of the ordered log).
    const target = typeof env.clientInstanceId === "string" ? env.clientInstanceId : "*";
    this.emit({
      seq: 0,
      to: target,
      event: { type: "error", code: "rejected_command", message: `command rejected: ${reason}` },
    });
  }

  // ───────────────────────────── outbound ─────────────────────────────

  /** Frame a Session OutgoingEvent as an unsigned envelope addressed to `out.to` and transmit it. */
  private emit(out: OutgoingEvent): void {
    const env = newEnvelope<ApplicationEvent>({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      clientInstanceId: out.to, // ADDRESSEE for daemon→browser frames
      seq: out.seq,
      timestamp: this.now(),
      payload: out.event,
    });
    this.sendRaw(env);
  }

  private sendRaw(frame: unknown): void {
    if (!this.transmit) {
      this.log("debug", "no transport installed; dropping outbound frame");
      return;
    }
    this.transmit(JSON.stringify(frame));
  }
}

/** A bare ConnHello frame: `type === "conn_hello"` and (unlike an envelope) it has no `payload`. */
function isConnHello(value: unknown): value is ConnHello {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["type"] === "conn_hello" && v["payload"] === undefined;
}
