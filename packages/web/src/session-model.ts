/**
 * SessionModel — a pure reducer that folds the daemon's ApplicationEvents into a renderable transcript
 * view. No DOM, no React, no network: it is imported by the React UI AND by the node e2e test, so it
 * must stay environment-agnostic (type-checked under both DOM and NodeNext).
 *
 * The Connection guarantees events arrive in seq order with no duplicates, so the model just folds.
 */

import type {
  ApplicationEvent,
  DiffPreview,
  EffortLevel,
  ExecutionMode,
  MachineState,
  SessionState,
} from "@wcc/shared";

const EDIT_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function extractToolPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const p = rec["file_path"] ?? rec["path"] ?? rec["notebook_path"];
  return typeof p === "string" ? p : undefined;
}

/** Lightweight attachment descriptor shown on a user bubble (no bytes — just name + type). */
export interface AttachmentMeta {
  name: string;
  mediaType: string;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; attachments?: AttachmentMeta[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      toolId: string;
      name: string;
      input: unknown;
      output: string;
      result?: { ok: boolean; summary?: string };
    }
  | { kind: "system"; id: string; level: "info" | "warn" | "error"; text: string }
  | { kind: "error"; id: string; code: string; message: string }
  | { kind: "bundle"; id: string; paths: string[] };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  diff?: DiffPreview;
  expiresAt?: number;
}

export interface SessionView {
  items: TranscriptItem[];
  pending?: PendingPermission;
  state: SessionState;
  executionMode?: ExecutionMode;
  model?: string;
  effort?: EffortLevel;
  workspaceId?: string;
  machine?: MachineState;
  ended?: { reason: string };
}

export class SessionModel {
  private items: TranscriptItem[] = [];
  private pending: PendingPermission | undefined;
  private state: SessionState = "idle";
  private executionMode: ExecutionMode | undefined;
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private workspaceId: string | undefined;
  private machine: MachineState | undefined;
  private ended: { reason: string } | undefined;
  private liveAssistantId: string | undefined;
  private counter = 0;
  private readonly pendingEdits = new Map<string, string>(); // toolId -> path (Write/Edit family only)
  private readonly changedThisTurn = new Set<string>();      // dedupes; iteration order = insertion

  /** Record a locally-sent user message so it shows immediately (it isn't echoed back as an event). */
  addLocalUserMessage(text: string, attachments?: AttachmentMeta[]): void {
    this.pendingEdits.clear();
    this.changedThisTurn.clear();
    this.items.push({
      kind: "user",
      id: this.nextId("u"),
      text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    // A new turn supersedes any finished streaming bubble.
    this.liveAssistantId = undefined;
  }

  apply(event: ApplicationEvent): void {
    switch (event.type) {
      case "assistant_delta":
        this.appendDelta(event.text);
        return;
      case "assistant_message":
        this.finalizeAssistant(event.text);
        return;
      case "tool_use":
        this.closeLiveAssistant();
        this.items.push({
          kind: "tool",
          id: this.nextId("t"),
          toolId: event.toolId,
          name: event.name,
          input: event.input,
          output: "",
        });
        if (EDIT_TOOL_NAMES.has(event.name)) {
          const p = extractToolPath(event.input);
          if (p) this.pendingEdits.set(event.toolId, p);
        }
        return;
      case "tool_stream": {
        const card = this.findTool(event.toolId);
        if (card) card.output += event.chunk;
        return;
      }
      case "tool_result": {
        const card = this.findTool(event.toolId);
        if (card) card.result = { ok: event.ok, ...(event.summary !== undefined ? { summary: event.summary } : {}) };
        const editPath = this.pendingEdits.get(event.toolId);
        if (editPath !== undefined) {
          this.pendingEdits.delete(event.toolId);
          if (event.ok) this.changedThisTurn.add(editPath);
        }
        return;
      }
      case "permission_request":
        this.pending = {
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          ...(event.diff ? { diff: event.diff } : {}),
          ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
        };
        return;
      case "session_status":
        this.state = event.state;
        if (event.executionMode !== undefined) this.executionMode = event.executionMode;
        if (event.model !== undefined) this.model = event.model;
        if (event.effort !== undefined) this.effort = event.effort;
        if (event.workspaceId !== undefined) this.workspaceId = event.workspaceId;
        if (event.state !== "awaiting-approval") this.pending = undefined;
        return;
      case "turn_complete":
        this.closeLiveAssistant();
        this.pending = undefined;
        if (event.status === "ok" && this.changedThisTurn.size > 0) {
          this.items.push({
            kind: "bundle",
            id: this.nextId("b"),
            paths: Array.from(this.changedThisTurn),
          });
        }
        this.pendingEdits.clear();
        this.changedThisTurn.clear();
        if (event.status !== "ok") {
          this.items.push({
            kind: "system",
            id: this.nextId("s"),
            level: event.status === "error" ? "error" : "warn",
            text: `Turn ${event.status}${event.message ? `: ${event.message}` : ""}`,
          });
        }
        return;
      case "system_message":
        this.items.push({ kind: "system", id: this.nextId("s"), level: event.level, text: event.text });
        return;
      case "error":
        this.items.push({ kind: "error", id: this.nextId("e"), code: event.code, message: event.message });
        return;
      case "session_ended":
        this.ended = { reason: event.reason };
        this.state = "ended";
        return;
      case "machine_state":
        // Merge into the current snapshot so the sidebar can show hostname/platform/online-ness.
        this.machine = { ...(this.machine ?? { online: false, lastSeen: 0 }), ...event.machine };
        return;
    }
  }

  /** Clear the pending prompt optimistically (the UI calls this right after the user answers). */
  clearPending(): void {
    this.pending = undefined;
  }

  view(): SessionView {
    return {
      items: [...this.items],
      ...(this.pending ? { pending: this.pending } : {}),
      state: this.state,
      ...(this.executionMode !== undefined ? { executionMode: this.executionMode } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.effort !== undefined ? { effort: this.effort } : {}),
      ...(this.workspaceId !== undefined ? { workspaceId: this.workspaceId } : {}),
      ...(this.machine ? { machine: this.machine } : {}),
      ...(this.ended ? { ended: this.ended } : {}),
    };
  }

  // ── internals ──

  private appendDelta(text: string): void {
    const live = this.liveAssistantId ? this.findAssistant(this.liveAssistantId) : undefined;
    if (live) {
      live.text += text;
    } else {
      const id = this.nextId("a");
      this.items.push({ kind: "assistant", id, text, streaming: true });
      this.liveAssistantId = id;
    }
  }

  private finalizeAssistant(text: string): void {
    const live = this.liveAssistantId ? this.findAssistant(this.liveAssistantId) : undefined;
    if (live) {
      live.text = text;
      live.streaming = false;
    } else {
      this.items.push({ kind: "assistant", id: this.nextId("a"), text, streaming: false });
    }
    this.liveAssistantId = undefined;
  }

  private closeLiveAssistant(): void {
    const live = this.liveAssistantId ? this.findAssistant(this.liveAssistantId) : undefined;
    if (live) live.streaming = false;
    this.liveAssistantId = undefined;
  }

  private findAssistant(id: string): Extract<TranscriptItem, { kind: "assistant" }> | undefined {
    const it = this.items.find((i) => i.id === id);
    return it && it.kind === "assistant" ? it : undefined;
  }

  private findTool(toolId: string): Extract<TranscriptItem, { kind: "tool" }> | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (it.kind === "tool" && it.toolId === toolId) return it;
    }
    return undefined;
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }
}
