import { rm } from "node:fs/promises";
import { FileJournal } from "../storage/journal.js";
import { readMeta, writeMetaAtomic } from "../storage/meta.js";
import { journalPath, sessionDir } from "../storage/paths.js";

export interface SummarizerEngine {
  summarize(prompt: string): Promise<{ title: string; summary: string }>;
}

export interface SummarizerOptions {
  workspaceRoot: string;
  engine: SummarizerEngine;
  now: () => number;
  log?: (level: "info" | "warn", msg: string, meta?: Record<string, unknown>) => void;
}

const MAX_TITLE = 60;

export class Summarizer {
  constructor(private readonly opts: SummarizerOptions) {}

  async run(sessionId: string): Promise<void> {
    const dir = sessionDir(this.opts.workspaceRoot, sessionId);
    const meta = await readMeta(dir);
    if (!meta) return;
    const journal = await FileJournal.open(journalPath(this.opts.workspaceRoot, sessionId));
    const records = await journal.readAll();
    await journal.close();

    // NOTE: the user's own prompt text is never journaled as an ApplicationEvent — only the daemon's
    // OWN emitted events (assistant_message, tool_use, etc.) land in the journal; user_message is a
    // CmdUserMessage (an inbound COMMAND), not a member of the ApplicationEvent union. So "empty
    // session" and the title fallback are both derived from events that DO get journaled. See
    // packages/daemon/test/Summarizer.test.ts and the Task 10 follow-up for plumbing a real
    // first-prompt-derived title (tracked separately; this keeps the fallback correct in the meantime).
    const asstMsgs: string[] = [];
    const tools = new Set<string>();
    let eventCount = 0;
    for (const r of records) {
      if (r.kind !== "event") continue;
      eventCount++;
      const e = r.event;
      if (e.type === "assistant_message") asstMsgs.push(e.text);
      else if (e.type === "tool_use") tools.add(e.name);
    }

    if (eventCount === 0) {
      // Truly empty session (nothing was ever journaled) — delete the folder entirely.
      await rm(dir, { recursive: true, force: true });
      return;
    }

    const prompt = buildPrompt(asstMsgs, [...tools]);

    let title: string;
    let summary: string | null;
    try {
      const result = await this.opts.engine.summarize(prompt);
      title = result.title.slice(0, MAX_TITLE);
      summary = result.summary;
    } catch (err) {
      this.opts.log?.("warn", "summarizer failed", { sessionId, err: String(err) });
      title = (asstMsgs[0] ?? sessionId).slice(0, MAX_TITLE);
      summary = null;
    }

    await writeMetaAtomic(dir, { ...meta, title, summary });
  }
}

function buildPrompt(asst: string[], tools: string[]): string {
  return [
    "Summarize the following conversation for later resume.",
    "Return ONLY compact JSON: { \"title\": string, \"summary\": string }",
    "- title: ≤60 chars, imperative or noun phrase.",
    "- summary: focused on user goal, decisions, unfinished threads, key file paths / commands. ≤800 tokens.",
    "",
    "ASSISTANT:", ...asst.map((t) => "- " + t.replace(/\s+/g, " ").slice(0, 500)),
    "",
    "TOOLS:", tools.join(", "),
  ].join("\n");
}
