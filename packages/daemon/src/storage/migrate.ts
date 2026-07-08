import { readdir, rename, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { sessionsRoot, sessionDir, journalPath } from "./paths.js";
import { readMeta, writeMetaAtomic, type SessionMeta } from "./meta.js";

export async function migrateLegacySessions(
  workspaceRoot: string,
  now: () => number,
): Promise<{ migrated: string[] }> {
  const root = sessionsRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { migrated: [] };
  }
  const migrated: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(root, name);
    const s = await stat(full);
    if (!s.isFile()) continue;
    const id = name.slice(0, -".jsonl".length);
    const dir = sessionDir(workspaceRoot, id);
    // If dir already exists, skip (idempotent).
    try {
      await stat(dir);
      continue;
    } catch { /* dir absent → migrate */ }
    await mkdir(dir, { recursive: true });
    await rename(full, journalPath(workspaceRoot, id));
    const existing = await readMeta(dir);
    if (!existing) {
      const meta: SessionMeta = {
        id,
        title: null,
        summary: null,
        startedAt: now(),
        endedAt: null,
        lastActivityAt: now(),
        status: "closed",
      };
      await writeMetaAtomic(dir, meta);
    }
    migrated.push(id);
  }
  return { migrated };
}
