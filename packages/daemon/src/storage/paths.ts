import { join } from "node:path";

export const sessionsRoot = (workspaceRoot: string): string =>
  join(workspaceRoot, ".wcc", "sessions");

export const sessionDir = (workspaceRoot: string, id: string): string =>
  join(sessionsRoot(workspaceRoot), id);

export const journalPath = (workspaceRoot: string, id: string): string =>
  join(sessionDir(workspaceRoot, id), "journal.jsonl");

export const metaPath = (workspaceRoot: string, id: string): string =>
  join(sessionDir(workspaceRoot, id), "meta.json");

export const activePath = (workspaceRoot: string): string =>
  join(workspaceRoot, ".wcc", "active.json");
