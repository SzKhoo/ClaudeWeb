import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Summarizer, type SummarizerEngine } from "../src/session/Summarizer.js";
import { sessionDir, journalPath } from "../src/storage/paths.js";
import { writeMetaAtomic, readMeta } from "../src/storage/meta.js";

const seed = async (root: string, id: string) => {
  const dir = sessionDir(root, id);
  await mkdir(dir, { recursive: true });
  await writeMetaAtomic(dir, {
    id, title: null, summary: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
  });
  const lines = [
    { kind: "event", seq: 1, ts: 1, event: { type: "user_message", text: "Fix the login bug" } },
    { kind: "event", seq: 2, ts: 2, event: { type: "assistant_message", text: "Looked at auth.ts, patched race." } },
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

  it("falls back to first user message on engine error", async () => {
    await seed(root, "s2");
    const engine: SummarizerEngine = {
      async summarize() { throw new Error("boom"); },
    };
    const s = new Summarizer({ workspaceRoot: root, engine, now: () => 1 });
    await s.run("s2");
    const meta = await readMeta(sessionDir(root, "s2"));
    expect(meta?.title).toBe("Fix the login bug");
    expect(meta?.summary).toBeNull();
  });

  it("skips empty sessions and deletes their folder", async () => {
    // No user messages
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
