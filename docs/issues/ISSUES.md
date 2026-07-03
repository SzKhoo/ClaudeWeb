# ISSUES — open landmines & decisions

Format: `#id [state] title` — newest first. States: OPEN / RESOLVED / WONTFIX / WATCH.

## Environment
- **#1 [WATCH] C: drive nearly full (~0.1 GB).** npm cache + TEMP redirected to E:. If any install fails
  with ENOSPC, check that `npm config get cache` is on E: and that `$env:TEMP` is set to E: for that shell.
- **#10 [WATCH] Preview tooling is sandboxed to the harness working dir `D:\Qynix\LamResearch`.** It reads
  THAT project's `.claude/launch.json` and rejects a `cwd` outside it — so the E: Vite dev server is launched
  via a `web` config there that calls `node <E:>/node_modules/vite/bin/vite.js --config <E:>/packages/web/vite.config.ts`
  (absolute paths; the vite config sets root + `@wcc/shared` alias via `import.meta.url`, so cwd is irrelevant).
  The E: project also keeps its own `.claude/launch.json` for when run natively from E:.
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
- **#4 [RESOLVED 2026-07-03] 0A/0B gate PASSED.** 2026-07-02 plan review (U1) unblocked it; the
  spike ran on THIS machine on 2026-07-03 and every leg passed (canUseTool round-trip → file
  written; multi-turn; interrupt; resume-with-context-preserved). The licensed path turned out to
  be the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode),
  which spawns the locally-installed `claude` CLI and inherits its login — no API key. Real engine
  landed as `ClaudeAgentEngine` behind the existing `IAgentEngine`. See
  [task-07 note](../notes/task-07-real-engine.md) and [M2 milestone](../milestones/M2-real-engine.md).
  One finding worth flagging: after `interrupt()` the SDK still emits a `result` for the turn — the
  engine remaps it to `turn_complete { status: "interrupted" }`.
- **#5 [WATCH] In-flight-turn resume across daemon restart is NOT recoverable** — conversation-resume
  only. Daemon restart mid-turn must emit turn_complete{error} so the UI unlocks. Set expectations in UI.

## Phase 1 decisions
- **#11 [DECISION] Pairing = code-authenticated enrollment (PAKE-lite), NOT raw ECDH.** Plan said ECDH;
  on review, the relay threat for enrollment is forgery/key-swap, not eavesdropping (the keys are
  *public*). DH would buy confidentiality we don't need and still need an out-of-band authenticator.
  So Phase 1 uses a one-shot, TTL-bounded pairing code (shown on the trusted daemon machine) → HKDF →
  HMAC over the browser's signing pubkey. Relay lacking the code cannot forge or swap the enrolled
  key. Daemon confirms with an Ed25519 signature using a device key whose pubkey the browser learned
  from the **trusted server directory** (Supabase, not the relay). Phase 2 upgrades to SPAKE2 + WebAuthn
  passkeys without changing the protocol shape. **No new crypto dependency** (WebCrypto HMAC/HKDF +
  existing @noble/ed25519) — keeps installs minimal given C: is full (#1).
  *2026-07-02 amendments:* (a) the "ECDH unnecessary" half is superseded for Phase 2b — X25519 gets
  ADDED to pairing to derive a channel key for payload encryption (see #15); the code-HMAC
  authentication half stands. (b) `WCC_PRINT_PAIRING_CODE` prints the raw code to stdout — DEV-ONLY
  convenience; the production pairing UX must mint codes via the pair CLI/UI, never into logs.
- **#12 [GATE] Real Supabase project = Phase-1 0A/0B-equivalent.** All Phase-1 logic ships behind
  seams (AuthVerifier, Directory, AuthClient) with in-memory impls for tests. Provisioning the real
  Supabase project + flipping the seam impls is the single manual gate; documented in M1 doc S1.6.

## Phase 1 watches
- **#13 [RESOLVED 2026-07-02] e2e multi-client-resume flake.** TWO causes, found while fixing:
  (a) the poll condition fired on the FIRST backfilled tool item — mid-replay, when the view state
  is legitimately still "tool-running" until the final session_status snapshot lands → intermittent
  `expected 'tool-running' to be 'idle'`; (b) under full-suite load the 600-attempt budget (~10s
  effective) could elapse before backfill. Fixed: poll the TERMINAL condition (tool item AND state
  idle) with a 3000-attempt (~15s) budget. Product behavior was correct throughout — the backfill
  always converges to idle; the test asserted too early. Verified over repeated full-suite runs.
  *Related environmental find:* rare "Worker exited unexpectedly" from vitest's fork pool — this
  machine's pagefile is on the nearly-full C: (#7), and a CPU-count worker fleet can get one process
  killed under memory pressure. Mitigated: `vitest.config.ts` caps the pool (`maxForks: 4`).
  17/18 subsequent full-suite runs clean, incl. 10 consecutive; residual rarity is machine, not code.

## Business / product risks (from 2026-07-02 plan review — see docs/MARKET.md)
- **#14 [WATCH-BUSINESS] Anthropic ToS on commercial subscription piggybacking.** Personal use
  (remote-controlling YOUR OWN machine's Claude Code) is fine. A *commercial hosted product* whose
  value rides on customers' consumer Claude subscriptions is a gray zone Anthropic can close.
  **Hard gate: verify the current third-party / subscription-auth policy BEFORE any Phase-2c
  monetization work.** Also constrains the engine impl choice (#4).
- **#15 [IN-PROGRESS] Payload E2E encryption = pre-public-launch REQUIREMENT (was "Phase 2 stretch").**
  The relay currently CAN read all session content (prompts, diffs, file text) even though it
  forwards opaquely. Fine for a personal tool; unacceptable for multi-tenant strangers' code.
  Design (locked): extend pairing with **X25519** — the code-HMAC still authenticates the exchange
  (keeps #11's insight), the ECDH output becomes the session channel key ⇒ authenticated key
  exchange, relay becomes truly blind. Lands in Phase 2b, BEFORE any public multi-tenant exposure.
  *Progress (2026-07-04):* **Stage 1** (pairing X25519 → shared channel key on both sides) and
  **Stage 2** (AEAD seal primitive `shared/protocol/seal.ts`, `sealEnvelope`/`openEnvelope`) are DONE
  and tested (9 seal tests). **Stage 3** (wire seal/open into the transports so the relay forwards
  ciphertext) is designed but PAUSED for owner review — it changes the live message path and encodes
  security decisions (key-selection by `kid`, single-active-browser broadcast degradation, and a
  downgrade-rejection rule). Full plan + decisions: [notes/issue-15-payload-encryption.md](../notes/issue-15-payload-encryption.md).
  Key finding: the relay never parses frames (routes by socket-registered deviceId), so Stage 3 needs
  NO relay changes.
- **#16 [RESOLVED 2026-07-02] Relay silently fell back to the insecure dev token in production.**
  `packages/relay/src/index.ts` used `dev-relay-token` with only a console warning when RELAY_TOKEN
  was unset — a prod-deploy footgun. Fixed: when `NODE_ENV=production`, the relay now hard-exits
  with a clear error unless `RELAY_JWT_SECRET` or an explicit `RELAY_TOKEN` is set. Dev unchanged.

## Resolved
- #13 (e2e flake — poll budget), #16 (relay prod token guard). Details in-place above.
