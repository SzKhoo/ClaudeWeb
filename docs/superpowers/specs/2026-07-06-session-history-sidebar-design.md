# Session-history sidebar — design

**Date:** 2026-07-06
**Status:** Design approved, ready for implementation plan
**Scope:** WebClaudeCode (P1 add-on)

## Problem

Today the daemon owns a single long-lived Session. Every conversation lives in one journal; there is no way to browse past topics, resume an old thread, or keep contexts separate. Loading the whole transcript on resume would also waste tokens on every restart.

## Goals

1. Multiple named sessions, each with its own transcript.
2. A sidebar to list, open, rename, and delete past sessions.
3. Clicking a past session is **free** — reads the transcript from disk, spends zero tokens.
4. Resuming a past session (typing a follow-up) primes Claude with a compact **auto-summary**, not the full transcript.
5. Single-drawer UI: `+ New session` → history list → `Settings`, in that vertical order.

## Non-goals

- Per-session or per-topic auto-memory folders (rejected as over-engineered for the token savings we get from the summary approach).
- Search across sessions.
- Cross-device session sync (daemon PC is the source of truth).
- Multi-workspace scoping — sessions are global on the daemon; per-workspace scoping can come with P3.

---

## Disk layout

```
~/.wcc/
  sessions/
    <sessionId>/
      journal.jsonl        # existing append-only event log, unchanged format
      meta.json            # { id, title, summary, startedAt, endedAt, lastActivityAt, status }
    <sessionId>/
      ...
  active.json              # { activeSessionId }
```

- `sessionId` = ULID (time-sortable, collision-free).
- `meta.json.status` ∈ `"active" | "closed"`. Exactly one session is `active` at any time (mirrors `active.json`).
- `title` and `summary` start `null`; filled when the session closes and the summarizer runs.
- **Migration:** on first launch of the new build, if the current singleton journal exists, wrap it in `<newId>/journal.jsonl` and write a stub `meta.json` with `status:"active"`. Set `active.json` to that id.

---

## Daemon architecture

Two new pieces, one small refactor. The daemon remains **single-session at any instant**; multi-session lives in the index + folder-per-id storage.

### `SessionIndex` (new)

- Scans `~/.wcc/sessions/*/meta.json` on startup.
- Watches the folder for changes (fs.watch).
- Serves the sidebar list: `[{id, title, lastActivityAt, status}]`.
- Never touches journal files. Cheap to reload.

### `SessionStorage` (existing, tiny change)

- Already scoped to one `sessionId`. Journal path becomes `~/.wcc/sessions/<id>/journal.jsonl`. No other change.

### `Daemon` (refactor)

- **Startup:** read `active.json` → construct `SessionStorage` for that id → wire Session/engine/workspace as today.
- **On `new_session`:** close current session (mark `status:"closed"`, kick off summarizer in background), mint new ULID, construct fresh `SessionStorage`, update `active.json`, broadcast `session_switched`.
- **On `open_session { id, resume: true }`:** same as above but with an existing id; also loads `meta.json.summary` into a one-shot `resumeContext` for the next turn.
- **On `open_session { id, resume: false }` / `get_session_journal { id }`:** serve the journal for display; do NOT switch active.

Session serialization: a single mutex on session-switch to prevent concurrent New-session presses from creating two.

---

## Protocol additions

All fit the existing typed protocol.

| Command | Reply | Notes |
|---|---|---|
| `list_sessions` | `sessions_list { sessions[] }` | Served from `SessionIndex`. |
| `get_session_journal { id, cursor?, limit? }` | `session_journal { id, events[], nextCursor? }` | Paged (default 100). Read-only, no engine. |
| `new_session` | `session_switched { id, meta }` | Closes current in background. |
| `open_session { id, resume }` | `session_switched { id, meta }` (if `resume:true`) or `session_journal { ... }` (if `resume:false`) | See resume flow. |
| `delete_session { id }` | `session_deleted { id }` | Rejected if `id` is active. |
| `rename_session { id, title }` | `session_renamed { id, title }` | Overwrites `meta.json.title`. Server broadcasts. |

New broadcast event: **`session_switched { id, meta }`** — sent to all connected clients.

Client-side split: **displayed session** (which transcript is on screen) vs **active session** (which the daemon is running). First follow-up message on a displayed-but-not-active session triggers `open_session { resume: true }` under the hood; the UI shows a subtle "Resuming…" state until `session_switched` returns.

---

## Summary + title generation

Triggered on session close (New Session pressed, or idle fallback fires).

**Input to the summarizer call:**
- All `user_message.text`.
- All `assistant_message.text` (final only, not tool streams).
- A compressed listing of tools used and file paths touched (names only, no content).

**Call:** one Claude Agent SDK call (Haiku-tier) with a fixed system prompt asking for JSON:
```json
{ "title": "...", "summary": "..." }
```
- `title` ≤ 60 chars, imperative or noun phrase.
- `summary` ≤ ~800 tokens, focused on: user's goal, decisions made, unfinished threads, key file paths / commands.

