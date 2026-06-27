# ISSUES — open landmines & decisions

Format: `#id [state] title` — newest first. States: OPEN / RESOLVED / WONTFIX / WATCH.

## Environment
- **#1 [WATCH] C: drive nearly full (~0.1 GB).** npm cache + TEMP redirected to E:. If any install fails
  with ENOSPC, check that `npm config get cache` is on E: and that `$env:TEMP` is set to E: for that shell.
- **#2 [WATCH] Docker daemon may not be running.** Installed at C:\Program Files\Docker. Phase 0 avoids
  Docker (local Node processes). If/when relay containerization is needed, start Docker Desktop first.
- **#6 [RESOLVED] git "dubious ownership" on E:.** E: filesystem does not record ownership. Fixed once with
  `git config --global --add safe.directory E:/StorageContent/Personal/WebClaudeCode`.
- **#7 [WATCH] PowerShell spawns can fail with "paging file is too small".** Because the Windows pagefile
  lives on the nearly-full C:, launching a fresh .NET PowerShell sometimes fails. **Prefer the Bash tool
  (Git Bash, no .NET) for shell ops.** Path mapping: `E:\...` → `/e/...`.
- **#8 [RESOLVED-by-design] E: is exFAT — NO symlinks/junctions.** `npm`/`pnpm` **workspaces** fail here
  (`EISDIR ... symlink`). Architecture decision: **no workspaces.** Single root `node_modules` (regular
  deps extract as real dirs — fine on exFAT). Cross-package imports resolve via **aliases**:
  - typecheck/editor → tsconfig `paths` (`@wcc/shared` → `packages/shared/src/index.ts`) in tsconfig.base.json.
  - tests → Vitest `resolve.alias` (root `vitest.config.ts`).
  - runtime (relay/daemon) → esbuild bundle with alias (inlines `@wcc/shared`; external npm deps stay in root node_modules).
  - web → Vite `resolve.alias`.
  **Never reintroduce a `workspaces` field or pnpm.** All deps live in the ROOT `package.json`.

## Tooling
- **#9 [DEFERRED] npm audit: 5 findings, all in the vitest→vite→esbuild DEV chain** (esbuild dev-server
  advisory GHSA-67mh-4wv8-2f99, ≤0.24.2). Dev-only, dev-server-only — NOT in shipped runtime. Our direct
  `esbuild` 0.28.1 (used for bundling) is unaffected. Clean fix = bump to `vitest@4` (breaking). Defer to
  Phase 2 hardening; our tests use only stable describe/it/expect + defineConfig alias, so the v4 bump
  should be low-risk when we take it.

## Design watches (from plan review)
- **#3 [WATCH] Clock-window replay defense assumes loosely-synced clocks (NTP).** If real skew appears,
  add a handshake clock-offset exchange. MAX_CLOCK_SKEW_MS = 60000.
- **#4 [OPEN] 0A/0B gate.** Real Agent SDK engine (subscription auth, canUseTool, interrupt, resume/
  compaction) is unverified until run on an authenticated Claude machine. S1–S2 + most of S3 proceed
  behind a MockEngine; the real engine is slotted in at S3 and validated at 0A.
- **#5 [WATCH] In-flight-turn resume across daemon restart is NOT recoverable** — conversation-resume
  only. Daemon restart mid-turn must emit turn_complete{error} so the UI unlocks. Set expectations in UI.

## Resolved
- (none yet)
