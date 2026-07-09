import { mkdir, rm } from "node:fs/promises";
import { ulid } from "ulid";
import type { ApplicationEvent, SessionMetaSummary } from "@wcc/shared";
import { FileJournal } from "../storage/journal.js";
import { SessionStorage } from "../storage/SessionStorage.js";
import { SessionIndex } from "../storage/SessionIndex.js";
import {
  readMeta,
  writeMetaAtomic,
  readActive,
  writeActive,
  type SessionMeta,
} from "../storage/meta.js";
import { journalPath, sessionDir } from "../storage/paths.js";
import { migrateLegacySessions } from "../storage/migrate.js";

export interface SessionManagerOptions {
  workspaceRoot: string;
  index: SessionIndex;
  now: () => number;
  /** Fire-and-forget request to summarize a closed session. */
  summarize: (sessionId: string) => void;
  /** Forwarded to each session's SessionStorage. */
  maxReplayEvents?: number;
  maxToolStreamBytes?: number;
}

export interface ResumeResult {
  storage: SessionStorage;
  resumeContext: string | null;
}

export class SessionManager {
  readonly workspaceRoot: string;
  private readonly index: SessionIndex;
  private readonly now: () => number;
  private readonly summarize: (id: string) => void;
  private readonly maxReplayEvents: number | undefined;
  private readonly maxToolStreamBytes: number | undefined;
  private activeId: string | null = null;
  private storage: SessionStorage | null = null;
  private currentJournal: FileJournal | null = null;
  private mutex: Promise<void> = Promise.resolve();

  constructor(opts: SessionManagerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.index = opts.index;
    this.now = opts.now;
    this.summarize = opts.summarize;
    this.maxReplayEvents = opts.maxReplayEvents;
    this.maxToolStreamBytes = opts.maxToolStreamBytes;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let resolveNext!: () => void;
    this.mutex = new Promise<void>((r) => { resolveNext = r; });
    return prev.then(fn).finally(resolveNext);
  }

  async initialize(): Promise<{ activeId: string; storage: SessionStorage }> {
    await migrateLegacySessions(this.workspaceRoot, this.now);
    await this.index.refresh();
    const active = await readActive(this.workspaceRoot);
    if (active) {
      const meta = await readMeta(sessionDir(this.workspaceRoot, active));
      if (meta) {
        await this.attach(active);
        // ensure meta shows status active
        if (meta.status !== "active") {
          await writeMetaAtomic(sessionDir(this.workspaceRoot, active), { ...meta, status: "active" });
          await this.index.refresh();
        }
        return { activeId: active, storage: this.storage! };
      }
    }
    // No usable active — mint one.
    const id = await this.mint();
    return { activeId: id, storage: this.storage! };
  }

  private async attach(id: string): Promise<void> {
    // Close the outgoing journal so we don't leak write streams.
    if (this.currentJournal) {
      try {
        await this.currentJournal.close();
      } catch {
        // journal already closed or write stream error — safe to ignore.
      }
    }
    const journal = await FileJournal.open(journalPath(this.workspaceRoot, id));
    this.currentJournal = journal;
    const storage = new SessionStorage({
      sessionId: id,
      journal,
      onAppend: () => { void this.touch(); },
      ...(this.maxReplayEvents !== undefined ? { maxReplayEvents: this.maxReplayEvents } : {}),
      ...(this.maxToolStreamBytes !== undefined ? { maxToolStreamBytes: this.maxToolStreamBytes } : {}),
      now: this.now,
    });
    await storage.load();
    this.storage = storage;
    this.activeId = id;
    await writeActive(this.workspaceRoot, id);
  }

  private async mint(): Promise<string> {
    const id = ulid();
    const dir = sessionDir(this.workspaceRoot, id);
    await mkdir(dir, { recursive: true });
    const meta: SessionMeta = {
      id, title: null, summary: null,
      startedAt: this.now(), endedAt: null,
      lastActivityAt: this.now(), status: "active",
    };
    await writeMetaAtomic(dir, meta);
    await this.attach(id);
    await this.index.refresh();
    return id;
  }

