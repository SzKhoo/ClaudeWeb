/**
 * ClaudeAgentEngine — the real IAgentEngine, backed by the Claude Agent SDK (`query()` in
 * streaming-input mode). Validated by the 0A gate spike (packages/daemon/spike/agent-spike.mjs):
 * streaming input + canUseTool approval → file written, multi-turn, interrupt, and session resume
 * with context preserved. Uses the machine's local Claude Code login — NO ANTHROPIC_API_KEY.
 *
 * The SDK `query` fn is INJECTED (constructor `queryFn`) so unit tests drive a scripted fake and never
 * load the real SDK; production lazily `import()`s `@anthropic-ai/claude-agent-sdk` on first connect,
 * keeping the heavy ESM dependency off the test + typecheck hot path.
 *
 * Mapping to our seam:
 *   - canUseTool  → onPermissionRequest(...)  (requestId = the SDK toolUseID); approve/denyTool resolve it
 *   - stream_event text deltas → assistant_delta;  assistant message text → assistant_message
 *   - assistant tool_use blocks → tool_use;  user tool_result blocks → tool_stream + tool_result
 *   - result → turn_complete (ok | error | interrupted); interrupt() flags the turn so we map correctly
 *   - system/init.session_id → the ConversationCheckpoint (native resume; no raw-transcript re-feed)
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type {
  ConversationCheckpoint,
  EngineConnectOptions,
  EngineEvent,
  EnginePermissionRequest,
  IAgentEngine,
} from "@wcc/shared";

// ── Minimal structural views of the SDK surface (avoids a hard type dep on the SDK) ──
export type SdkPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { toolUseID?: string; signal?: unknown },
) => Promise<SdkPermissionResult>;

/** A live query: async-iterable of SDK messages plus interrupt(). */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<void>;
}

export interface SdkQueryArgs {
  prompt: AsyncIterable<SdkUserMessage>;
  options: Record<string, unknown>;
}
export type SdkQueryFn = (args: SdkQueryArgs) => SdkQuery;

export interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

/** We only read a handful of fields off each message; the rest is opaque. */
export interface SdkMessage {
  type: "system" | "assistant" | "user" | "result" | "stream_event" | string;
  subtype?: string;
  session_id?: string;
  message?: { role?: string; content?: SdkContentBlock[] };
  event?: { type?: string; delta?: { type?: string; text?: string } };
}
export interface SdkContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface ClaudeAgentEngineOptions {
  /** Model id (defaults to the CLI's configured model when unset). */
  model?: string;
  /** Inject the SDK `query` fn (tests). Omit in production → lazy import of the real SDK. */
  queryFn?: SdkQueryFn;
  /** Extra options merged into the SDK query `options` (advanced/testing). */
  extraOptions?: Record<string, unknown>;
  logger?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

type Decision = "approve" | "deny";

export class ClaudeAgentEngine implements IAgentEngine {
  private workspaceRoot = "";
  private checkpoint: ConversationCheckpoint | undefined;
  private readonly eventListeners = new Set<(e: EngineEvent) => void>();
  private readonly permListeners = new Set<(r: EnginePermissionRequest) => void>();
  private readonly pending = new Map<string, (d: Decision) => void>();

  private queryFn: SdkQueryFn | undefined;
  private q: SdkQuery | undefined;
  private channel: InputChannel | undefined;
  private interrupted = false;
  private readonly log: NonNullable<ClaudeAgentEngineOptions["logger"]>;

  constructor(private readonly opts: ClaudeAgentEngineOptions = {}) {
    this.queryFn = opts.queryFn;
    this.log = opts.logger ?? (() => {});
  }

  async connect(options: EngineConnectOptions): Promise<void> {
    this.workspaceRoot = options.workspaceRoot;
    if (options.resumeCheckpoint) this.checkpoint = { checkpointId: options.resumeCheckpoint };
    await this.startQuery(options.resumeCheckpoint);
  }

  private async startQuery(resume?: string): Promise<void> {
    const queryFn = this.queryFn ?? (await this.loadSdkQuery());
    this.channel = new InputChannel();
    const options: Record<string, unknown> = {
      cwd: this.workspaceRoot,
      permissionMode: "default",
      includePartialMessages: true,
      canUseTool: this.makeCanUseTool(),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(resume ? { resume } : {}),
      ...(this.opts.extraOptions ?? {}),
    };
    this.q = queryFn({ prompt: this.channel, options });
    this.interrupted = false;
    void this.consume(this.q);
  }

  private async loadSdkQuery(): Promise<SdkQueryFn> {
    // Lazy import keeps the heavy ESM SDK off the unit-test + typecheck path.
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as { query: SdkQueryFn };
    return mod.query;
  }

