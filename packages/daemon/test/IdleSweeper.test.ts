import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdleSweeper } from "../src/session/IdleSweeper.js";
import { SessionManager } from "../src/session/SessionManager.js";
import { SessionIndex } from "../src/storage/SessionIndex.js";

describe("IdleSweeper", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-idle-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("does nothing when active session is fresh", async () => {
    let clock = 1000;
    const index = new SessionIndex({ workspaceRoot: root });
    const mgr = new SessionManager({ workspaceRoot: root, index, now: () => clock, summarize: () => {} });
    await mgr.initialize();
    const before = mgr.getActiveId();
    const sweeper = new IdleSweeper({ manager: mgr, now: () => clock, idleMs: 100 });
    clock = 1050; // less than 100 later
    await sweeper.tick();
    expect(mgr.getActiveId()).toBe(before);
  });

  it("rolls to new session when idle exceeds threshold", async () => {
    let clock = 1000;
    const index = new SessionIndex({ workspaceRoot: root });
    const mgr = new SessionManager({ workspaceRoot: root, index, now: () => clock, summarize: () => {} });
    await mgr.initialize();
    const before = mgr.getActiveId();
    const sweeper = new IdleSweeper({ manager: mgr, now: () => clock, idleMs: 100 });
    clock = 2000;
    await sweeper.tick();
    expect(mgr.getActiveId()).not.toBe(before);
  });
});
