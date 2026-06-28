/**
 * SessionStorage — the single owner of a session's durable + in-memory state (invariant #3):
 *   - journal      : append-only source of truth (events + turn_start/turn_end markers)
 *   - replay window: ring of the most recent N events (serves reconnect backfill)
 *   - stream windows: per-tool cumulative stdout, last M bytes kept, byte-offset addressable
 *
 * It assigns the global monotonic `seq` that orders the transcript, and stamps each `tool_stream`
 * event with its cumulative `offset`. Per-client delivery is request-driven: a reconnecting client
 * states its position via resume{sinceSeq, toolStreamOffsets}; backfill is a pure query over this
 * store, so no per-client cursor state is persisted here.
 */

import type { ApplicationEvent, EvtToolStream, TurnStatus } from "@wcc/shared";
import type { JournalRecord, JournalSink } from "./journal.js";

export interface StoredEvent {
  seq: number;
  ts: number;
  event: ApplicationEvent;
}

export interface SessionStorageOptions {
  sessionId: string;
  journal: JournalSink;
  /** Max events kept in the in-memory replay window. Default 1000. */
  maxReplayEvents?: number;
  /** Max bytes kept per tool stream window. Default 5 MiB. */
  maxToolStreamBytes?: number;
  /** Clock (injectable for tests). */
  now?: () => number;
}

interface ToolStream {
  /** Cumulative length ever produced (the next offset to assign). */
  total: number;
  /** The last `maxToolStreamBytes` characters. */
  window: string;
}

export class SessionStorage {
  readonly sessionId: string;
  private readonly journal: JournalSink;
  private readonly maxReplayEvents: number;
  private readonly maxToolStreamBytes: number;
  private readonly now: () => number;

  private seq = 0;
  private replay: StoredEvent[] = [];
  private readonly toolStreams = new Map<string, ToolStream>();

  constructor(opts: SessionStorageOptions) {
    this.sessionId = opts.sessionId;
    this.journal = opts.journal;
    this.maxReplayEvents = opts.maxReplayEvents ?? 1000;
    this.maxToolStreamBytes = opts.maxToolStreamBytes ?? 5 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Rebuild in-memory state from the journal and report any turns that were left open (a dirty exit).
   * Restores `seq`, the replay window and tool stream windows without re-journaling.
   */
  async load(): Promise<{ dirtyTurns: string[] }> {
    const records = await this.journal.readAll();
    const openTurns = new Set<string>();
    for (const r of records) {
      if (r.kind === "turn_start") openTurns.add(r.turnId);
      else if (r.kind === "turn_end") openTurns.delete(r.turnId);
      else if (r.kind === "event") {
        this.seq = Math.max(this.seq, r.seq);
        this.pushReplay({ seq: r.seq, ts: r.ts, event: r.event });
        if (r.event.type === "tool_stream") this.accountStream(r.event);
      }
    }
    return { dirtyTurns: [...openTurns] };
  }

  /** Append an event: assign seq, stamp tool_stream offset, persist, and window it. */
  append(event: ApplicationEvent): StoredEvent {
    let toStore = event;
    if (event.type === "tool_stream") {
      toStore = this.stampAndAccount(event);
    }
    const stored: StoredEvent = { seq: ++this.seq, ts: this.now(), event: toStore };
    this.pushReplay(stored);
    this.journal.append({ kind: "event", seq: stored.seq, ts: stored.ts, event: stored.event });
    return stored;
  }

  turnStart(turnId: string): void {
    this.journal.append({ kind: "turn_start", ts: this.now(), turnId });
  }

  turnEnd(turnId: string, status: TurnStatus): void {
    this.journal.append({ kind: "turn_end", ts: this.now(), turnId, status });
  }

  /** Events with seq strictly greater than `sinceSeq`, from the replay window (best-effort if evicted). */
  eventsSince(sinceSeq: number): StoredEvent[] {
    return this.replay.filter((e) => e.seq > sinceSeq);
  }

  /** Backfill a tool's stdout after `offset`; undefined if nothing new (or unknown tool). */
  toolStreamSince(toolId: string, offset: number): { offset: number; chunk: string } | undefined {
    const s = this.toolStreams.get(toolId);
    if (!s) return undefined;
    const windowStart = s.total - s.window.length;
    const from = Math.max(offset, windowStart);
    if (from >= s.total) return undefined;
    return { offset: from, chunk: s.window.slice(from - windowStart) };
  }

  currentSeq(): number {
    return this.seq;
  }

  /** Snapshot of each tool's current cumulative offset (for tests/ops). */
  toolOffsets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, s] of this.toolStreams) out[id] = s.total;
    return out;
  }

  // ── internals ──

  private stampAndAccount(event: EvtToolStream): EvtToolStream {
    const s = this.streamFor(event.toolId);
    const stamped: EvtToolStream = { ...event, offset: s.total };
    this.appendWindow(s, event.chunk);
    return stamped;
  }

  /** Account a tool_stream already carrying its offset (used during load()). */
  private accountStream(event: EvtToolStream): void {
    const s = this.streamFor(event.toolId);
    this.appendWindow(s, event.chunk);
  }

  private streamFor(toolId: string): ToolStream {
    let s = this.toolStreams.get(toolId);
    if (!s) {
      s = { total: 0, window: "" };
      this.toolStreams.set(toolId, s);
    }
    return s;
  }

  private appendWindow(s: ToolStream, chunk: string): void {
    s.window += chunk;
    s.total += chunk.length;
    if (s.window.length > this.maxToolStreamBytes) {
      s.window = s.window.slice(s.window.length - this.maxToolStreamBytes);
    }
  }

  private pushReplay(stored: StoredEvent): void {
    this.replay.push(stored);
    if (this.replay.length > this.maxReplayEvents) {
      this.replay.splice(0, this.replay.length - this.maxReplayEvents);
    }
  }
}
