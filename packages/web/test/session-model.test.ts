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

  it("adds a system item for a non-ok turn_complete and clears pending", () => {
    const m = new SessionModel();
    m.apply({ type: "permission_request", requestId: "r", toolName: "Write", input: {} });
    m.apply({ type: "turn_complete", status: "error", message: "daemon restarted mid-turn" });
    expect(m.view().pending).toBeUndefined();
    const last = items(m).at(-1);
    expect(last).toMatchObject({ kind: "system", level: "error" });
    expect((last as { text: string }).text).toContain("daemon restarted mid-turn");
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
});
