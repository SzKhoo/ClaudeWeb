/**
 * Application-layer messages (the `payload` of a TransportEnvelope).
 *
 * Two directions:
 *  - Command : browser/client -> daemon. Authorizes or controls. ALL commands are signature-verified
 *              by the daemon (invariant #2 / #4). Events are NEVER signed.
 *  - Event   : daemon -> browser/client. Reports what happened.
 *
 * Layering (invariant #1, #6): the transport envelope is separate from this application message, and
 * `turn_complete` (one prompt/response cycle finished) is distinct from `session_ended`.
 */

// ───────────────────────────── shared value types ─────────────────────────────

/** How aggressively the daemon is allowed to act without per-tool approval. */
export type ExecutionMode =
  | "manual" // every tool requires explicit approval
  | "auto-edits" // file edits auto-approved; Bash/network still require approval
  | "yolo"; // everything auto-approved (never the default; opt-in, audited)

/** Reasoning effort level the model spends per turn (maps to the SDK's `effort` option). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Liveness/health of the machine the daemon runs on. */
export interface MachineState {
  online: boolean;
  /** epoch ms of the daemon's last heartbeat. */
  lastSeen: number;
  hostname?: string;
  platform?: string; // e.g. "win32", "darwin", "linux"
  daemonVersion?: string;
}

/** A directory the daemon is allowed to operate in. */
export interface Workspace {
  workspaceId: string;
  name: string;
  /** Absolute path on the daemon machine (allowlisted root). */
  root: string;
  gitRepo?: boolean;
  defaultBranch?: string;
}

export type SessionState =
  | "idle" // attached, no turn running
  | "thinking" // model is producing a response
  | "tool-running" // a tool is executing
  | "awaiting-approval" // blocked on a permission_request
  | "ended";

export type PermissionDecision = "approve" | "deny";

/** Scope of an approval: just this one call, or all calls of this shape for the session. */
export type PermissionScope = "once" | "session";

/** A unified diff preview attached to a file-editing permission request. */
export interface DiffPreview {
  path: string;
  /** Unified-diff text (may be truncated; `truncated` signals more exists). */
  unified: string;
  truncated?: boolean;
}

/**
 * A file the user attaches to a prompt (image, PDF, text, …). The bytes ride inline as base64 so the
 * whole thing stays one signed command (no side-channel upload). The daemon turns images/PDFs into
 * agent content blocks and inlines text; large files are the caller's responsibility to keep sane.
 */
export interface Attachment {
  /** Original filename, used for display + as a hint to the agent. */
  name: string;
  /** MIME type, e.g. "image/png", "application/pdf", "text/plain". */
  mediaType: string;
  /** base64-encoded file bytes (no data: URL prefix). */
  data: string;
}

// ───────────────────────────── commands (client -> daemon) ─────────────────────────────

export interface CmdUserMessage {
  type: "user_message";
  text: string;
  /** Files the user attached to this prompt (images/PDF/text). Omitted when there are none. */
  attachments?: Attachment[];
}

export interface CmdPermissionResponse {
  type: "permission_response";
  requestId: string;
  decision: PermissionDecision;
  scope?: PermissionScope; // default "once"
}

export interface CmdPolicyUpdate {
  type: "policy_update";
  executionMode?: ExecutionMode;
  /** Tool names to allow for the rest of the session without prompting. */
  allowTools?: string[];
}

export interface CmdSwitchWorkspace {
  type: "switch_workspace";
  workspaceId: string;
}

/** Change the model and/or reasoning effort for subsequent turns. */
export interface CmdSessionConfig {
  type: "session_config";
  /** Model id (e.g. "claude-opus-4-8"). Omit to leave unchanged. */
  model?: string;
  /** Reasoning effort. Omit to leave unchanged. */
  effort?: EffortLevel;
}

/**
 * Ask the daemon to send back the contents of a file in the active workspace (so the phone/browser can
 * download it). The daemon reads it under the workspace root only (traversal + absolute paths rejected)
 * and replies with a targeted `file_data` event carrying the bytes (base64) or an error.
 */
export interface CmdFileRequest {
  type: "file_request";
  /** Correlates the reply `file_data` event back to this request. */
  requestId: string;
  /** Path relative to the active workspace root. Absolute paths / traversal are rejected. */
  path: string;
}

/**
 * Ask the daemon to send back a single zip containing the given workspace files (the "download all
 * files changed this turn" chip in the transcript). Each path is workspace-relative and sandboxed the
 * same way as file_request. The reply reuses `file_data` with `mediaType: "application/zip"`.
 */
export interface CmdBundleRequest {
  type: "bundle_request";
  /** Correlates the reply `file_data` event back to this request. */
  requestId: string;
  /** Workspace-relative paths. Absolute paths / `..` traversal are rejected per-path by the daemon. */
  paths: string[];
}

export interface CmdInterrupt {
  type: "interrupt";
}

export interface CmdSessionControl {
  type: "session_control";
  action: "start" | "end";
  /** For "start": which workspace to start in (defaults to the active one). */
  workspaceId?: string;
}

/**
 * TRANSPORT stream resume (CORRECTION #5: distinct from engine conversation-resume).
 * Asks the daemon to backfill events after `sinceSeq` and tool stdout after the given byte offsets.
 */
