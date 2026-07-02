# Milestone M2 — Real engine + dogfood (Phase 2a)

**Created by the 2026-07-02 plan review (U1):** this was Phase 0's "0A/0B gate", wrongly treated as
blocked ("needs an authenticated Claude machine") while two phases were built on MockEngine. The
current dev machine **is** an authenticated Claude machine — the gate is runnable NOW and is the
next work item. Everything else (Phase 2b hardening, 2c monetization, 3 cloud) queues behind it.

**Goal:** `WCC_ENGINE=claude` works: a browser drives the REAL Claude Code on this machine through
relay + daemon, with streaming, tool approval (incl. diff), interrupt, multi-prompt sessions, and
native conversation resume. Then the owner uses it daily (dogfood) instead of the mock demo.

## Stories

### S2.1 — 0B: lock the engine mechanism (research, ~half day)
- [ ] Auth reality check: subscription/OAuth via Agent SDK is ToS-constrained for third parties
      (ISSUES #14). Expected conclusion: on the user's own machine, spawn the installed **`claude`
      CLI** with `--input-format stream-json --output-format stream-json --print`-style flags —
      it uses whatever auth the user already configured, which is exactly what's licensed.
      Verify against current docs (claude-code-guide agent) before coding.
- [ ] Map the stream-json event schema → our `ApplicationEvent`s (assistant deltas, tool_use,
      tool results, turn completion) and the permission mechanism (`--permission-prompt-tool` /
      canUseTool equivalent) → our `permission_request`/`approveTool` seam.
- [ ] Interrupt semantics (signal vs control message) + session resume flag (`--resume <id>`) +
      compaction behavior. Write findings into this file.

### S2.2 — 0A: runtime spike [GATE] (on THIS machine)
- [ ] Minimal script: spawn engine → prompt → stream → propose file write → approve → file exists →
      second prompt in same session → interrupt mid-turn → resume conversation after process
      restart with context preserved (NO raw-transcript re-feed).
- [ ] If any leg fails → STOP, revisit architecture (that is what a gate means).

### S2.3 — `ClaudeAgentEngine`
- [ ] `packages/daemon/src/engine/ClaudeAgentEngine.ts` implementing `IAgentEngine` (same seam as
      MockEngine — Session/Daemon untouched).
- [ ] `WCC_ENGINE=claude` wiring in `packages/daemon/src/index.ts` (currently exits 2).
- [ ] Tests: engine adapter unit tests w/ a scripted fake `claude` process; the real-CLI test is a
      manually-run spec (`*.manual.test.ts`, excluded from CI-style runs) since it needs auth + spends tokens.

### S2.4 — Dogfood
- [ ] Owner runs a real task end-to-end from a browser (phone if possible) against this machine.
- [ ] Capture friction list → feeds Phase 2b priorities.

## Done =
A real Claude Code session driven from the browser on a genuine task, with approval + interrupt +
resume proven, and the mock demoted to tests only.
