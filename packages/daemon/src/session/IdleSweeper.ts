import { readMeta } from "../storage/meta.js";
import { sessionDir } from "../storage/paths.js";
import type { SessionManager } from "./SessionManager.js";

export interface IdleSweeperOptions {
  manager: SessionManager;
  now: () => number;
  idleMs?: number;
  tickMs?: number;
}

export class IdleSweeper {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly opts: IdleSweeperOptions) {}

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs ?? 15 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const idle = this.opts.idleMs ?? 6 * 60 * 60 * 1000;
    const id = this.opts.manager.getActiveId();
    const workspaceRoot = this.opts.manager.workspaceRoot;
    if (!workspaceRoot) return;
    const meta = await readMeta(sessionDir(workspaceRoot, id));
    if (!meta) return;
    if (this.opts.now() - meta.lastActivityAt >= idle) {
      await this.opts.manager.newSession();
    }
  }
}
