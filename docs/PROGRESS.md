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
| 0B | Engine specifics (auth, canUseTool, Stop hook, interrupt, resume/compaction) | TODO |
| 0A | [GATE] Runtime spike over external transport | TODO (needs authed Claude machine) |
| 2 | `relay/` deviceId-routed WS hub | **DONE** (10/10 tests; entrypoint runs) |
| 3 | `daemon/` sessions/storage/engine/policy | IN PROGRESS |
| 4 | `web/` UI | TODO |
| 5 | End-to-end manual verification | TODO |

## How to resume
1. Read this file's Status board.
2. Read the latest `docs/notes/task-*.md` for the task marked IN PROGRESS.
3. Read `docs/issues/ISSUES.md` for open landmines.
4. Continue from the first TODO/unchecked item.

## Commands
- Install: `npm install` (from repo root; cache+temp already on E:).
- Test all: `npm test`. Test one pkg: `npm test -w @wcc/shared`.
- Typecheck: `npm run typecheck`.
- Build all: `npm run build`.

## Changelog (newest first)
- 2026-06-28 — **Task 2 done**: `relay/` complete, 10/10 tests, entrypoint runs via tsx. Opaque
  byte-identical forwarding proven. Added ws/esbuild/tsx deps. See [task-02 note](notes/task-02-relay.md).
- 2026-06-28 — **Task 1 done**: `shared/` complete, 28/28 tests green, typecheck clean, dist build works.
  All 6 plan-review corrections applied. Crypto = @noble/ed25519 async (no @noble/hashes). See
  [task-01 note](notes/task-01-shared.md). Starting Task 2 (`relay/`).
- 2026-06-28 — Discovered E: is **exFAT** → dropped npm workspaces, switched to root-node_modules +
  alias resolution (ISSUES #8). git "dubious ownership" fixed (#6). PowerShell flaky → use Bash (#7).
- 2026-06-28 — Task 0 done: scaffold, docs trail, npm-cache→E:, git init.
