/**
 * MockEngine — a deterministic IAgentEngine for Phase 0 build + tests.
 *
 * It lets the ENTIRE daemon/relay/web slice be built and tested with no Claude auth. The real
 * ClaudeAgentEngine is slotted in behind the same interface once the 0A/0B spikes confirm the SDK API
 * (needs an authenticated machine). Per plan, all daemon logic depends on IAgentEngine, never an SDK.
 *
 * Behaviour: on send(text), if the text asks to create/write a `*.txt` file it proposes a `Write` tool
 * (permission-gated, with a diff). On approval it ACTUALLY writes the file under the workspace root, so
 * the slice's "file is really created" criterion holds. Otherwise it just echoes an assistant message.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import type {
  Attachment,
  ConversationCheckpoint,
  EngineConfig,
  EngineConnectOptions,
  EngineEvent,
  EnginePermissionRequest,
  IAgentEngine,
} from "@wcc/shared";

type Decision = "approve" | "deny";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class MockEngine implements IAgentEngine {
  private workspaceRoot = "";
  private checkpoint: ConversationCheckpoint | undefined;
  private readonly eventListeners = new Set<(e: EngineEvent) => void>();
  private readonly permListeners = new Set<(r: EnginePermissionRequest) => void>();
  private readonly pending = new Map<string, (d: Decision) => void>();
  private interrupted = false;
  private turnActive = false;
  /** Last model/effort applied via configure() — exposed for assertions and status echo. */
  config: EngineConfig = {};
  /** resumeContext received on the most recent send(), for test assertions. */
  lastResumeContext: string | null = null;

  async configure(config: EngineConfig): Promise<void> {
    this.config = { ...this.config, ...config };
  }

  async connect(options: EngineConnectOptions): Promise<void> {
    this.workspaceRoot = options.workspaceRoot;
    this.checkpoint = options.resumeCheckpoint
      ? { checkpointId: options.resumeCheckpoint }
      : { checkpointId: randomUUID() };
  }

  async send(text: string, attachments?: Attachment[], resumeContext?: string): Promise<void> {
    if (this.turnActive) throw new Error("MockEngine: a turn is already active");
    this.lastResumeContext = resumeContext ?? null;
    this.turnActive = true;
    this.interrupted = false;
    // Run the turn in the background; resolves immediately (turn accepted, not finished).
    void this.runTurn(text, attachments ?? []).finally(() => {
      this.turnActive = false;
    });
  }

  private async runTurn(text: string, attachments: Attachment[]): Promise<void> {
    this.emit({ type: "assistant_delta", text: "Working on it… " });
    await tick();
    if (this.interrupted) return this.finish("interrupted");

    const write = parseWriteIntent(text);
    if (!write) {
      const note = attachments.length > 0 ? ` (received ${attachments.length} attachment(s): ${attachments.map((a) => a.name).join(", ")})` : "";
      this.emit({ type: "assistant_message", text: `You said: ${text}${note}` });
      return this.finish("ok");
    }

    const requestId = randomUUID();
    const decision = await this.requestPermission({
      requestId,
      toolName: "Write",
      input: { path: write.path, content: write.content },
      diffPath: write.path,
      diffUnified: makeDiff(write.path, write.content),
    });
    if (this.interrupted) return this.finish("interrupted");

    const toolId = randomUUID();
    if (decision === "deny") {
      this.emit({ type: "tool_result", toolId, ok: false, summary: "Write denied by user" });
      this.emit({ type: "assistant_message", text: `Skipped creating ${write.path}.` });
      return this.finish("ok");
    }

    // Approved — actually perform the write under the workspace root.
    this.emit({ type: "tool_use", toolId, name: "Write", input: { path: write.path } });
    try {
      const abs = this.safeJoin(write.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, write.content, "utf8");
      const bytes = Buffer.byteLength(write.content, "utf8");
      this.emit({ type: "tool_stream", toolId, chunk: `Wrote ${bytes} bytes to ${write.path}\n` });
      this.emit({ type: "tool_result", toolId, ok: true, summary: `Created ${write.path}` });
      this.emit({ type: "assistant_message", text: `Created ${write.path}.` });
      return this.finish("ok");
    } catch (err) {
      this.emit({ type: "tool_result", toolId, ok: false, summary: String(err) });
      this.emit({ type: "error", code: "write_failed", message: String(err) });
      return this.finish("error", String(err));
    }
  }

  private requestPermission(req: EnginePermissionRequest): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      this.pending.set(req.requestId, resolve);
      for (const l of this.permListeners) l(req);
    });
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
    // Resolve any outstanding permission as a deny so the turn can unwind.
    for (const [id, resolve] of this.pending) {
      resolve("deny");
      this.pending.delete(id);
    }
  }

  async resumeConversation(checkpoint: ConversationCheckpoint): Promise<ConversationCheckpoint> {
    this.checkpoint = checkpoint;
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
    this.eventListeners.clear();
    this.permListeners.clear();
    this.pending.clear();
  }

  // ── helpers ──
  private emit(e: EngineEvent): void {
    for (const l of this.eventListeners) l(e);
  }

  private finish(status: "ok" | "error" | "interrupted", message?: string): void {
    this.emit({ type: "turn_complete", status, ...(message ? { message } : {}) });
  }

  /** Join a relative path under the workspace root, rejecting traversal outside it. */
  private safeJoin(p: string): string {
    if (isAbsolute(p)) throw new Error(`absolute paths not allowed: ${p}`);
    const abs = normalize(join(this.workspaceRoot, p));
    const rel = relative(this.workspaceRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes workspace: ${p}`);
    return abs;
  }
}

function parseWriteIntent(text: string): { path: string; content: string } | undefined {
  // Matches: create/write <file>.txt [with content "..."]
  const m = /(?:create|write|make)\s+(?:a\s+file\s+)?(?:called\s+)?([\w./-]+\.txt)/i.exec(text);
  if (!m) return undefined;
  const path = m[1]!;
  const cm = /(?:content|saying|with)\s+["']([^"']*)["']/i.exec(text);
  const content = cm ? cm[1]! : `Hello from WebClaudeCode!\n`;
  return { path, content };
}

function makeDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const body = lines.map((l) => `+${l}`).join("\n");
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
}
