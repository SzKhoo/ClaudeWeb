import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMeta, writeMetaAtomic, readActive, writeActive } from "../src/storage/meta.js";

describe("meta.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wcc-meta-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("readMeta returns null when missing", async () => {
    expect(await readMeta(dir)).toBeNull();
  });

  it("writeMetaAtomic then readMeta", async () => {
    const meta = { id: "a", title: null, summary: null, startedAt: 1, endedAt: null, lastActivityAt: 1, status: "active" as const };
    await writeMetaAtomic(dir, meta);
    expect(await readMeta(dir)).toEqual(meta);
  });

  it("writeMetaAtomic does not leave a .tmp file", async () => {
    const meta = { id: "a", title: null, summary: null, startedAt: 1, endedAt: null, lastActivityAt: 1, status: "active" as const };
    await writeMetaAtomic(dir, meta);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("readActive/writeActive", async () => {
    expect(await readActive(dir)).toBeNull();
    await writeActive(dir, "abc");
    expect(await readActive(dir)).toBe("abc");
  });
});