  private async close(id: string): Promise<void> {
    const dir = sessionDir(this.workspaceRoot, id);
    const meta = await readMeta(dir);
    if (!meta) return;
    await writeMetaAtomic(dir, { ...meta, status: "closed", endedAt: this.now() });
    // fire-and-forget summarizer
    this.summarize(id);
  }

  getActiveId(): string {
    if (!this.activeId) throw new Error("SessionManager not initialized");
    return this.activeId;
  }

  getStorage(): SessionStorage {
    if (!this.storage) throw new Error("SessionManager not initialized");
    return this.storage;
  }

  list(): SessionMetaSummary[] {
    return this.index.list();
  }

  newSession(): Promise<{ id: string; storage: SessionStorage }> {
    return this.withLock(async () => {
      const old = this.activeId;
      if (old) await this.close(old);
      const id = await this.mint();
      return { id, storage: this.storage! };
    });
  }

  openSession(args: { id: string; resume: boolean }): Promise<ResumeResult | null> {
    return this.withLock(async () => {
      if (args.id === this.activeId) return null;
      if (!args.resume) return null;
      const dir = sessionDir(this.workspaceRoot, args.id);
      const meta = await readMeta(dir);
      if (!meta) return null;
      const old = this.activeId;
      if (old) await this.close(old);
      // Reopen the target
      await writeMetaAtomic(dir, { ...meta, status: "active" });
      await this.attach(args.id);
      // Write session_resumed marker into the journal as a normal event.
      const resumed: ApplicationEvent = { type: "session_resumed", ts: this.now(), previousSessionId: old ?? undefined };
      this.storage!.append(resumed);
      await this.index.refresh();
      return { storage: this.storage!, resumeContext: meta.summary };
    });
  }

  async readJournal(id: string, cursor = 0, limit = 100): Promise<{ events: ApplicationEvent[]; nextCursor?: number }> {
    const journal = await FileJournal.open(journalPath(this.workspaceRoot, id));
    try {
      const records = await journal.readAll();
      const events = records.filter((r) => r.kind === "event").map((r) => (r as { event: ApplicationEvent }).event);
      const slice = events.slice(cursor, cursor + limit);
      const next = cursor + slice.length < events.length ? cursor + slice.length : undefined;
      return { events: slice, ...(next !== undefined ? { nextCursor: next } : {}) };
    } finally {
      await journal.close();
    }
  }

  deleteSession(id: string): Promise<boolean> {
    return this.withLock(async () => {
      if (id === this.activeId) return false;
      await rm(sessionDir(this.workspaceRoot, id), { recursive: true, force: true });
      await this.index.refresh();
      return true;
    });
  }

  renameSession(id: string, title: string): Promise<boolean> {
    // Behind the same mutex as touch()/newSession/etc. — renaming the ACTIVE session would otherwise
    // race a concurrent touch() writing the same meta.json.
    return this.withLock(async () => {
      const dir = sessionDir(this.workspaceRoot, id);
      const meta = await readMeta(dir);
      if (!meta) return false;
      await writeMetaAtomic(dir, { ...meta, title });
      await this.index.refresh();
      return true;
    });
  }

  /**
   * Bump lastActivityAt for the active session. Called (fire-and-forget) on every journal append, so
   * it MUST be serialized behind the same mutex as newSession/openSession/deleteSession — otherwise a
   * touch() racing a session switch/delete can write a stale meta.json or crash on a removed directory
   * (observed as sporadic EPERM/ENOENT from concurrent writeMetaAtomic on Windows). Best-effort: a
   * missing dir/meta (already deleted or mid-switch) is swallowed rather than thrown.
   */
  touch(): Promise<void> {
    return this.withLock(async () => {
      if (!this.activeId) return;
      const dir = sessionDir(this.workspaceRoot, this.activeId);
      try {
        const meta = await readMeta(dir);
        if (!meta) return;
        await writeMetaAtomic(dir, { ...meta, lastActivityAt: this.now() });
      } catch {
        // Session directory vanished (deleted/switched) between the read and write — not fatal.
      }
    });
  }

  /** Flush + close the active session's journal write stream (daemon shutdown). */
  async dispose(): Promise<void> {
    if (!this.currentJournal) return;
    try {
      await this.currentJournal.close();
    } catch {
      // already closed — safe to ignore.
    }
    this.currentJournal = null;
  }
}
