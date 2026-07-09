/**
 * StubSummarizerEngine — a placeholder SummarizerEngine until a real one-shot engine query is plumbed
 * (see Task 10 report follow-ups). It always throws, so Summarizer.run's catch path kicks in and falls
 * back to using the first user message as the title (summary stays null). This is an accepted, tracked
 * degradation: sessions still get *a* title, just not an LLM-generated one.
 */

import type { SummarizerEngine } from "./Summarizer.js";

export class StubSummarizerEngine implements SummarizerEngine {
  async summarize(): Promise<{ title: string; summary: string }> {
    throw new Error("summarizer not yet wired to engine");
  }
}
