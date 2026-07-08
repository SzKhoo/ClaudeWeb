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

    const userMsgs: string[] = [];
    const asstMsgs: string[] = [];
    const tools = new Set<string>();
    for (const r of records) {
      if (r.kind !== "event") continue;
      const e = r.event;
      if (e.type === "user_message") userMsgs.push(e.text);
      else if (e.type === "assistant_message") asstMsgs.push(e.text);
      else if (e.type === "tool_use") tools.add(e.name);
    }

    if (userMsgs.length === 0) {
      // Empty session — delete the folder entirely.
      await rm(dir, { recursive: true, force: true });
      return;
    }

    const prompt = buildPrompt(userMsgs, asstMsgs, [...tools]);

    let title: string;
    let summary: string | null;
    try {
      const result = await this.opts.engine.summarize(prompt);
      title = result.title.slice(0, MAX_TITLE);
      summary = result.summary;
    } catch (err) {
      this.opts.log?.("warn", "summarizer failed", { sessionId, err: String(err) });
      title = userMsgs[0]!.slice(0, MAX_TITLE);
      summary = null;
    }

    await writeMetaAtomic(dir, { ...meta, title, summary });
  }
}

function buildPrompt(user: string[], asst: string[], tools: string[]): string {
  return [
    "Summarize the following conversation for later resume.",
    "Return ONLY compact JSON: { \"title\": string, \"summary\": string }",
    "- title: ≤60 chars, imperative or noun phrase.",
    "- summary: focused on user goal, decisions, unfinished threads, key file paths / commands. ≤800 tokens.",
    "",
    "USER:", ...user.map((t) => "- " + t.replace(/\s+/g, " ").slice(0, 500)),
    "",
    "ASSISTANT:", ...asst.map((t) => "- " + t.replace(/\s+/g, " ").slice(0, 500)),
    "",
    "TOOLS:", tools.join(", "),
  ].join("\n");
}
