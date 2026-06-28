/**
 * Policy — daemon-side, default-deny execution control (invariant #4).
 *
 * Decides whether a tool call should be auto-approved or surfaced to the user for approval. The
 * default mode is `manual` (prompt for everything). `Bash` (and other shell/network tools) are NEVER
 * auto-approved by `auto-edits` — they always prompt unless the user explicitly allow-listed them for
 * the session or opted into `yolo`. This counters prompt-injection + approval-fatigue.
 */

import type { ExecutionMode } from "@wcc/shared";

export type PolicyOutcome = "auto-approve" | "prompt";

/** Tools considered "edits" — auto-approvable under `auto-edits`. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create_file",
  "apply_patch",
]);

/** Tools that must NEVER be auto-approved by `auto-edits` (only explicit allow-list or `yolo`). */
const NEVER_AUTO_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Shell",
  "Exec",
  "WebFetch",
  "WebSearch",
]);

export class Policy {
  private mode: ExecutionMode = "manual";
  private readonly allow = new Set<string>();

  decide(toolName: string): PolicyOutcome {
    if (this.allow.has(toolName)) return "auto-approve";
    if (this.mode === "yolo") return "auto-approve";
    if (this.mode === "auto-edits" && EDIT_TOOLS.has(toolName) && !NEVER_AUTO_TOOLS.has(toolName)) {
      return "auto-approve";
    }
    return "prompt";
  }

  update(change: { executionMode?: ExecutionMode; allowTools?: string[] }): void {
    if (change.executionMode) this.mode = change.executionMode;
    if (change.allowTools) for (const t of change.allowTools) this.allow.add(t);
  }

  /** Persist a session-scoped allow for one tool (from a permission_response with scope "session"). */
  allowForSession(toolName: string): void {
    this.allow.add(toolName);
  }

  snapshot(): { mode: ExecutionMode; allowTools: string[] } {
    return { mode: this.mode, allowTools: [...this.allow] };
  }
}
