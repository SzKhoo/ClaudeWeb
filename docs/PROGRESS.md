# PROGRESS — WebClaudeCode (codename: ClaudeBridge)

> **READ THIS FIRST after any restart / token-limit reset.**
> This is the single source of truth for "where am I". Update it at the end of every task.
> Repo root: `E:\StorageContent\Personal\WebClaudeCode`
> Docker artifacts (if ever needed): `E:\StorageContent\Docker`

## What we are building (one paragraph)
A cloud/web-delivered version of Claude Code. A subscriber opens a website, logs in, and — as
long as their own PC is powered on — drives the **real Claude Code running on their own machine**
from anywhere. Browser ⇄ WSS ⇄ Relay ⇄ WSS ⇄ Daemon(on user PC) ⇄ Claude Agent SDK. The relay is an
untrusted dumb pipe; the daemon is the security boundary; human-origin messages are E2E-signed with
replay protection. Full design in [PLAN.md](./PLAN.md).

## Monorepo layout
```
packages/shared  — protocol types, canonical bytes, sign/verify+replay, IAgentEngine contract  (Task 1)
packages/relay   — WS hub, routes by deviceId only, holds no session content                    (Task 2)
packages/daemon  — WorkspaceManager→Workspace→Session, SessionStorage, engine impl, policy       (Task 3)
packages/web     — React+Vite UI: streaming chat, tool-approval + diff, signed commands          (Task 4)
docs/            — this trail: PROGRESS, PLAN, milestones/, notes/ (per-task), issues/
```

## Toolchain (verified 2026-06-28)
- Node v24.15.0, npm 11.12.1, git 2.53.0. pnpm not installed → using **npm workspaces**.
- Docker installed but daemon not assumed running → Phase 0 runs as local Node processes (Docker deferred).
- **C: drive has ~0.1 GB free.** npm cache redirected to `E:\StorageContent\npm-cache`. TEMP redirected to E: during installs. Keep everything on E:.

## Status board
| Task | What | State |
|------|------|-------|
| 0 | Repo scaffold, docs trail, root config, git init | **DONE** |
| 1 | `shared/` protocol + canonical + sign/verify+replay + IAgentEngine + tests | **DONE** (28/28 tests green) |
| 0B | Engine specifics (auth, canUseTool, Stop hook, interrupt, resume/compaction) | **DONE** — Claude Agent SDK `query()` streaming-input, no API key (uses local login) |
| 0A | [GATE] Runtime spike over external transport | **DONE / PASS** — 4 legs green on this machine (see notes/task-07) |
| 2 | `relay/` deviceId-routed WS hub | **DONE** (10/10 tests; entrypoint runs) |
| 3 | `daemon/` sessions/storage/engine/policy | **DONE** (19/19 tests; e2e over real sockets) |
| 4 | `web/` UI | **DONE** (6/6 model tests; live preview verified) |
| 5 | End-to-end verification | **DONE** (5/5 automated full-stack + live browser) |
| 6 | **Phase 1** — multi-tenant shell: pairing protocol, relay authz, daemon enrollment, web auth+CSP, Supabase migrations | **DONE** (119/120 tests; e2e flake ISSUES #13) |
| 6S | [GATE] Real Supabase project applied (S1.6) | TODO (manual; tracked in supabase/README.md) |
| 7 | **M2 / Phase 2a** — real `ClaudeAgentEngine` + `WCC_ENGINE=claude` | **DONE** (9 new tests; 132/132 total; 0A gate PASS) |
| 7D | Dogfood: owner drives a real task from the browser against this machine | TODO — run flow ready: `npm run dev:relay` / `dev:daemon` / `dev:web`, phone steps in [RUN-LOCAL.md](./RUN-LOCAL.md) |
| P1 | Personal-first re-cut: one-command local run + LAN reachability for the phone | **DONE** (dev:relay/dev:daemon scripts, Vite host:true, RUN-LOCAL guide) |
| #15 | Payload E2E encryption (pre-public-launch req) | **Stage 1+2 DONE** (X25519 channel key + AEAD seal primitive, +9 tests); Stage 3 wiring designed & paused for review — see [note](./notes/issue-15-payload-encryption.md) |

## How to resume
1. Read this file's Status board.
2. Read the latest `docs/notes/task-*.md` for the task marked IN PROGRESS.
3. Read `docs/issues/ISSUES.md` for open landmines.
4. Continue from the first TODO/unchecked item.

## Commands
- Install: `npm install` (from repo root; cache+temp already on E:).
- Test all: `npm test` (= `vitest run`). One pkg: `npm test -- packages/daemon` (NO `-w`; exFAT = no workspaces).
- Typecheck: `npm run typecheck`.
- Build all: `npm run build`.

## Changelog (newest first)
- 2026-07-04 — **Personal-first re-cut (P1) + payload-encryption Stages 1–2.** Owner scoped the
  project to a personal self-hosted tool first (drive Claude from the phone; multi-project + phone
  preview later), product deferred. Roadmap re-cut P1 local prototype → P2 internet → P3 multi-project
  → P4 phone preview (plan file `actually-my-plan-is-steady-sphinx.md`). **P1 shipped:** `dev:relay` /
  `dev:daemon` npm scripts (tsx), Vite `host:true` for LAN, [RUN-LOCAL.md](RUN-LOCAL.md) phone guide;
  verified stack starts + web serves on the LAN, 139 tests green. **#15 Stages 1–2 shipped:** pairing
  now derives a shared X25519 channel key both sides, and `shared/protocol/seal.ts` provides the AEAD
  `sealEnvelope`/`openEnvelope` (AES-GCM, deviceId AAD, sign-then-encrypt). +9 seal tests → **148/148**,
  typecheck clean. #15 Stage 3 (transport wiring) designed but PAUSED for owner review (security-
  critical live path; key finding: relay is transparent, needs no changes). See
  [notes/issue-15-payload-encryption.md](notes/issue-15-payload-encryption.md).