export interface CmdResume {
  type: "resume";
  sinceSeq: number;
  /** Per-tool stdout/stderr byte offset already received by this client. */
  toolStreamOffsets?: Record<string, number>;
}

/** Cumulative acknowledgement of received events (transport bookkeeping). */
export interface CmdAck {
  type: "ack";
  /** Highest session event seq this client has durably received. */
  seq: number;
}

export type ApplicationCommand =
  | CmdUserMessage
  | CmdPermissionResponse
  | CmdPolicyUpdate
  | CmdSwitchWorkspace
  | CmdSessionConfig
  | CmdFileRequest
  | CmdBundleRequest
  | CmdInterrupt
  | CmdSessionControl
  | CmdResume
  | CmdAck;

export type CommandType = ApplicationCommand["type"];

// ───────────────────────────── events (daemon -> client) ─────────────────────────────

export interface EvtAssistantDelta {
  type: "assistant_delta";
  /** Incremental text chunk of the in-progress assistant message. */
  text: string;
}

export interface EvtAssistantMessage {
  type: "assistant_message";
  /** Final text of a completed assistant message. */
  text: string;
}

export interface EvtToolUse {
  type: "tool_use";
  toolId: string;
  name: string;
  input: unknown;
}

export interface EvtToolStream {
  type: "tool_stream";
  toolId: string;
  /** Byte offset of `chunk` within this tool's cumulative output stream. */
  offset: number;
  chunk: string;
  stream?: "stdout" | "stderr";
}

export interface EvtToolResult {
  type: "tool_result";
  toolId: string;
  ok: boolean;
  summary?: string;
}

export interface EvtPermissionRequest {
  type: "permission_request";
  requestId: string;
  toolName: string;
  input: unknown;
  diff?: DiffPreview;
  /** epoch ms after which the daemon will default-deny if unanswered. */
  expiresAt?: number;
}

export interface EvtSessionStatus {
  type: "session_status";
  state: SessionState;
  workspaceId?: string;
  executionMode?: ExecutionMode;
  /** Current model id in effect for this session (if set). */
  model?: string;
  /** Current reasoning effort in effect for this session (if set). */
  effort?: EffortLevel;
}

export interface EvtMachineState {
  type: "machine_state";
  machine: MachineState;
  workspaces?: Workspace[];
}

export interface EvtSystemMessage {
  type: "system_message";
  level: "info" | "warn" | "error";
  text: string;
}

export interface EvtError {
  type: "error";
  code: string;
  message: string;
}

export type TurnStatus = "ok" | "error" | "interrupted";

export interface EvtTurnComplete {
  type: "turn_complete";
  status: TurnStatus;
  /** Populated when status != "ok". */
  message?: string;
}

export interface EvtSessionEnded {
  type: "session_ended";
  reason: string;
}

/**
 * Reply to a `file_request`: the bytes of a workspace file (base64) for the browser to download, or an
 * error if it couldn't be read. Delivered targeted to the requesting client, out-of-band (seq 0) — it
 * is not part of the ordered transcript.
 */
export interface EvtFileData {
  type: "file_data";
  /** Echoes the request's requestId. */
  requestId: string;
  /** The workspace-relative path that was requested. */
  path: string;
  /** Basename, used as the download filename. */
  name: string;
  /** Guessed MIME type for the download. */
  mediaType: string;
  /** base64 file bytes; present on success. */
  data?: string;
  /** Human-readable reason; present on failure (then `data` is absent). */
  error?: string;
  /** True if the file exceeded the transfer cap and `data` is a prefix. */
  truncated?: boolean;
}

export type ApplicationEvent =
  | EvtAssistantDelta
  | EvtAssistantMessage
  | EvtToolUse
  | EvtToolStream
  | EvtToolResult
  | EvtPermissionRequest
  | EvtSessionStatus
  | EvtMachineState
  | EvtSystemMessage
  | EvtError
  | EvtTurnComplete
  | EvtSessionEnded
  | EvtFileData;

export type EventType = ApplicationEvent["type"];

// ───────────────────────────── unions + helpers ─────────────────────────────

export type ApplicationMessage = ApplicationCommand | ApplicationEvent;

const COMMAND_TYPES: ReadonlySet<string> = new Set<CommandType>([
  "user_message",
  "permission_response",
  "policy_update",
  "switch_workspace",
  "session_config",
  "file_request",
  "bundle_request",
  "interrupt",
  "session_control",
  "resume",
  "ack",
]);

/** True if `msg` is a client->daemon command (and therefore must be signature-verified). */
export function isCommand(msg: ApplicationMessage): msg is ApplicationCommand {
  return COMMAND_TYPES.has(msg.type);
}

/** True if `msg` is a daemon->client event. */
export function isEvent(msg: ApplicationMessage): msg is ApplicationEvent {
  return !COMMAND_TYPES.has(msg.type);
}

/**
 * Whether a message type requires a verified signature on its envelope.
 * Invariant #2/#4: every command must be signed; events never are.
 */
export function requiresSignature(type: string): boolean {
  return COMMAND_TYPES.has(type);
}
