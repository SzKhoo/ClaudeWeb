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
  SessionMetaSummary,
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
  /** All sessions on the daemon, sorted by lastActivityAt desc. */
  sessions: SessionMetaSummary[];
  /** The session the daemon is currently running turns on. */
  activeSessionId: string | null;
  /** The session whose transcript is on screen (may be a past session in read-only view). */
  displayedSessionId: string | null;
  /**
   * Read-only transcript items reduced from a past session's journal. Non-null when the user
   * clicked a past session in the sidebar and its journal has been fetched.
   */
  displayedItems: TranscriptItem[] | null;
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
  private sessions: SessionMetaSummary[] = [];
  private activeSessionId: string | null = null;
  private displayedSessionId: string | null = null;
  private displayedItems: TranscriptItem[] | null = null;

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
      case "sessions_list":
        this.sessions = event.sessions;
        return;
      case "session_switched":
        this.activeSessionId = event.sessionId;
        // If nothing was displayed yet, or the user was viewing the just-switched-away session,
        // default to showing the newly-active session live.
        if (this.displayedSessionId === null || this.displayedSessionId === this.activeSessionId) {
          this.displayedSessionId = event.sessionId;
          this.displayedItems = null;
        }
        // Patch the sessions list entry so the sidebar reflects "active" immediately.
        this.sessions = this.sessions.map((s) =>
          s.id === event.sessionId ? { ...s, status: "active" } : s.status === "active" ? { ...s, status: "closed" } : s,
        );
        return;
      case "session_deleted":
        this.sessions = this.sessions.filter((s) => s.id !== event.sessionId);
        if (this.displayedSessionId === event.sessionId) {
          this.displayedSessionId = this.activeSessionId;
          this.displayedItems = null;
        }
        return;
      case "session_renamed":
        this.sessions = this.sessions.map((s) =>
          s.id === event.sessionId ? { ...s, title: event.title } : s,
        );
        return;
      case "session_journal":
        // Only apply if it matches what the UI is currently displaying (a stale reply for a different
        // session — e.g. the user tapped twice fast — is dropped).
        if (this.displayedSessionId === event.sessionId) {
          this.displayedItems = reduceEventsToItems(event.events);
        }
        return;
      case "session_resumed":
        // In-journal marker; nothing to fold into live-session state. The Transcript renders it as
        // a divider when it appears inside a displayedItems list.
        return;
    }
  }

  /** Clear the pending prompt optimistically (the UI calls this right after the user answers). */
  clearPending(): void {
    this.pending = undefined;
  }

  /**
   * The UI calls this when the user taps a session row. Passing null (or the active id) reverts
   * to showing the live session. Passing a non-active id clears any previously-fetched displayed
   * journal so the caller can dispatch `get_session_journal` and wait for it.
   */
  setDisplayedSession(id: string | null): void {
    if (id === null || id === this.activeSessionId) {
      this.displayedSessionId = this.activeSessionId;
      this.displayedItems = null;
      return;
    }
    this.displayedSessionId = id;
    this.displayedItems = null;
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
      sessions: [...this.sessions],
      activeSessionId: this.activeSessionId,
      displayedSessionId: this.displayedSessionId,
      displayedItems: this.displayedItems ? [...this.displayedItems] : null,
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

/**
 * Fold a past session's journal events into transcript items — used to render read-only views of
 * past sessions in the sidebar. Runs a fresh SessionModel that only sees `apply()`, so it reuses the
 * exact same transcript-building rules as the live view.
 */
function reduceEventsToItems(events: ApplicationEvent[]): TranscriptItem[] {
  const m = new SessionModel();
  for (const ev of events) m.apply(ev);
  return m.view().items;
}