- 2026-07-03 — **M2 / Phase 2a done: real `ClaudeAgentEngine` behind `IAgentEngine`.** The 0A/0B
  gate that had blocked two phases ran on THIS machine and passed on the first attempt (spike:
  file write via canUseTool, multi-turn, interrupt, resume-with-context). 0B research found the
  licensed path is the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — spawns the local
  `claude` CLI and inherits its login, **no API key**. Engine implemented with an injectable
  `queryFn` (lazy import in prod; scripted fake in tests) that maps `stream_event`/`assistant`/
  `user`/`result` messages to `IAgentEngine` events and bridges `canUseTool` to
  `permission_request`; `resumeConversation` restarts `query({ resume })`. `WCC_ENGINE=claude`
  wired in the daemon entrypoint. 9 new tests, **132/132** across 16 files, typecheck clean.
  ISSUES #4 RESOLVED. See [M2](milestones/M2-real-engine.md) + [task-07 note](notes/task-07-real-engine.md).
- 2026-07-02 — **Plan review: 5 unreasonable points fixed + honest market assessment recorded**
  ([MARKET.md](MARKET.md)). U1: 0A/0B gate un-blocked — this dev machine IS an authed Claude
  machine; real engine is now milestone [M2](milestones/M2-real-engine.md) (Phase 2a, NEXT). U2:
  payload E2E encryption promoted from "stretch" to pre-public-launch requirement, design = X25519
  added to pairing (ISSUES #15). U3: Phase 2 re-cut into 2a engine/2b hardening/2c monetize-with-
  evidence. U4: Phase 3 Cloud Workspaces added (owner's end-goal) with the inverted trust model
  documented honestly. U5: Anthropic ToS risk on commercial subscription piggybacking recorded as a
  hard pre-monetization gate (ISSUES #14). Code fixes: relay production token guard (ISSUES #16),
  JWT aud/iss verification (opt-in), e2e flake #13 poll budget. See PLAN.md "Phases (re-cut)".
- 2026-06-28 — **Phase 1 (M1) multi-tenant shell complete behind seams** (S1.1–S1.5 done; S1.6 = real
  Supabase project = the manual gate). Adds: code-authenticated **pairing protocol** (HKDF→HMAC) in
  `shared/` + HS256 JWT verifier; **relay AuthVerifier** with per-user device isolation (JwtAuthVerifier +
  InMemoryDirectory + InMemoryDaemonTokenStore); **daemon EnrollmentManager** + persistent EnrolledKeyStore
  + DeviceIdentity (replaces static env pubkey, revocable); **web Phase 1 shell** (MockAuthClient, login
  screen, pairing UI, CSP meta, `?phase=1` opt-in route); **Supabase migrations** for devices/workspaces/
  sessions/pairing_codes/browser_keys with RLS. ISSUES #11 (D1 decision: PAKE-lite, not raw ECDH), #12 (gate),
  #13 (e2e flake). **120 tests total** (52 shared / 19 relay / 28 daemon / 16 web / 5 e2e), typecheck clean.
  Live preview verified: ?phase=1 → login → pair → screens render with no CSP / console errors. See
  [task-06 note](notes/task-06-phase-1.md) + [M1 milestone](milestones/M1-multi-tenant-shell.md).
- 2026-06-28 — **Tasks 4 + 5 done → Phase 0 core slice COMPLETE (MockEngine path)**. `web/` React+Vite
  client (identity, signed Connection, SessionModel, full UI) — 6/6 model tests. `packages/e2e` full-stack
  test — 5/5 (happy/deny/interrupt/multi-client-resume/dirty-exit) wiring the REAL web Connection ⇄ relay ⇄
  daemon. **68/68 total tests**, typecheck clean (root + web). LIVE browser verification passed: prompt →
  diff-approval → `greeting.txt` written to disk + streamed → UI idle, no console errors. Added esbuild
  `scripts/bundle.mjs` (dist/relay.mjs + dist/daemon.mjs). Only remaining Phase 0 item = the 0A/0B real
  `ClaudeAgentEngine` gate (needs an authenticated Claude machine). See task-04 + task-05 notes.
- 2026-06-28 — **Task 3 done**: `daemon/` complete (Session, Daemon, DaemonClient, MockEngine,
  SessionStorage, journal, Policy, CommandVerifier, Workspace[Manager]). **19/19 daemon tests**, 57/57
  total, typecheck clean. Integration test proves the slice over real sockets: handshake → signed prompt
  → approve-with-diff → file created + streamed; unsigned & replayed both rejected. Real `ClaudeAgentEngine`
  remains the 0A/0B gate. See [task-03 note](notes/task-03-daemon.md). Starting Task 4 (`web/`).
- 2026-06-28 — **Task 2 done**: `relay/` complete, 10/10 tests, entrypoint runs via tsx. Opaque
  byte-identical forwarding proven. Added ws/esbuild/tsx deps. See [task-02 note](notes/task-02-relay.md).
- 2026-06-28 — **Task 1 done**: `shared/` complete, 28/28 tests green, typecheck clean, dist build works.
  All 6 plan-review corrections applied. Crypto = @noble/ed25519 async (no @noble/hashes). See
  [task-01 note](notes/task-01-shared.md). Starting Task 2 (`relay/`).
- 2026-06-28 — Discovered E: is **exFAT** → dropped npm workspaces, switched to root-node_modules +
  alias resolution (ISSUES #8). git "dubious ownership" fixed (#6). PowerShell flaky → use Bash (#7).
- 2026-06-28 — Task 0 done: scaffold, docs trail, npm-cache→E:, git init.
