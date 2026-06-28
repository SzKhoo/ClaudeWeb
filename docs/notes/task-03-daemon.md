# Task 3 — `packages/daemon` (the security boundary) — ✅ DONE

Date: 2026-06-28. Milestone M0 / Story S3.

## What was built
| File | Purpose |
|------|---------|
| `src/engine/MockEngine.ts` | Deterministic `IAgentEngine` for Phase 0. Parses a write-intent (`create *.txt`), proposes a permission-gated `Write` with a diff, and on approval ACTUALLY writes the file under the workspace root (traversal-guarded). No Claude auth needed. |
| `src/storage/journal.ts` | Append-only journal (source of truth, invariant #3). `InMemoryJournal` (tests) + `FileJournal` (JSONL, survives restart → dirty-exit detection). |
| `src/storage/SessionStorage.ts` | Single owner of session state: assigns the global monotonic `seq`, stamps `tool_stream` offsets, keeps a replay window (N=1000) + per-tool stream windows (M=5 MiB), rebuilds from journal on `load()` and reports dirty (open) turns. |
| `src/policy/Policy.ts` | Default-deny execution control (invariant #4). `manual` default; `auto-edits` auto-approves edit tools but NEVER `Bash`/shell/network; session allow-list; `yolo` opt-in. |
| `src/security/CommandVerifier.ts` | The gate every command passes: structurally-valid envelope → is a command → signed by a PAIRED key → fresh → not replayed. `PairingStore` holds authorized browser pubkeys. Advances the replay guard only AFTER a key matches. |
| `src/workspace/workspace.ts` | `Workspace` (owns its `Policy`, path-allow guard, `toProtocol()`) + `WorkspaceManager` (active/get/switch/list; Phase 0 = one). |
| `src/session/Session.ts` | The turn orchestrator. Translates verified commands → engine actions and engine events → protocol events; permission round-trip with timeout→default-deny; request-driven resume backfill (targeted); dirty-exit recovery → `turn_complete{error}` so the UI unlocks. Never calls up the tree. |
| `src/Daemon.ts` | The security boundary. Owns `WorkspaceManager` + `Session` + `CommandVerifier`. Handles the two inbound frame shapes (bare `ConnHello`→`ConnAck`; signed envelope→verify→`Session`), frames every outbound event as an unsigned envelope ADDRESSED via `clientInstanceId` (`*` or a target). |
| `src/transport/DaemonClient.ts` | Outbound-only WS to the relay: `relay_register` (role daemon), splits relay-local frames from E2E frames, installs/clears the Daemon transport around the socket lifetime, capped exponential-backoff reconnect. |
| `src/index.ts` | Entry point (env config; `WCC_PAIRED_PUBKEY` provisions the browser key; `WCC_ENGINE=claude` is the gated real-engine path, exits until 0A/0B). |
| `test/helpers.ts` | Temp workspaces on E:, async flush/poll utils, signed-command builder. |
| `test/Session.test.ts` | 8 tests: approve→file written, deny, forged-requestId ignored, timeout default-deny, auto-edits auto-approve, interrupt-while-awaiting, resume backfill (targeted), dirty-exit recovery. |
| `test/CommandVerifier.test.ts` | 8 tests: valid, replayed, unsigned, stale, unpaired-key, empty-pairing default-deny, event-not-command, malformed. |
| `test/Daemon.integration.test.ts` | 3 tests over REAL sockets (relay + DaemonClient + a signing FakeBrowser): full handshake→signed prompt→approve-with-diff→file created+streamed; UNSIGNED rejected; REPLAYED approval rejected. |

## Design (honoring the invariants)
- **#1 daemon = boundary / relay = untrusted:** the Daemon verifies every command and never acts on the
  relay's say-so. Outbound events are unsigned but addressed by `clientInstanceId`; the relay broadcasts
  and each browser keeps only `*`/its-own frames. The daemon addresses clients itself.
- **#2 signed + replay-protected commands:** `CommandVerifier` runs the full `@wcc/shared` pipeline
  (signature over canonical bytes incl. `deviceId`/`clientInstanceId`, 60 s freshness, per-(session,client)
  monotonic replay). A forged high-seq message can't poison the guard (replay advances only post-verify).
- **#3 daemon owns sessions, journal = source of truth:** `SessionStorage` is the sole seq authority;
  a dropped browser never stops a turn (DaemonClient clears transport, Session keeps appending);
  `resume` is a pure query over the replay/stream windows (no persisted per-client cursor). A dirty exit
  (open turn in the journal) becomes `turn_complete{error}` on restart.
- **#4 default-deny + policy:** `Policy` prompts for everything by default; `Bash`/shell/network are never
  auto-approved by `auto-edits`. `MockEngine.safeJoin` + `Workspace.isPathAllowed` guard traversal.
  Workspace-switch is a Daemon-level concern (Session is a no-op for it).
- **#5 relay opacity:** the daemon puts the ADDRESSEE in `clientInstanceId` for outbound; the relay still
  routes only by `deviceId`, so this is invisible to it.
- **#6 versioned + capability-negotiated:** `handleHello` runs `isCompatible`/`negotiateVersion`/
  `negotiateCapabilities`; `turn_complete` (per-turn) is distinct from `session_ended`.
- **Forged-permission protection:** a `permission_response` for an unknown `requestId` is ignored — the
  engine is never touched on it (covers a relay fabricating a requestId).

## Verification
- `npm run typecheck` → clean (whole repo).
- Full suite `vitest run` → **57/57** (shared 28, relay 10, daemon 19).
- Daemon-only → **19/19**. The integration test proves the e2e slice's core over real WebSockets:
  handshake, signed prompt, approve-with-diff, **file actually created**, stdout streamed, and that an
  **unsigned** and a **replayed** approval are both rejected by the boundary.

## Deferred to later tasks / gates
- **Real engine (0A/0B gate):** `ClaudeAgentEngine` behind the same `IAgentEngine`; needs an authenticated
  Claude machine. `WCC_ENGINE=claude` is wired to exit until then. Everything else is built/tested on Mock.
- **Runtime bundling:** running `src/index.ts` for the live e2e (Task 5) needs the `@wcc/shared` alias at
  runtime → esbuild bundle (per ISSUES #8). Tests already resolve it via the Vitest alias.
- **Multi-workspace / switch_workspace permission, machine_state heartbeat emission** — Phase 1+.

## Next
Task 4 — `packages/web` (React+Vite): locally-provisioned Ed25519 signing key, WSS to relay,
`relay_register` (browser) + `ConnHello`, streaming transcript + tool cards + diff preview, SIGNED
commands, `clientInstanceId` + `ack`, auto-reconnect + `resume`. Then Task 5 — live e2e against Mock.
