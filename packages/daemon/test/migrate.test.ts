import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacySessions } from "../src/storage/migrate.js";
import { sessionsRoot, journalPath, metaPath } from "../src/storage/paths.js";
import { readMeta } from "../src/storage/meta.js";

describe("migrateLegacySessions", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "wcc-mig-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("no-op on empty root", async () => {
    const result = await migrateLegacySessions(root, () => 1000);
    expect(result.migrated).toEqual([]);
  });

  it("wraps flat *.jsonl into folder + stub meta", async () => {
    await mkdir(sessionsRoot(root), { recursive: true });
    await writeFile(join(sessionsRoot(root), "old.jsonl"), '{"kind":"event","seq":1,"ts":1,"event":{"type":"assistant_message","text":"hi"}}\n');
    const result = await migrateLegacySessions(root, () => 5000);
    expect(result.migrated).toEqual(["old"]);
    // original journal preserved at new path
    const s = await stat(journalPath(root, "old"));
    expect(s.isFile()).toBe(true);
    // meta stub written
    const meta = await readMeta(join(sessionsRoot(root), "old"));
    expect(meta).toMatchObject({ id: "old", status: "closed", lastActivityAt: 5000 });
  });

  it("is idempotent", async () => {
    await mkdir(sessionsRoot(root), { recursive: true });
    await writeFile(join(sessionsRoot(root), "old.jsonl"), "");
    await migrateLegacySessions(root, () => 1);
    const second = await migrateLegacySessions(root, () => 2);
    expect(second.migrated).toEqual([]);
  });

  it("ignores non-jsonl files and existing folders", async () => {
    await mkdir(join(sessionsRoot(root), "already"), { recursive: true });
    await writeFile(join(sessionsRoot(root), "README.md"), "");
    const result = await migrateLegacySessions(root, () => 1);
    expect(result.migrated).toEqual([]);
  });
});