  async send(text: string): Promise<void> {
    if (!this.channel) throw new Error("ClaudeAgentEngine: connect() before send()");
    this.interrupted = false;
    this.channel.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  async approveTool(requestId: string): Promise<void> {
    this.pending.get(requestId)?.("approve");
    this.pending.delete(requestId);
  }

  async denyTool(requestId: string): Promise<void> {
    this.pending.get(requestId)?.("deny");
    this.pending.delete(requestId);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    for (const [id, resolve] of this.pending) {
      resolve("deny");
      this.pending.delete(id);
    }
    try {
      await this.q?.interrupt();
    } catch (err) {
      this.log("warn", "interrupt threw", { err: String(err) });
    }
  }

  async resumeConversation(checkpoint: ConversationCheckpoint): Promise<ConversationCheckpoint> {
    this.checkpoint = checkpoint;
    // Re-attach a fresh query bound to the prior session id.
    this.channel?.close();
    await this.startQuery(checkpoint.checkpointId);
    return checkpoint;
  }

  currentCheckpoint(): ConversationCheckpoint | undefined {
    return this.checkpoint;
  }

  onEvent(listener: (e: EngineEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onPermissionRequest(listener: (r: EnginePermissionRequest) => void): () => void {
    this.permListeners.add(listener);
    return () => this.permListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.channel?.close();
    try {
      await this.q?.interrupt();
    } catch {
      /* ignore */
    }
    this.eventListeners.clear();
    this.permListeners.clear();
    this.pending.clear();
    this.q = undefined;
    this.channel = undefined;
  }

  // ── SDK message consumer: map to EngineEvents ──
  private async consume(q: SdkQuery): Promise<void> {
    try {
      for await (const m of q) {
        this.handleMessage(m);
      }
    } catch (err) {
      this.log("warn", "query loop ended", { err: String(err) });
      this.emit({ type: "error", code: "engine_error", message: String(err) });
    }
  }

  private handleMessage(m: SdkMessage): void {
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && m.session_id) {
          this.checkpoint = { checkpointId: m.session_id };
        }
        return;
      case "stream_event": {
        const d = m.event?.delta;
        if (m.event?.type === "content_block_delta" && d?.type === "text_delta" && d.text) {
          this.emit({ type: "assistant_delta", text: d.text });
        }
        return;
      }
      case "assistant": {
        for (const block of m.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            this.emit({ type: "assistant_message", text: block.text });
          } else if (block.type === "tool_use") {
            this.emit({
              type: "tool_use",
              toolId: block.id ?? randomUUID(),
              name: block.name ?? "tool",
              input: block.input ?? {},
            });
          }
        }
        return;
      }
      case "user": {
        // tool_result blocks come back on a synthetic user message
        for (const block of m.message?.content ?? []) {
          if (block.type === "tool_result") {
            const toolId = block.tool_use_id ?? "";
            const text = stringifyToolContent(block.content);
            if (text) this.emit({ type: "tool_stream", toolId, chunk: text.endsWith("\n") ? text : text + "\n" });
            this.emit({
              type: "tool_result",
              toolId,
              ok: block.is_error !== true,
              ...(text ? { summary: text.slice(0, 200) } : {}),
            });
          }
        }
        return;
      }
      case "result": {
        const status: "ok" | "error" | "interrupted" = this.interrupted
          ? "interrupted"
          : m.subtype === "success"
            ? "ok"
            : "error";
        this.emit({
          type: "turn_complete",
          status,
          ...(status !== "ok" && m.subtype ? { message: m.subtype } : {}),
        });
        this.interrupted = false;
        return;
      }
      default:
        return;
    }
  }

  private makeCanUseTool(): SdkCanUseTool {
    return async (toolName, input, o) => {
      const requestId = o.toolUseID ?? randomUUID();
      const decision = await new Promise<Decision>((resolve) => {
        this.pending.set(requestId, resolve);
        const req: EnginePermissionRequest = {
          requestId,
          toolName,
          input,
          ...diffFor(toolName, input, this.workspaceRoot),
        };
        for (const l of this.permListeners) l(req);
      });
      return decision === "approve"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Denied by user" };
    };
  }

  private emit(e: EngineEvent): void {
    for (const l of this.eventListeners) l(e);
  }
}

// ── helpers ──

/** An async-iterable backed by a queue, so we can push turns into a live streaming-input query. */
class InputChannel implements AsyncIterable<SdkUserMessage> {
  private readonly items: SdkUserMessage[] = [];
  private readonly waiters: Array<(r: IteratorResult<SdkUserMessage>) => void> = [];
  private closed = false;

  push(msg: SdkUserMessage): void {
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }
  close(): void {
    this.closed = true;
    const w = this.waiters.shift();
    if (w) w({ value: undefined as unknown as SdkUserMessage, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    for (;;) {
      const queued = this.items.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SdkUserMessage>>((res) => this.waiters.push(res));
      if (next.done) return;
      yield next.value;
    }
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

/** Build an optional diff preview for file-editing tools, with a workspace-relative path. */
function diffFor(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): { diffUnified?: string; diffPath?: string } {
  const rel = (p: unknown): string => {
    if (typeof p !== "string") return "";
    return isAbsolute(p) ? relative(workspaceRoot, p) || p : p;
  };
  if (toolName === "Write" && typeof input["content"] === "string") {
    const path = rel(input["file_path"] ?? input["path"]);
    const lines = String(input["content"]).split("\n");
    const body = lines.map((l) => `+${l}`).join("\n");
    return { diffPath: path, diffUnified: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}` };
  }
  if (toolName === "Edit" && typeof input["old_string"] === "string" && typeof input["new_string"] === "string") {
    const path = rel(input["file_path"] ?? input["path"]);
    const oldLines = String(input["old_string"]).split("\n").map((l) => `-${l}`).join("\n");
    const newLines = String(input["new_string"]).split("\n").map((l) => `+${l}`).join("\n");
    return { diffPath: path, diffUnified: `--- a/${path}\n+++ b/${path}\n@@ @@\n${oldLines}\n${newLines}` };
  }
  return {};
}
