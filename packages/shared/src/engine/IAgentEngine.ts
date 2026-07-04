/**
 * IAgentEngine — the seam between the daemon's Session and the concrete agent runtime.
 *
 * North star (plan): "remote-control app, seams only". The daemon depends on THIS interface, never on
 * a specific SDK. Phase 0 ships a MockEngine for tests + a ClaudeAgentEngine (Claude Agent SDK) once
 * the 0A/0B spikes confirm the exact runtime API. A future Codex/Gemini engine would implement the
 * same interface — no daemon rewrite.
 *
 * CORRECTION #5: `resumeConversation()` here is the ENGINE's native conversation/session resume
 * (re-attach to a prior agent conversation, preserving its compacted context). It is NOT the transport
 * `resume` command (backfilling missed events/stdout to a reconnecting client) — that lives in the
 * protocol layer. Keeping the names distinct prevents the collision the two "resume"s caused.
 */

/** Events the engine emits as a turn progresses. Mirrors the protocol events the Session forwards. */
export type EngineEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_use"; toolId: string; name: string; input: unknown }
  | { type: "tool_stream"; toolId: string; chunk: string; stream?: "stdout" | "stderr" }
  | { type: "tool_result"; toolId: string; ok: boolean; summary?: string }
  | { type: "turn_complete"; status: "ok" | "error" | "interrupted"; message?: string }
  | { type: "error"; code: string; message: string };

/**
 * A tool-permission request surfaced by the engine. The Session turns this into a protocol
 * `permission_request`, awaits a signed `permission_response`, then resolves via approveTool/denyTool.
 */
export interface EnginePermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  /** Optional unified diff for file-editing tools (drives diff-preview-before-approval). */
  diffUnified?: string;
  diffPath?: string;
}

export interface EngineConnectOptions {
  /** Absolute workspace root the engine is permitted to operate in. */
  workspaceRoot: string;
  /** Opaque checkpoint id to resume a prior conversation, if any (see resumeConversation). */
  resumeCheckpoint?: string;
}

/** A handle that, once persisted, lets a later process re-attach via resumeConversation(). */
export interface ConversationCheckpoint {
  checkpointId: string;
}

import type { Attachment, EffortLevel } from "../protocol/messages.js";

/** Runtime-adjustable settings for the conversation (applied to subsequent turns). */
export interface EngineConfig {
  model?: string;
  effort?: EffortLevel;
}

export interface IAgentEngine {
  /** Start (or attach to) an agent runtime for one workspace/session. */
  connect(options: EngineConnectOptions): Promise<void>;

  /**
   * Send a user prompt to begin a turn. Resolves when the turn is accepted (not when it finishes).
   * `attachments` (images/PDF/text) ride along as agent content blocks.
   */
  send(text: string, attachments?: Attachment[]): Promise<void>;

  /** Update the model / reasoning effort applied to subsequent turns. */
  configure(config: EngineConfig): Promise<void>;

  /** Resolve an outstanding permission request as approved. */
  approveTool(requestId: string, scope?: "once" | "session"): Promise<void>;

  /** Resolve an outstanding permission request as denied. */
  denyTool(requestId: string): Promise<void>;

  /** Stop the in-flight turn. Emits a `turn_complete` with status "interrupted". */
  interrupt(): Promise<void>;

  /**
   * ENGINE-NATIVE conversation resume: re-attach to a prior conversation, preserving its compacted
   * context. Returns the checkpoint now in effect. (Distinct from transport stream resume.)
   */
  resumeConversation(checkpoint: ConversationCheckpoint): Promise<ConversationCheckpoint>;

  /** Current resumable checkpoint for the live conversation, if the engine exposes one. */
  currentCheckpoint(): ConversationCheckpoint | undefined;

  /** Subscribe to engine events. Returns an unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void;

  /** Subscribe to permission requests. Returns an unsubscribe function. */
  onPermissionRequest(listener: (req: EnginePermissionRequest) => void): () => void;

  /** Tear down the runtime and release resources. */
  dispose(): Promise<void>;
}
