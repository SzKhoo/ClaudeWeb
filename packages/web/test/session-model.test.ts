import { describe, expect, it } from "vitest";
import type { ApplicationEvent } from "@wcc/shared";
import { SessionModel, type TranscriptItem } from "../src/session-model.js";

function items(model: SessionModel): TranscriptItem[] {
  return model.view().items;
}

describe("SessionModel", () => {
  it("accumulates assistant deltas then finalizes on assistant_message", () => {
    const m = new SessionModel();
    m.apply({ type: "assistant_delta", text: "Hel" });
    m.apply({ type: "assistant_delta", text: "lo" });
    expect(items(m)).toEqual([{ kind: "assistant", id: "a1", text: "Hello", streaming: true }]);

    m.apply({ type: "assistant_message", text: "Hello world" });
    expect(items(m)).toEqual([{ kind: "assistant", id: "a1", text: "Hello world", streaming: false }]);
  });

  it("renders the tool lifecycle: use → stream → result, in order after the assistant bubble closes", () => {
    const m = new SessionModel();
    m.apply({ type: "assistant_delta", text: "Working…" });
    m.apply({ type: "tool_use", toolId: "tool-1", name: "Write", input: { path: "hello.txt" } });
    m.apply({ type: "tool_stream", toolId: "tool-1", offset: 0, chunk: "Wrote 10 bytes\n" });
    m.apply({ type: "tool_result", toolId: "tool-1", ok: true, summary: "Created hello.txt" });

    const list = items(m);
    expect(list[0]).toMatchObject({ kind: "assistant", streaming: false });
    expect(list[1]).toMatchObject({
      kind: "tool",
      name: "Write",
      output: "Wrote 10 bytes\n",
      result: { ok: true, summary: "Created hello.txt" },
    });
  });

  it("surfaces a permission_request as pending, with its diff, and clears it on non-awaiting status", () => {
    const m = new SessionModel();
    m.apply({
      type: "permission_request",
      requestId: "req-1",
      toolName: "Write",
      input: { path: "x.txt" },
      diff: { path: "x.txt", unified: "--- /dev/null\n+++ b/x.txt\n+hi" },
      expiresAt: 123,
    });
    expect(m.view().pending).toMatchObject({ requestId: "req-1", toolName: "Write" });
    expect(m.view().pending?.diff?.unified).toContain("+hi");

    m.apply({ type: "session_status", state: "awaiting-approval" });
    expect(m.view().pending).toBeDefined();
    m.apply({ type: "session_status", state: "tool-running" });
    expect(m.view().pending).toBeUndefined();
  });

  it("tracks session state + execution mode from session_status", () => {
    const m = new SessionModel();
    m.apply({ type: "session_status", state: "thinking", workspaceId: "default", executionMode: "auto-edits" });
    const v = m.view();
    expect(v.state).toBe("thinking");
    expect(v.executionMode).toBe("auto-edits");
    expect(v.workspaceId).toBe("default");
  });

  it("tracks model + effort from session_status", () => {
    const m = new SessionModel();
    m.apply({ type: "session_status", state: "idle", model: "claude-opus-4-8", effort: "high" });
    const v = m.view();
    expect(v.model).toBe("claude-opus-4-8");
    expect(v.effort).toBe("high");
  });

  it("adds a system item for a non-ok turn_complete and clears pending", () => {
    const m = new SessionModel();
    m.apply({ type: "permission_request", requestId: "r", toolName: "Write", input: {} });
    m.apply({ type: "turn_complete", status: "error", message: "daemon restarted mid-turn" });
    expect(m.view().pending).toBeUndefined();
    const last = items(m).at(-1);
    expect(last).toMatchObject({ kind: "system", level: "error" });
    expect((last as { text: string }).text).toContain("daemon restarted mid-turn");
  });

  it("records attachment metadata on a local user message", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("look at this", [
      { name: "shot.png", mediaType: "image/png" },
      { name: "notes.txt", mediaType: "text/plain" },
    ]);
    const first = items(m)[0];
    expect(first).toMatchObject({ kind: "user", text: "look at this" });
    expect((first as { attachments?: unknown }).attachments).toEqual([
      { name: "shot.png", mediaType: "image/png" },
      { name: "notes.txt", mediaType: "text/plain" },
    ]);
  });

  it("shows local user messages immediately and records errors + session end", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("create hello.txt");
    m.apply({ type: "error", code: "rejected_command", message: "command rejected: replayed" } as ApplicationEvent);
    m.apply({ type: "session_ended", reason: "client requested end" });

    const list = items(m);
    expect(list[0]).toEqual({ kind: "user", id: "u1", text: "create hello.txt" });
    expect(list.some((i) => i.kind === "error")).toBe(true);
    expect(m.view().ended?.reason).toBe("client requested end");
    expect(m.view().state).toBe("ended");
  });

  it("emits a bundle transcript item on turn_complete for Write/Edit tools that succeeded", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("edit two files");
    m.apply({ type: "tool_use", toolId: "t1", name: "Write", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t1", ok: true });
    m.apply({ type: "tool_use", toolId: "t2", name: "Edit", input: { file_path: "b.ts" } });
    m.apply({ type: "tool_result", toolId: "t2", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });

    const list = items(m);
    const bundle = list.find((i) => i.kind === "bundle");
    expect(bundle).toBeDefined();
    expect((bundle as Extract<TranscriptItem, { kind: "bundle" }>).paths).toEqual(["a.txt", "b.ts"]);
  });

  it("does not emit a bundle for Read-only turns", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("read a file");
    m.apply({ type: "tool_use", toolId: "r1", name: "Read", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "r1", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });

    expect(items(m).some((i) => i.kind === "bundle")).toBe(false);
  });

  it("excludes tool calls that failed and dedupes repeated paths", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("edit same file twice + one failure");
    m.apply({ type: "tool_use", toolId: "t1", name: "Edit", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t1", ok: true });
    m.apply({ type: "tool_use", toolId: "t2", name: "Edit", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t2", ok: true });
    m.apply({ type: "tool_use", toolId: "t3", name: "Write", input: { file_path: "b.txt" } });
    m.apply({ type: "tool_result", toolId: "t3", ok: false });
    m.apply({ type: "turn_complete", status: "ok" });

    const bundle = items(m).find((i) => i.kind === "bundle") as
      | Extract<TranscriptItem, { kind: "bundle" }>
      | undefined;
    expect(bundle).toBeDefined();
    expect(bundle!.paths).toEqual(["a.txt"]);
  });

  it("clears the changed-files tracker at the start of the next turn", () => {
    const m = new SessionModel();
    m.addLocalUserMessage("turn 1");
    m.apply({ type: "tool_use", toolId: "t1", name: "Write", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "t1", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });
    m.addLocalUserMessage("turn 2");
    m.apply({ type: "tool_use", toolId: "r1", name: "Read", input: { file_path: "a.txt" } });
    m.apply({ type: "tool_result", toolId: "r1", ok: true });
    m.apply({ type: "turn_complete", status: "ok" });

    const bundles = items(m).filter((i) => i.kind === "bundle");
    expect(bundles).toHaveLength(1);
  });

  describe("session sidebar state", () => {
    it("starts with empty sessions list and null ids", () => {
      const m = new SessionModel();
      const v = m.view();
      expect(v.sessions).toEqual([]);
      expect(v.activeSessionId).toBeNull();
      expect(v.displayedSessionId).toBeNull();
      expect(v.displayedItems).toBeNull();
    });

    it("sessions_list updates the list", () => {
      const m = new SessionModel();
      m.apply({
        type: "sessions_list",
        sessions: [
          { id: "a", title: "A", lastActivityAt: 1, status: "closed" },
          { id: "b", title: "B", lastActivityAt: 2, status: "active" },
        ],
      });
      expect(m.view().sessions.map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("session_switched sets active id and defaults displayed id, patches status", () => {
      const m = new SessionModel();
      m.apply({
        type: "sessions_list",
        sessions: [
          { id: "a", title: "A", lastActivityAt: 1, status: "active" },
          { id: "b", title: "B", lastActivityAt: 2, status: "closed" },
        ],
      });
      m.apply({
        type: "session_switched",
        sessionId: "b",
        meta: { id: "b", title: "B", lastActivityAt: 2, status: "active" },
      });
      const v = m.view();
      expect(v.activeSessionId).toBe("b");
      expect(v.displayedSessionId).toBe("b");
      expect(v.sessions.find((s) => s.id === "a")?.status).toBe("closed");
      expect(v.sessions.find((s) => s.id === "b")?.status).toBe("active");
    });

    it("session_deleted removes from list and reverts displayed to active if it was showing the deleted one", () => {
      const m = new SessionModel();
      m.apply({
        type: "sessions_list",
        sessions: [
          { id: "a", title: "A", lastActivityAt: 1, status: "active" },
          { id: "b", title: "B", lastActivityAt: 2, status: "closed" },
        ],
      });
      m.apply({
        type: "session_switched",
        sessionId: "a",
        meta: { id: "a", title: "A", lastActivityAt: 1, status: "active" },
      });
      m.setDisplayedSession("b");
      m.apply({ type: "session_deleted", sessionId: "b" });
      const v = m.view();
      expect(v.sessions.map((s) => s.id)).toEqual(["a"]);
      expect(v.displayedSessionId).toBe("a");
      expect(v.displayedItems).toBeNull();
    });

    it("session_renamed patches the title", () => {
      const m = new SessionModel();
      m.apply({
        type: "sessions_list",
        sessions: [{ id: "a", title: "Old", lastActivityAt: 1, status: "closed" }],
      });
      m.apply({ type: "session_renamed", sessionId: "a", title: "New" });
      expect(m.view().sessions.find((s) => s.id === "a")?.title).toBe("New");
    });

    it("session_journal fills displayedItems by folding events, but only for the currently displayed id", () => {
      const m = new SessionModel();
      m.apply({
        type: "session_switched",
        sessionId: "current",
        meta: { id: "current", title: null, lastActivityAt: 1, status: "active" },
      });
      m.setDisplayedSession("old");
      // Reply for a DIFFERENT session — should be ignored.
      m.apply({
        type: "session_journal",
        sessionId: "stale",
        events: [{ type: "assistant_message", text: "hi" }],
      });
      expect(m.view().displayedItems).toBeNull();

      // Reply for the currently-displayed session — should fold.
      m.apply({
        type: "session_journal",
        sessionId: "old",
        events: [
          { type: "assistant_delta", text: "Hello" },
          { type: "assistant_message", text: "Hello world" },
        ],
      });
      const shown = m.view().displayedItems;
      expect(shown).not.toBeNull();
      expect(shown).toEqual([{ kind: "assistant", id: "a1", text: "Hello world", streaming: false }]);
    });

    it("setDisplayedSession(null) reverts to the active session", () => {
      const m = new SessionModel();
      m.apply({
        type: "session_switched",
        sessionId: "current",
        meta: { id: "current", title: null, lastActivityAt: 1, status: "active" },
      });
      m.setDisplayedSession("old");
      m.apply({
        type: "session_journal",
        sessionId: "old",
        events: [{ type: "assistant_message", text: "X" }],
      });
      m.setDisplayedSession(null);
      const v = m.view();
      expect(v.displayedSessionId).toBe("current");
      expect(v.displayedItems).toBeNull();
    });
  });
});
