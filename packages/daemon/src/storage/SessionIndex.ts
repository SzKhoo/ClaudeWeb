import { readdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import type { SessionMetaSummary } from "@wcc/shared";
import { readMeta } from "./meta.js";
import { sessionDir, sessionsRoot } from "./paths.js";

export interface SessionIndexOptions {
  workspaceRoot: string;
  onChange?: () => void;
}

export class SessionIndex {
  private readonly workspaceRoot: string;
  private readonly onChange?: () => void;
  private items: SessionMetaSummary[] = [];
  private watcher: FSWatcher | null = null;
  private pending: NodeJS.Timeout | null = null;

  constructor(opts: SessionIndexOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.onChange = opts.onChange;
  }

  async start(): Promise<void> {
    await this.refresh();
    try {
      this.watcher = watch(sessionsRoot(this.workspaceRoot), { persistent: false }, () => {
        if (this.pending) return;
        this.pending = setTimeout(() => {
          this.pending = null;
          void this.refresh().then(() => this.onChange?.());
        }, 100); // debounce
      });
    } catch {
      // sessionsRoot may not exist yet; refresh() created nothing, watcher optional.
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pending) clearTimeout(this.pending);
  }

  async refresh(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(sessionsRoot(this.workspaceRoot));
    } catch {
      this.items = [];
      return;
    }
    const found: SessionMetaSummary[] = [];
    for (const id of entries) {
      const meta = await readMeta(sessionDir(this.workspaceRoot, id));
      if (!meta) continue;
      found.push({ id: meta.id, title: meta.title, lastActivityAt: meta.lastActivityAt, status: meta.status });
    }
    found.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    this.items = found;
  }

  list(): SessionMetaSummary[] {
    return [...this.items];
  }
}
