import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/storage/SessionIndex.js";
import { writeMetaAtomic } from "../src/storage/meta.js";
import { sessionDir } from "../src/storage/paths.js";

describe("SessionIndex", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-idx-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const writeSession = async (id: string, lastActivityAt: number, title: string | null) => {
    const dir = sessionDir(root, id);
    await mkdir(dir, { recursive: true });
    await writeMetaAtomic(dir, {
      id, title, summary: null, startedAt: 0, endedAt: null,
      lastActivityAt, status: "closed",
    });
  };

  it("empty root lists nothing", async () => {
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    expect(idx.list()).toEqual([]);
    idx.stop();
  });

  it("lists sessions sorted by lastActivityAt desc", async () => {
    await writeSession("a", 100, "A");
    await writeSession("b", 300, "B");
    await writeSession("c", 200, "C");
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    expect(idx.list().map((s) => s.id)).toEqual(["b", "c", "a"]);
    idx.stop();
  });

  it("refresh picks up new sessions", async () => {
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    await writeSession("z", 1, "Z");
    await idx.refresh();
    expect(idx.list().map((s) => s.id)).toEqual(["z"]);
    idx.stop();
  });

  it("skips folders without meta.json", async () => {
    await mkdir(sessionDir(root, "junk"), { recursive: true });
    await writeSession("a", 1, "A");
    const idx = new SessionIndex({ workspaceRoot: root });
    await idx.start();
    expect(idx.list().map((s) => s.id)).toEqual(["a"]);
    idx.stop();
  });
});