**Persistence:** write to `meta.json`, flip `status` to `"closed"`.

**Async:** runs in the background — closing a session does NOT block. Sidebar shows "Summarizing…" for that row until it finishes.

**Failure handling:** on summarizer error, `title` falls back to the first user message truncated to 60 chars; `summary` stays `null`. Sidebar still works; resume just skips the system-prompt injection.

**Idle fallback:** default **6 hours** since `lastActivityAt`. Checked by a daemon-side timer every 15 min. Tunable later, not part of this spec.

**Cost:** one Haiku-tier call per session close — negligible.

---

## Resume flow

Precondition: user is viewing session X (read-only) and types a message.

1. Web client sees `displayed !== active`, sends `open_session { id: X, resume: true }` before the message.
2. Daemon:
   1. Closes the currently-active session in the background (summarizer kicks off).
   2. Loads `~/.wcc/sessions/X/meta.json`. If `summary` present, stash as `resumeContext`.
   3. Constructs a fresh `SessionStorage` at `~/.wcc/sessions/X/journal.jsonl`.
   4. Flips `meta.json.status` to `"active"`, updates `active.json`.
   5. Writes a new **`session_resumed`** journal event (new event type on the existing schema) with `{ ts, previousSessionId }`; the UI renders it as a "Resumed <timestamp>" divider.
   6. Replies `session_switched { id: X }`.
3. Web client sends the user message.
4. Daemon starts the turn. `Session` holds a one-shot `pendingResumeContext` field set in step 2.2 and consumed on the next engine invocation (cleared after use). The engine invocation gets `resumeContext` prepended as a system message:
   ```
   [Prior session context — do not repeat back to user]
   <summary>
   ```
   Subsequent turns in the same active session do NOT re-inject — it's already in the CLI process's context.

**Failure modes:**
- Summary is `null` (never closed cleanly, or summarizer failed) → skip injection. Claude picks up cold with just the new message. Acceptable degradation.
- Very old session vs current Agent SDK → still fine; we're only injecting text, not resuming a CLI session id.

---

## Sidebar UI

One drawer, vertically stacked:

```
┌──────────────────────────────────────┐
│  [+ New session]                     │
├──────────────────────────────────────┤
│  Sessions                            │
│  ● Fix pairing key display           │  active (dot filled)
│    2h ago                            │
│  ○ Draft P2 relay design             │
│    yesterday                         │
│  ○ Summarizing…                      │  summary in flight
│    just now                          │
│  ○ (untitled, 3 messages)            │  summary failed → fallback
│    2 days ago                        │
├──────────────────────────────────────┤
│  Settings                            │
│  (existing: machine, theme, pairing) │
└──────────────────────────────────────┘
```

**Behaviors**

- Tap a row → main pane shows the transcript read-only. No LLM call. Row gets a "viewing" highlight distinct from "active".
- Long-press / right-click → context menu: **Rename**, **Delete**.
  - Rename edits `meta.json.title` via a new `rename_session { id, title }` command.
  - Delete requires confirm; hidden on the active row.
- `+ New session` → sends `new_session`; drawer stays open so the new entry appears at the top.
- Sort: `lastActivityAt` desc.
- Empty state: only `+ New session` above the Settings hr.
- Re-renders on every `sessions_list` broadcast; no polling.
- Mobile: same layout, drawer full-height. Rows single-line with truncation.

---

## Edge cases

| Case | Handling |
|---|---|
| Dirty exit with open turns | Existing `SessionStorage.load` invariant handles dirty turns. Session stays `active` in `meta.json`; no auto-summary until user closes it. |
| Empty session (opened, no messages) | On close, skip summarizer, delete the folder. Never clutter the sidebar. |
| Rename collision | Titles are not unique. UI distinguishes by timestamp. |
| Delete active session | Rejected server-side; hidden client-side. |
| Delete target of an in-flight summarizer | Summarizer completes, write is a no-op (fs error swallowed + logged). |
| Concurrent New-session presses (two browsers) | Serialized on a single daemon mutex — second press waits and receives the same new id. |
| Very long journals | `get_session_journal` supports `{cursor, limit}`; Transcript already virtualizes. |
| Journal file corruption | Existing `journal.readAll` skips malformed records + logs. No change. |
| Timezone rendering | Timestamps stored as epoch ms; client renders relative in local zone. |

---

## Rollout / implementation notes

- Ship behind no flag; there's no legacy user cohort.
- The migration runs on first startup of the new build; it's a one-time filesystem move.
- No changes to relay / e2e packages.
- Client change: new sidebar sections, new command wiring, "Resuming…" state.
- Testing: unit tests for `SessionIndex` (list, watch, corrupt meta), `SessionStorage` (unchanged behavior at new path), summarizer wiring (mocked engine); an e2e that creates 3 sessions, deletes one, resumes another.

## Open questions

None blocking. Idle-fallback duration (6h) and paging window (100) are defaults, tunable later.
