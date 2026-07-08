import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session/SessionManager.js";
import { SessionIndex } from "../src/storage/SessionIndex.js";

describe("SessionManager", () => {
  let root: string;
  let clock: number;
  const now = () => clock;
  const noSummarize = () => { /* noop */ };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wcc-sm-"));
    clock = 1000;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const makeMgr = async () => {
    const index = new SessionIndex({ workspaceRoot: root });
    const mgr = new SessionManager({ workspaceRoot: root, index, now, summarize: noSummarize });
    await mgr.initialize();
    await index.start();
    return { mgr, index };
  };

  it("initialize creates a fresh active session on empty workspace", async () => {
    const { mgr } = await makeMgr();
    const id = mgr.getActiveId();
    expect(id).toBeTruthy();
    expect(mgr.list().length).toBe(1);
    expect(mgr.list()[0]!.status).toBe("active");
  });

  it("newSession closes current and mints a new one", async () => {
    const { mgr, index } = await makeMgr();
    const first = mgr.getActiveId();
    clock = 2000;
    const { id: second } = await mgr.newSession();
    expect(second).not.toBe(first);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === first)?.status).toBe("closed");
    expect(mgr.list().find((s) => s.id === second)?.status).toBe("active");
  });

  it("openSession(resume:true) switches active", async () => {
    const { mgr, index } = await makeMgr();
    const first = mgr.getActiveId();
    await mgr.newSession();
    clock = 3000;
    const result = await mgr.openSession({ id: first, resume: true });
    expect(result).not.toBeNull();
    expect(mgr.getActiveId()).toBe(first);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === first)?.status).toBe("active");
  });

  it("openSession(resume:false) is a no-op on active", async () => {
    const { mgr } = await makeMgr();
    const before = mgr.getActiveId();
    const result = await mgr.openSession({ id: before, resume: false });
    expect(result).toBeNull();
    expect(mgr.getActiveId()).toBe(before);
  });

  it("deleteSession refuses active", async () => {
    const { mgr } = await makeMgr();
    const id = mgr.getActiveId();
    expect(await mgr.deleteSession(id)).toBe(false);
  });

  it("deleteSession removes closed session", async () => {
    const { mgr, index } = await makeMgr();
    const first = mgr.getActiveId();
    await mgr.newSession();
    expect(await mgr.deleteSession(first)).toBe(true);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === first)).toBeUndefined();
  });

  it("renameSession updates title", async () => {
    const { mgr, index } = await makeMgr();
    const id = mgr.getActiveId();
    expect(await mgr.renameSession(id, "Hello")).toBe(true);
    await index.refresh();
    expect(mgr.list().find((s) => s.id === id)?.title).toBe("Hello");
  });

  it("resumeContext is the closed session's summary", async () => {
    const { mgr } = await makeMgr();
    const first = mgr.getActiveId();
    // manually finalize the summary as if summarizer had run
    const { writeMetaAtomic } = await import("../src/storage/meta.js");
    const { sessionDir } = await import("../src/storage/paths.js");
    await writeMetaAtomic(sessionDir(root, first), {
      id: first, title: "T", summary: "SUMMARY_TEXT",
      startedAt: 1, endedAt: 2, lastActivityAt: 2, status: "closed",
    });
    await mgr.newSession();
    const result = await mgr.openSession({ id: first, resume: true });
    expect(result?.resumeContext).toBe("SUMMARY_TEXT");
  });
});
