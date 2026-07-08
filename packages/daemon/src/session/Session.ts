/**
 * Session — the turn orchestrator (invariant #3). One Session owns one IAgentEngine + one
 * SessionStorage and never calls up the tree (Daemon → WorkspaceManager → Workspace → Session).
 *
 * Responsibilities:
 *   - translate verified ApplicationCommands into engine actions (handleCommand),
 *   - translate engine events/permission-requests into ApplicationEvents (push),
 *   - assign/serve the global session seq via SessionStorage (broadcast to "*", backfill to a client),
 *   - enforce the permission round-trip with a timeout → default-deny,
 *   - on (re)start, detect a dirty exit (turn left open) and unlock the UI with an error.
 *
 * It is transport-agnostic: it emits OutgoingEvents through a `deliver` callback; the Daemon wraps
 * them in signed-free TransportEnvelopes and hands them to the relay. The relay/web never reach in.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize, relative } from "node:path";
import JSZip from "jszip";
import type {
  ApplicationCommand,
  ApplicationEvent,
  Attachment,
  DiffPreview,
  EffortLevel,
  EngineEvent,
  EnginePermissionRequest,
  EvtFileData,
  ExecutionMode,
  IAgentEngine,
  PermissionDecision,
  PermissionScope,
  SessionState,
  TurnStatus,
} from "@wcc/shared";
import type { Workspace } from "../workspace/workspace.js";
import type { SessionStorage } from "../storage/SessionStorage.js";

/** Broadcast target: deliver to every browser attached to this device. */
export const BROADCAST = "*";

/** An event ready for the wire, addressed either to everyone (BROADCAST) or one clientInstanceId. */
export interface OutgoingEvent {
  /** Global session seq the browser orders/dedups the transcript by. */
  seq: number;
  event: ApplicationEvent;
  /** "*" for broadcast, or a specific clientInstanceId for targeted resume backfill. */
  to: string;
}

export type DeliverFn = (out: OutgoingEvent) => void;

export interface SessionOptions {
  sessionId: string;
  workspace: Workspace;
  engine: IAgentEngine;
  storage: SessionStorage;
  deliver: DeliverFn;
  /** ms before an unanswered permission_request defaults to deny. Default 5 min. */
  permissionTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  timer: NodeJS.Timeout;
}

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

