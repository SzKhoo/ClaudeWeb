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

import { hostname, platform } from "node:os";
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
import {
  CommandVerifier,
  type PairingKeyStore,
  type VerifyReason,
} from "./security/CommandVerifier.js";
import {
  EnrollmentManager,
  type EnrollmentManagerOptions,
} from "./security/EnrollmentManager.js";
import { isEnrollRequest } from "@wcc/shared";
import { Session, type OutgoingEvent } from "./session/Session.js";
import { SessionManager } from "./session/SessionManager.js";
import { Summarizer } from "./session/Summarizer.js";
import { IdleSweeper } from "./session/IdleSweeper.js";
import { StubSummarizerEngine } from "./session/StubSummarizerEngine.js";
import { SessionIndex } from "./storage/SessionIndex.js";
import { WorkspaceManager, type WorkspaceConfig } from "./workspace/workspace.js";
import type {
  ApplicationCommand,
  CmdDeleteSession,
  CmdGetSessionJournal,
  CmdOpenSession,
  CmdRenameSession,
  IAgentEngine,
  SessionMetaSummary,
} from "@wcc/shared";

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
  /** Wire-protocol routing id (TransportEnvelope.sessionId) — NOT the SessionManager's active session. */
  sessionId: string;
  workspaces: WorkspaceConfig[];
  engine: IAgentEngine;
  /** Root under which `.wcc/sessions/<id>/` folders live; SessionManager owns per-session storage. */
  workspaceRoot: string;
  pairing: PairingKeyStore;
  /** Optional: enable Phase-1 dynamic browser-key enrollment via pre-session pairing frames. */
  enrollment?: EnrollmentManagerOptions;
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
  private session!: Session;
  private readonly sessionIndex: SessionIndex;
  private readonly sessionManager: SessionManager;
  private readonly summarizer: Summarizer;
  private readonly idleSweeper: IdleSweeper;
  private readonly enrollment?: EnrollmentManager;
  private readonly now: () => number;
  private readonly log: DaemonLogger;

  /** Retained for rebindSession() — the engine instance and permission timeout never change on switch. */
  private readonly engine: IAgentEngine;
  private readonly permissionTimeoutMs: number | undefined;

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

    this.engine = opts.engine;
    this.permissionTimeoutMs = opts.permissionTimeoutMs;

    this.sessionIndex = new SessionIndex({
      workspaceRoot: opts.workspaceRoot,
      onChange: () => this.broadcastSessionsList(),
    });
    this.summarizer = new Summarizer({
      workspaceRoot: opts.workspaceRoot,
      engine: new StubSummarizerEngine(),
      now: this.now,
      log: (l, m, meta) => this.log(l, m, meta),
    });
    this.sessionManager = new SessionManager({
      workspaceRoot: opts.workspaceRoot,
      index: this.sessionIndex,
      now: this.now,
      summarize: (id) =>
        this.summarizer.run(id).catch((e) => this.log("warn", "summarizer error", { id, err: String(e) })),
      ...(opts.maxReplayEvents !== undefined ? { maxReplayEvents: opts.maxReplayEvents } : {}),
      ...(opts.maxToolStreamBytes !== undefined ? { maxToolStreamBytes: opts.maxToolStreamBytes } : {}),
    });
    this.idleSweeper = new IdleSweeper({
      manager: this.sessionManager,
      now: this.now,
      onRoll: () => this.onActiveSessionRolled(),
    });

    this.resumeCheckpoint = opts.resumeCheckpoint;

    if (opts.enrollment) {
      this.enrollment = new EnrollmentManager({
        ...opts.enrollment,
        deviceId: this.deviceId,
        ...(opts.now ? { now: opts.now } : {}),
        logger: this.log,
      });
    }
  }

  /** The enrollment manager (when configured). Exposed so the CLI can mint pairing codes. */
  enroll(): EnrollmentManager | undefined {
    return this.enrollment;
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

  /**
   * Bring up the session-management stack: run legacy-session migration, load/mint the active
   * session, start the fs-watch index, start the idle sweeper, then bind `this.session` to the
   * active session's storage. Must run before `start()` calls `session.start`.
   */
  async initialize(): Promise<void> {
    await this.sessionManager.initialize();
    await this.sessionIndex.start();
    this.idleSweeper.start();
    this.rebindSession();
  }

  /** Connect the engine + rebuild session state (recovers a dirty exit → UI unlock). */
  async start(): Promise<void> {
    await this.initialize();
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

    // Phase 1: pre-session pairing frame. Routed to the enrollment manager (if enabled).
    if (isEnrollRequest(parsed)) {
      if (!this.enrollment) {
        this.log("warn", "enroll_request received but enrollment is disabled");
        return;
      }
      const ack = await this.enrollment.handle(parsed);
      this.sendRaw(ack);
      return;
    }

    if (isTransportEnvelope(parsed)) {
      await this.route(parsed);
      return;
    }

    this.log("warn", "dropping unrecognized inbound frame");
  }

  async dispose(): Promise<void> {
    this.idleSweeper.stop();
    this.sessionIndex.stop();
    await this.session.dispose();
    await this.sessionManager.dispose();
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
    if (ack.ok) {
      // Publish machine identity so the browser sidebar can show which PC it's driving.
      this.emit({
        seq: 0,
        to: hello.clientInstanceId ?? "*",
        event: {
          type: "machine_state",
          machine: { online: true, lastSeen: this.now(), hostname: hostname(), platform: platform() },
        },
      });
    }
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
    await this.dispatch(outcome.command, outcome.clientInstanceId);
  }

  /**
   * Session-sidebar commands are intercepted HERE, before Session.handleCommand, because they change
   * WHICH Session is active — Session itself never reassigns `this.session` on the Daemon.
   */
  private async dispatch(command: ApplicationCommand, clientInstanceId: string): Promise<void> {
    switch (command.type) {
      case "list_sessions":
        this.replyList(clientInstanceId);
        return;
      case "get_session_journal":
        await this.replyJournal(clientInstanceId, command);
        return;
      case "new_session":
        await this.handleNewSession();
        return;
      case "open_session":
        await this.handleOpenSession(clientInstanceId, command);
        return;
      case "delete_session":
        await this.handleDeleteSession(clientInstanceId, command);
        return;
      case "rename_session":
        await this.handleRenameSession(command);
        return;
      default:
        await this.session.handleCommand(command, clientInstanceId);
    }
  }

  // ───────────────────────────── session-sidebar commands ─────────────────────────────

  private replyList(clientInstanceId: string): void {
    this.emit({
      seq: 0,
      to: clientInstanceId,
      event: { type: "sessions_list", sessions: this.sessionManager.list() },
    });
  }

  private async replyJournal(clientInstanceId: string, cmd: CmdGetSessionJournal): Promise<void> {
    const { events, nextCursor } = await this.sessionManager.readJournal(
      cmd.sessionId,
      cmd.cursor,
      cmd.limit,
    );
    this.emit({
      seq: 0,
      to: clientInstanceId,
      event: {
        type: "session_journal",
        sessionId: cmd.sessionId,
        events,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      },
    });
  }

  private async handleNewSession(): Promise<void> {
    const { id } = await this.sessionManager.newSession();
    this.rebindSession();
    this.emit({ seq: 0, to: "*", event: { type: "session_switched", sessionId: id, meta: this.metaFor(id) } });
    this.broadcastSessionsList();
  }

  /** IdleSweeper callback: the session was auto-rolled, so rebind and broadcast like handleNewSession. */
  private onActiveSessionRolled(): void {
    this.rebindSession();
    const id = this.sessionManager.getActiveId();
    this.emit({ seq: 0, to: "*", event: { type: "session_switched", sessionId: id, meta: this.metaFor(id) } });
    this.broadcastSessionsList();
  }

  private async handleOpenSession(clientInstanceId: string, cmd: CmdOpenSession): Promise<void> {
    if (!cmd.resume) {
      // Read-only viewing: just serve the journal, no active-session change.
      await this.replyJournal(clientInstanceId, { type: "get_session_journal", sessionId: cmd.sessionId });
      return;
    }
    const result = await this.sessionManager.openSession({ id: cmd.sessionId, resume: true });
    if (!result) {
      this.emit({
        seq: 0,
        to: clientInstanceId,
        event: { type: "error", code: "session_not_found", message: cmd.sessionId },
      });
      return;
    }
    this.rebindSession();
    // TODO(session-switch): setPendingResumeContext primes a one-shot system-prompt extension consumed
    // on the NEXT engine send(). The engine instance is reused across the switch (see rebindSession),
    // so its underlying conversation state (e.g. ClaudeAgentEngine's live SDK session) still reflects
    // the PREVIOUS session until then. A follow-up may need to reconnect/re-`connect()` the engine on
    // session switch so its conversation state matches the newly active session from turn one.
    if (result.resumeContext) this.session.setPendingResumeContext(result.resumeContext);
    this.emit({
      seq: 0,
      to: "*",
      event: { type: "session_switched", sessionId: cmd.sessionId, meta: this.metaFor(cmd.sessionId) },
    });
    this.broadcastSessionsList();
  }

  private async handleDeleteSession(clientInstanceId: string, cmd: CmdDeleteSession): Promise<void> {
    const ok = await this.sessionManager.deleteSession(cmd.sessionId);
    if (!ok) {
      this.emit({
        seq: 0,
        to: clientInstanceId,
        event: { type: "error", code: "session_delete_refused", message: cmd.sessionId },
      });
      return;
    }
    this.emit({ seq: 0, to: "*", event: { type: "session_deleted", sessionId: cmd.sessionId } });
    this.broadcastSessionsList();
  }

  private async handleRenameSession(cmd: CmdRenameSession): Promise<void> {
    const ok = await this.sessionManager.renameSession(cmd.sessionId, cmd.title);
    if (!ok) return;
    this.emit({
      seq: 0,
      to: "*",
      event: { type: "session_renamed", sessionId: cmd.sessionId, title: cmd.title },
    });
    this.broadcastSessionsList();
  }

  /** Replace `this.session` with a fresh Session bound to the (now-active) SessionManager storage. */
  private rebindSession(): void {
    this.session = new Session({
      sessionId: this.sessionManager.getActiveId(),
      workspace: this.workspaces.active(),
      engine: this.engine,
      storage: this.sessionManager.getStorage(),
      deliver: (out) => this.emit(out),
      ...(this.permissionTimeoutMs !== undefined ? { permissionTimeoutMs: this.permissionTimeoutMs } : {}),
      now: this.now,
    });
  }

  private metaFor(id: string): SessionMetaSummary {
    return (
      this.sessionManager.list().find((s) => s.id === id) ?? {
        id,
        title: null,
        lastActivityAt: this.now(),
        status: "active",
      }
    );
  }

  private broadcastSessionsList(): void {
    this.emit({ seq: 0, to: "*", event: { type: "sessions_list", sessions: this.sessionManager.list() } });
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
