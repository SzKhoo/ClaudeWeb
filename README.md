# WebClaudeCode (codename: ClaudeBridge)

Drive the **real Claude Code running on your own machine** from a browser, anywhere — as long as your
PC is powered on. Not a sandbox (claude.ai/code) and not Dispatch; the actual Claude Code feel, web-delivered.

```
Browser ⇄ WSS ⇄ Relay ⇄ WSS ⇄ Daemon (your PC) ⇄ Claude Agent SDK ⇄ Claude
(web UI)      (routes by       (security          (your own subscription)
               deviceId only)   boundary)
```

- **Relay** is an untrusted dumb pipe (routes by `deviceId`, holds no session content).
- **Daemon** is the security boundary (enforces all policy, verifies every human-origin message).
- Human-origin messages (prompt, approval) are **E2E-signed with replay protection** — a compromised
  relay can DoS but cannot forge or replay your prompts/approvals.

## Packages
| Package | Role |
|---------|------|
| `@wcc/shared` | Protocol types, canonical serialization, sign/verify+replay, `IAgentEngine` contract |
| `@wcc/relay`  | WebSocket hub; routes by `deviceId`; zero session-content state |
| `@wcc/daemon` | Runs on the user's PC; sessions, storage, engine, policy |
| `@wcc/web`    | React+Vite UI: streaming chat, tool-approval + diff, signed commands |

## Dev
```bash
npm install        # cache + temp are pinned to E:
npm test           # all packages
npm run typecheck
npm run build
```

## Project docs
- [docs/PROGRESS.md](docs/PROGRESS.md) — **start here** (status board + how to resume)
- [docs/PLAN.md](docs/PLAN.md) — full architecture + invariants
- [docs/milestones/](docs/milestones/) — milestone/story breakdown
- [docs/issues/ISSUES.md](docs/issues/ISSUES.md) — open landmines
- [docs/notes/](docs/notes/) — per-task completion notes

## Status
Phase 0 (core slice). See the status board in [docs/PROGRESS.md](docs/PROGRESS.md).