/** Max raw bytes returned for a file_request. base64 inflates ~1.33x; kept well under the relay's 16MB frame cap. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class Session {
  readonly sessionId: string;
  private readonly workspace: Workspace;
  private readonly engine: IAgentEngine;
  private readonly storage: SessionStorage;
  private readonly deliver: DeliverFn;
  private readonly permissionTimeoutMs: number;
  private readonly now: () => number;

  private state: SessionState = "idle";
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private currentTurnId: string | undefined;
  /** One-shot system-prompt extension for the NEXT engine send() only (set after a session resume). */
  private pendingResumeContext: string | null = null;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId;
    this.workspace = opts.workspace;
    this.engine = opts.engine;
    this.storage = opts.storage;
    this.deliver = opts.deliver;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;

    // Wire engine streams BEFORE connect so no event is missed.
    this.unsubscribers.push(this.engine.onEvent((e) => this.onEngineEvent(e)));
    this.unsubscribers.push(this.engine.onPermissionRequest((r) => this.onEnginePermission(r)));
  }

  /**
   * Connect the engine, rebuild storage from the journal, and recover any dirty turn (a turn left
   * open by a crash) so the UI unlocks with an error instead of hanging.
   */
  async start(resumeCheckpoint?: string): Promise<void> {
    await this.engine.connect({
      workspaceRoot: this.workspace.root,
      ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
    });
    const { dirtyTurns } = await this.storage.load();
    if (dirtyTurns.length > 0) this.recoverDirtyTurns(dirtyTurns);
    this.setState("idle");
  }

  /** Handle one verified command from a specific client. */
  async handleCommand(command: ApplicationCommand, clientInstanceId: string): Promise<void> {
    switch (command.type) {
      case "user_message":
        await this.startTurn(command.text, command.attachments);
        return;
      case "file_request":
        await this.serveFileRequest(clientInstanceId, command.requestId, command.path);
        return;
      case "bundle_request":
        await this.serveBundleRequest(clientInstanceId, command.requestId, command.paths);
        return;
      case "permission_response":
        await this.resolvePermission(command.requestId, command.decision, command.scope);
        return;
      case "policy_update":
        this.workspace.policy.update({
          ...(command.executionMode ? { executionMode: command.executionMode } : {}),
          ...(command.allowTools ? { allowTools: command.allowTools } : {}),
        });
        this.pushStatus();
        return;
      case "session_config":
        await this.engine.configure({
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.effort !== undefined ? { effort: command.effort } : {}),
        });
        if (command.model !== undefined) this.model = command.model;
        if (command.effort !== undefined) this.effort = command.effort;
        this.pushStatus();
        return;
      case "interrupt":
        await this.engine.interrupt();
        return;
      case "resume":
        this.backfill(clientInstanceId, command.sinceSeq, command.toolStreamOffsets);
        return;
      case "session_control":
        if (command.action === "end") this.endSession("client requested end");
        return;
      case "switch_workspace":
        // Workspace switching is a Daemon-level permission; the Session is a no-op here.
        return;
      case "ack":
        // Transport bookkeeping; nothing to do at the session level.
        return;
    }
  }

  /** Current session state (for the Daemon / tests). */
  getState(): SessionState {
    return this.state;
  }

  /**
   * Stash a one-shot system-prompt extension to be injected on the VERY NEXT engine send() (and only
   * that one). Used after a session resume, once SessionManager hands back the prior transcript summary.
   */
  setPendingResumeContext(text: string): void {
    this.pendingResumeContext = text;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubscribers.splice(0)) u();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await this.engine.dispose();
  }

  // ───────────────────────────── turns ─────────────────────────────

  private async startTurn(text: string, attachments?: Attachment[]): Promise<void> {
    if (this.currentTurnId) {
      this.pushSystem("warn", "A turn is already running; ignoring the new message.");
      return;
    }
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    this.storage.turnStart(turnId);
    this.setState("thinking");
    const resumeContext = this.pendingResumeContext;
    this.pendingResumeContext = null;
    try {
      await this.engine.send(text, attachments, resumeContext ?? undefined);
    } catch (err) {
      this.completeTurn("error", String(err));
    }
  }

  private completeTurn(status: TurnStatus, message?: string): void {
    const turnId = this.currentTurnId;
    if (turnId) this.storage.turnEnd(turnId, status);
    this.currentTurnId = undefined;
    this.push({ type: "turn_complete", status, ...(message ? { message } : {}) });
    this.setState("idle");
  }

  private recoverDirtyTurns(turnIds: string[]): void {
    for (const turnId of turnIds) {
      this.storage.turnEnd(turnId, "error");
      this.pushSystem("warn", "The daemon restarted mid-turn; the previous turn was aborted.");
      this.push({ type: "turn_complete", status: "error", message: "daemon restarted mid-turn" });
    }
    this.currentTurnId = undefined;
  }

  // ───────────────────────────── permissions ─────────────────────────────

  private onEnginePermission(req: EnginePermissionRequest): void {
    const outcome = this.workspace.policy.decide(req.toolName);
    if (outcome === "auto-approve") {
      this.pushSystem("info", `Auto-approved ${req.toolName} (policy).`);
      void this.engine.approveTool(req.requestId);
      return;
    }

    const expiresAt = this.now() + this.permissionTimeoutMs;
    const timer = setTimeout(() => this.timeoutPermission(req.requestId), this.permissionTimeoutMs);
    timer.unref?.();
    this.pending.set(req.requestId, { requestId: req.requestId, toolName: req.toolName, timer });
    this.setState("awaiting-approval");
    this.push({
      type: "permission_request",
      requestId: req.requestId,
      toolName: req.toolName,
      input: req.input,
      ...(diffFromRequest(req) ? { diff: diffFromRequest(req)! } : {}),
      expiresAt,
    });
  }

  private async resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    scope?: PermissionScope,
  ): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      // Unknown/stale/forged requestId — never touch the engine on it.
      this.pushSystem("warn", `Ignored a permission response for unknown request ${requestId}.`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    if (decision === "approve") {
      if (scope === "session") this.workspace.policy.allowForSession(pending.toolName);
      await this.engine.approveTool(requestId, scope);
    } else {
      await this.engine.denyTool(requestId);
    }
    // The engine will emit tool_use/tool_result (or skip); state follows those events.
  }

  private timeoutPermission(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    this.pushSystem("warn", `Permission for ${pending.toolName} timed out; default-deny.`);
    void this.engine.denyTool(requestId);
  }

  // ───────────────────────────── engine events ─────────────────────────────

  private onEngineEvent(e: EngineEvent): void {
    switch (e.type) {
      case "assistant_delta":
        this.push({ type: "assistant_delta", text: e.text });
        return;
      case "assistant_message":
        this.push({ type: "assistant_message", text: e.text });
        return;
      case "tool_use":
        this.setState("tool-running");
        this.push({ type: "tool_use", toolId: e.toolId, name: e.name, input: e.input });
        return;
      case "tool_stream":
        // offset 0 is a placeholder; SessionStorage stamps the real cumulative offset on append.
        this.push({
          type: "tool_stream",
          toolId: e.toolId,
          offset: 0,
          chunk: e.chunk,
          ...(e.stream ? { stream: e.stream } : {}),
        });
        return;
      case "tool_result":
        this.push({
          type: "tool_result",
          toolId: e.toolId,
          ok: e.ok,
          ...(e.summary !== undefined ? { summary: e.summary } : {}),
        });
        return;
      case "error":
        this.push({ type: "error", code: e.code, message: e.message });
        return;
      case "turn_complete":
        this.completeTurn(e.status, e.message);
        return;
    }
  }

  // ───────────────────────────── resume / backfill ─────────────────────────────

  /**
   * Request-driven backfill for one reconnecting client: replay events after `sinceSeq`, recover
   * console chunks the client missed for tools whose events were evicted from the replay window, then
   * send a current session_status snapshot — all targeted to that client (invariant #3).
   */
  private backfill(
    clientInstanceId: string,
    sinceSeq: number,
    toolStreamOffsets?: Record<string, number>,
  ): void {
    const events = this.storage.eventsSince(sinceSeq);
    const toolIdsInBackfill = new Set<string>();
    for (const stored of events) {
      if (stored.event.type === "tool_stream") toolIdsInBackfill.add(stored.event.toolId);
      this.deliver({ seq: stored.seq, event: stored.event, to: clientInstanceId });
    }

    // Eviction recovery: for tools NOT covered by the backfilled events, splice in missed stdout.
    if (toolStreamOffsets) {
      for (const [toolId, offset] of Object.entries(toolStreamOffsets)) {
        if (toolIdsInBackfill.has(toolId)) continue;
        const chunk = this.storage.toolStreamSince(toolId, offset);
        if (!chunk) continue;
        this.deliver({
          seq: this.storage.currentSeq(),
          event: { type: "tool_stream", toolId, offset: chunk.offset, chunk: chunk.chunk },
          to: clientInstanceId,
        });
      }
    }

    // Snapshot of live state (idempotent: the client applies latest session_status regardless of seq).
    this.deliver({
      seq: this.storage.currentSeq(),
      event: this.buildStatus(),
      to: clientInstanceId,
    });
  }

  // ───────────────────────────── file download ─────────────────────────────

  /**
   * Read a workspace file and hand its bytes (base64) to one requesting client. Reads are confined to
   * the workspace root (absolute paths + `..` traversal rejected) and capped at MAX_FILE_BYTES. The
   * reply is targeted + out-of-band (seq 0): it is a download side-channel, not part of the transcript.
   */
  private async serveFileRequest(
    clientInstanceId: string,
    requestId: string,
    reqPath: string,
  ): Promise<void> {
    const name = basename(reqPath) || "download";
    const mediaType = guessMediaType(reqPath);
    const reply = (extra: Partial<EvtFileData>): void => {
      this.deliver({
        seq: 0,
        to: clientInstanceId,
        event: { type: "file_data", requestId, path: reqPath, name, mediaType, ...extra },
      });
    };

    const abs = this.safeResolve(reqPath);
    if (!abs) {
      reply({ error: "Path escapes the workspace root." });
      return;
    }
    try {
      const buf = await readFile(abs);
      const truncated = buf.length > MAX_FILE_BYTES;
      const bytes = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
      reply({ data: bytes.toString("base64"), ...(truncated ? { truncated: true } : {}) });
    } catch (err) {
      reply({ error: `Could not read ${reqPath}: ${(err as { code?: string }).code ?? String(err)}` });
    }
  }

  /**
   * Serve a bundle_request: read each workspace-relative path, zip them, and reply with one file_data
   * event carrying `application/zip`. Paths that escape the workspace root or fail to read are skipped;
   * if every path fails, reply with an error. The accumulated raw bytes are capped at MAX_FILE_BYTES —
   * if adding the next file would exceed it, stop and mark `truncated: true`.
   */
  private async serveBundleRequest(
    clientInstanceId: string,
    requestId: string,
    paths: string[],
  ): Promise<void> {
    const name = bundleName(this.now());
    const reply = (extra: Partial<EvtFileData>): void => {
      this.deliver({
        seq: 0,
        to: clientInstanceId,
        event: {
          type: "file_data",
          requestId,
          path: name,
          name,
          mediaType: "application/zip",
          ...extra,
        },
      });
    };

    const zip = new JSZip();
    let accumulated = 0;
    let truncated = false;
    let added = 0;

    for (const p of paths) {
      const abs = this.safeResolve(p);
      if (!abs) continue;
      let buf: Buffer;
      try {
        buf = await readFile(abs);
      } catch {
        continue;
      }
      if (accumulated + buf.length > MAX_FILE_BYTES) {
        truncated = true;
        break;
      }
      zip.file(p, buf);
      accumulated += buf.length;
      added += 1;
    }

    if (added === 0) {
      reply({ error: "No files could be bundled (all paths were invalid or unreadable)." });
      return;
    }

    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    reply({ data: bytes.toString("base64"), ...(truncated ? { truncated: true } : {}) });
  }

  /** Join a workspace-relative path under the root, returning undefined if it escapes or is absolute. */
  private safeResolve(p: string): string | undefined {
    if (!p || isAbsolute(p)) return undefined;
    const abs = normalize(join(this.workspace.root, p));
    const rel = relative(this.workspace.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return abs;
  }

  // ───────────────────────────── session lifecycle ─────────────────────────────

  private endSession(reason: string): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.state = "ended";
    this.push({ type: "session_ended", reason });
  }

  // ───────────────────────────── emit helpers ─────────────────────────────

  /** Append to storage (assigns seq + stamps tool_stream offset) then broadcast to all clients. */
  private push(event: ApplicationEvent): void {
    const stored = this.storage.append(event);
    this.deliver({ seq: stored.seq, event: stored.event, to: BROADCAST });
  }

  private pushSystem(level: "info" | "warn" | "error", text: string): void {
    this.push({ type: "system_message", level, text });
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.pushStatus();
  }

  private pushStatus(): void {
    this.push(this.buildStatus());
  }

  private buildStatus(): ApplicationEvent {
    const mode: ExecutionMode = this.workspace.policy.snapshot().mode;
    return {
      type: "session_status",
      state: this.state,
      workspaceId: this.workspace.workspaceId,
      executionMode: mode,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.effort !== undefined ? { effort: this.effort } : {}),
    };
  }
}

/** A small extension→MIME map for download hints; falls back to a generic binary type. */
const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".css": "text/css",
  ".html": "text/html",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

function guessMediaType(p: string): string {
  return MIME_BY_EXT[extname(p).toLowerCase()] ?? "application/octet-stream";
}

function bundleName(nowMs: number): string {
  const d = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `changes-${hh}${mm}${ss}.zip`;
}

/** Build a DiffPreview from an engine permission request, if it carried a unified diff. */
function diffFromRequest(req: EnginePermissionRequest): DiffPreview | undefined {
  if (!req.diffUnified) return undefined;
  return {
    path: req.diffPath ?? "",
    unified: req.diffUnified,
  };
}
