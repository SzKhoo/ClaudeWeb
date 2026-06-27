# Task 1 — `packages/shared` (protocol + crypto + engine contract) — ✅ DONE

Date: 2026-06-28. Milestone M0 / Story S1.

## What was built
The wire-protocol + crypto + engine-seam layer every other package depends on. Files:

| File | Purpose |
|------|---------|
| `src/protocol/version.ts` | `PROTOCOL_VERSION`, **numeric** semver compare, `isCompatible`, `ConnHello`/`ConnAck`, capability negotiation |
| `src/protocol/envelope.ts` | `TransportEnvelope` (routing + integrity metadata), `newEnvelope()`, `isTransportEnvelope()` guard |
| `src/protocol/messages.ts` | `ApplicationCommand` union (client→daemon) + `ApplicationEvent` union (daemon→client); `Workspace`/`ExecutionMode`/`MachineState`; `isCommand`/`isEvent`/`requiresSignature` |
| `src/protocol/canonical.ts` | deterministic `canonicalize()` + `toCanonicalBytes()` over a fixed `signableView` |
| `src/protocol/sign.ts` | Ed25519 `signEnvelope`/`verifyEnvelope`, `ReplayGuard`, base64url, `MAX_CLOCK_SKEW_MS=60000` |
| `src/engine/IAgentEngine.ts` | the daemon↔runtime seam: `connect/send/approveTool/denyTool/interrupt/resumeConversation/onEvent/onPermissionRequest/dispose` |
| `src/index.ts` | barrel |
| `test/{version,canonical,sign}.test.ts` | 28 tests |

## The 6 plan-review corrections — all applied + tested
1. **Numeric semver** — `compareSemVer` parses the triple; `"1.10.0" > "1.9.0"` is true. (`version.test.ts`)
2. **Routing fields signed** — canonical `signableView` includes `deviceId`(d) + `clientInstanceId`(c); a retarget at the relay fails verification. (`sign.test.ts` "RETARGETED")
3. **No `JSON.stringify` for canonical** — custom walker emits keys in explicit code-unit sort; integer-like keys ("1","10","2") don't reorder numerically. (`canonical.test.ts`)
4. **Replay = per-(session,client) monotonic seq** — `ReplayGuard` rejects `seq <= lastSeen`, O(1) state; independent per client; not poisoned by a forged high-seq (advances only after valid sig). (`sign.test.ts`)
5. **Two "resume"s disambiguated** — engine `resumeConversation(checkpoint)` (IAgentEngine) vs transport `CmdResume{sinceSeq,toolStreamOffsets}` (messages.ts).
6. **Clock-window assumption documented** — `MAX_CLOCK_SKEW_MS`, NTP assumption noted in sign.ts + ISSUES #3.

## Verification
- `npm run typecheck` → clean (exit 0).
- `npm test` → **28/28 pass** (version 6, canonical 10, sign 12).
- `tsc -p packages/shared/tsconfig.build.json` → emits `dist/` with `.d.ts` (build config works).

## Key engineering decisions (so future-me doesn't re-litigate)
- **Crypto:** `@noble/ed25519@2.3.0` **async API only** — `signAsync`/`verifyAsync`/`getPublicKeyAsync`.
  Its SHA-512 comes from WebCrypto `crypto.subtle.digest` (universal in Node + browsers), so **no hash
  wiring and no `@noble/hashes` dependency** (removed). Same lib both ends ⇒ signatures interoperate.
- **Why @noble not WebCrypto-Ed25519:** Ed25519 in WebCrypto isn't universal across browsers yet; @noble
  works everywhere and is deterministic/interoperable.
- **All commands require a signature** (`requiresSignature` = true for every command type); events never.
- **base64url** via `btoa`/`atob` (present in Node 18+ and browsers) — no Buffer (browser-safe).

## exFAT structural rules in force (see ISSUES #8)
- No workspaces. All deps in ROOT `package.json`. `@wcc/shared` resolves via alias: tsconfig `paths`
  (typecheck), `vitest.config.ts` `resolve.alias` (tests), esbuild/Vite later (runtime/web).

## Next
Task 2 — `packages/relay` (deviceId-routed untrusted WS pipe). Needs `ws` + `esbuild` added to root deps.
