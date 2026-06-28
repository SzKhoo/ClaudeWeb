/**
 * Journal = the append-only source of truth for a session (invariant #3). Two sinks:
 *   - InMemoryJournal: tests.
 *   - FileJournal: the real daemon (JSONL under <workspace>/.wcc/sessions/<sessionId>.jsonl), which
 *     survives a process restart so a dirty exit can be detected and the UI unlocked.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApplicationEvent, TurnStatus } from "@wcc/shared";

export type JournalRecord =
  | { kind: "event"; seq: number; ts: number; event: ApplicationEvent }
  | { kind: "turn_start"; ts: number; turnId: string }
  | { kind: "turn_end"; ts: number; turnId: string; status: TurnStatus };

export interface JournalSink {
  append(record: JournalRecord): void;
  readAll(): Promise<JournalRecord[]>;
  close(): Promise<void>;
}

export class InMemoryJournal implements JournalSink {
  readonly records: JournalRecord[] = [];
  append(record: JournalRecord): void {
    this.records.push(record);
  }
  async readAll(): Promise<JournalRecord[]> {
    return [...this.records];
  }
  async close(): Promise<void> {
    /* nothing */
  }
}

export class FileJournal implements JournalSink {
  private constructor(
    private readonly path: string,
    private readonly stream: WriteStream,
  ) {}

  static async open(path: string): Promise<FileJournal> {
    await mkdir(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "a" });
    return new FileJournal(path, stream);
  }

  append(record: JournalRecord): void {
    // createWriteStream preserves write order; one JSON object per line.
    this.stream.write(JSON.stringify(record) + "\n");
  }

  async readAll(): Promise<JournalRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const out: JournalRecord[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as JournalRecord);
      } catch {
        /* skip a torn final line from a hard crash */
      }
    }
    return out;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
