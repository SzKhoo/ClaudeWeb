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

export async function writeMetaAtomic(dir: string, meta: SessionMeta): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.meta.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8");
  await rename(tmp, join(dir, "meta.json"));
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
