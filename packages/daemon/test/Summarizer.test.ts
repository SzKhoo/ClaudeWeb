import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Summarizer, type SummarizerEngine } from "../src/session/Summarizer.js";
import { sessionDir, journalPath } from "../src/storage/paths.js";
import { writeMetaAtomic, readMeta } from "../src/storage/meta.js";

/**
 * Seeds a journal with REAL ApplicationEvent shapes only — the user's own prompt text is never
 * journaled (it's a CmdUserMessage, an inbound command, not an ApplicationEvent; see Session.ts's
 * startTurn(), which never calls this.push() with the user's text). A fixture that hand-writes a fake
 * "user_message" event (as this test used to) would mask Summarizer relying on an event type real
 * sessions never produce — which is exactly the bug this fixture change guards against.
 */
const seed = async (root: string, id: string) => {
  const dir = sessionDir(root, id);
  await mkdir(dir, { recursive: true });
  await writeMetaAtomic(dir, {
    id, title: null, summary: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
  });
  const lines = [
    { kind: "event", seq: 1, ts: 1, event: { type: "assistant_message", text: "Looked at auth.ts, patched race." } },
    { kind: "event", seq: 2, ts: 2, event: { type: "tool_use", toolId: "t1", name: "Edit", input: {} } },
  ];
  await writeFile(journalPath(root, id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

describe("Summarizer", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-sum-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("writes title + summary from engine reply", async () => {
    await seed(root, "s1");
    const engine: SummarizerEngine = {
      async summarize() { return { title: "Fix login bug", summary: "Patched auth race" }; },
    };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 99 });
    await s.run("s1");
    const meta = await readMeta(sessionDir(root, "s1"));
    expect(meta?.title).toBe("Fix login bug");
    expect(meta?.summary).toBe("Patched auth race");
  });

  it("falls back to the first assistant message on engine error", async () => {
    await seed(root, "s2");
    const engine: SummarizerEngine = {
      async summarize() { throw new Error("boom"); },
    };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 1 });
    await s.run("s2");
    const meta = await readMeta(sessionDir(root, "s2"));
    expect(meta?.title).toBe("Looked at auth.ts, patched race.");
    expect(meta?.summary).toBeNull();
  });

  it("falls back to the session id when there's no assistant message either", async () => {
    const dir = sessionDir(root, "s3");
    await mkdir(dir, { recursive: true });
    await writeMetaAtomic(dir, {
      id: "s3", title: null, summary: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
    });
    // Some non-empty journal, but nothing that yields a title candidate (e.g. only a status event).
    const lines = [
      { kind: "event", seq: 1, ts: 1, event: { type: "session_status", state: "idle" } },
    ];
    await writeFile(journalPath(root, "s3"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const engine: SummarizerEngine = { async summarize() { throw new Error("boom"); } };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 1 });
    await s.run("s3");
    const meta = await readMeta(dir);
    expect(meta?.title).toBe("s3");
  });

  it("skips empty sessions and deletes their folder", async () => {
    // No events at all were ever journaled.
    const dir = sessionDir(root, "empty");
    await mkdir(dir, { recursive: true });
    await writeMetaAtomic(dir, {
      id: "empty", title: null, summary: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
    });
    await writeFile(journalPath(root, "empty"), "");
    const engine: SummarizerEngine = { async summarize() { throw new Error("should not be called"); } };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 1 });
    await s.run("empty");
    const meta = await readMeta(sessionDir(root, "empty"));
    expect(meta).toBeNull(); // folder removed
  });
});
