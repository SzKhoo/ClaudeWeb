# Milestone M2 — Real engine + dogfood (Phase 2a)

**Created by the 2026-07-02 plan review (U1):** this was Phase 0's "0A/0B gate", wrongly treated as
blocked ("needs an authenticated Claude machine") while two phases were built on MockEngine. The
current dev machine **is** an authenticated Claude machine — the gate is runnable NOW and is the
next work item. Everything else (Phase 2b hardening, 2c monetization, 3 cloud) queues behind it.

**Goal:** `WCC_ENGINE=claude` works: a browser drives the REAL Claude Code on this machine through
relay + daemon, with streaming, tool approval (incl. diff), interrupt, multi-prompt sessions, and
native conversation resume. Then the owner uses it daily (dogfood) instead of the mock demo.

## Stories

### S2.1 — 0B: lock the engine mechanism (research, ~half day) — ✅ DONE
- [x] Auth reality check: verified via the `claude-api` skill and SDK exports — the licensed path
      on the user's own machine is the **Claude Agent SDK** (`query()` in streaming-input mode),
      which spawns the locally-installed `claude` CLI and inherits its auth. **No API key needed.**
- [x] Mapped the SDK message stream → our `ApplicationEvent`s + `canUseTool` → our
      `permission_request`/`approveTool` seam. Details in
      [task-07 note](../notes/task-07-real-engine.md).
- [x] Interrupt semantics + session resume flag (`resume: <sessionId>`) confirmed. Critical detail:
      after `interrupt()` the SDK **still emits a `result` message** for the turn — the engine
      remaps it to `turn_complete { status: "interrupted" }`.

### S2.2 — 0A: runtime spike [GATE] (on THIS machine) — ✅ PASS
- [x] `packages/daemon/spike/agent-spike.mjs` — four legs all green on `claude-haiku-4-5`:
  - L1 file-written (canUseTool → allow → real disk write)
  - L2 multi-turn in the same live session
  - L3 `interrupt()` returned control mid-turn
  - L4 fresh `query({ resume: sessionId })` recalled earlier context (`greeting.txt`)
  - GATE PASS ✅

### S2.3 — `ClaudeAgentEngine` — ✅ DONE
- [x] `packages/daemon/src/engine/ClaudeAgentEngine.ts` implements `IAgentEngine` — Session/Daemon
      untouched. Injectable `queryFn` (lazy import in prod; scripted fake in tests).
- [x] `WCC_ENGINE=claude` wired in `packages/daemon/src/index.ts`; optional `WCC_MODEL`.
- [x] Tests: 9 unit tests with a scripted SDK fake covering the full mapping. Full suite: **132/132**
      across 16 files. Typecheck clean.

### S2.4 — Dogfood
- [ ] Owner runs a real task end-to-end from a browser against this machine (queued).
- [ ] Capture friction list → feeds Phase 2b priorities.

## Done =
A real Claude Code session driven from the browser on a genuine task, with approval + interrupt +
resume proven, and the mock demoted to tests only. **Achieved for the engine.** Dogfood is
scheduled; results feed Phase 2b priorities.
