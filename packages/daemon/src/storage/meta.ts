import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activePath } from "./paths.js";

export interface SessionMeta {
  id: string;
  title: string | null;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  status: "active" | "closed";
}

export async function readMeta(dir: string): Promise<SessionMeta | null> {
  try {
    const text = await readFile(join(dir, "meta.json"), "utf8");
    return JSON.parse(text) as SessionMeta;
  } catch {
    return null;
  }
}

let writeMetaAtomicCounter = 0;

/**
 * Retry a rename a few times on Windows-only transient lock errors (EPERM/EBUSY). Observed under
 * rapid successive writeMetaAtomic calls to the SAME destination path (e.g. many newSession() calls
 * in a tight loop) — something (antivirus real-time scanning, a lagging readFile handle close) briefly
 * holds the just-replaced meta.json, and Node's rename() surfaces that as EPERM rather than blocking.
 * The write itself is still atomic (rename, not in-place edit); this only retries the OS call.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (i === attempts - 1 || (code !== "EPERM" && code !== "EBUSY")) throw err;
      await new Promise((r) => setTimeout(r, 5 * (i + 1)));
    }
  }
}

export async function writeMetaAtomic(dir: string, meta: SessionMeta): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Unique per call (not just per-process): guards against two overlapping writes to the SAME
  // directory colliding on one shared tmp filename (observed as sporadic EPERM/ENOENT on Windows
  // when a fire-and-forget touch() raced a rename/delete before touch() was mutex-serialized).
  const tmp = join(dir, `.meta.json.${process.pid}.${writeMetaAtomicCounter++}.tmp`);
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await renameWithRetry(tmp, join(dir, "meta.json"));
}

export async function readActive(workspaceRoot: string): Promise<string | null> {
  try {
    const text = await readFile(activePath(workspaceRoot), "utf8");
    const obj = JSON.parse(text) as { activeSessionId?: string };
    return obj.activeSessionId ?? null;
  } catch {
    return null;
  }
}

export async function writeActive(workspaceRoot: string, sessionId: string): Promise<void> {
  const p = activePath(workspaceRoot);
  await mkdir(join(workspaceRoot, ".wcc"), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ activeSessionId: sessionId }), "utf8");
  await rename(tmp, p);
}
