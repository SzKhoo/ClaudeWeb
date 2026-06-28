# Phase 1 — Multi-tenant shell (Stories S1.1 – S1.5) — ✅ done (S1.6 gated)

Date: 2026-06-28. Milestone [M1](../milestones/M1-multi-tenant-shell.md).

## What landed

| Area    | Files                                                                       |
|---------|-----------------------------------------------------------------------------|
| Pairing protocol (shared/) | `pairing/code.ts`, `pairing/hkdf.ts`, `pairing/pairing.ts`, `pairing/jwt.ts` + globals.d.ts |
| Relay authz | `relay/src/auth.ts`, RelayServer auth-verifier integration, env wiring     |
| Daemon enrollment | `security/EnrolledKeyStore.ts`, `PairingCodeStore.ts`, `EnrollmentManager.ts`, `DeviceIdentity.ts`; CommandVerifier extracted `PairingKeyStore` interface; Daemon dispatch + index env wiring |
| Web auth + pairing | `auth-client.ts`, `pairing-flow.ts`, `Phase1Shell.tsx`, `ui/LoginScreen.tsx`, `ui/PairingScreen.tsx`; CSP meta in `index.html`; styles |
| Supabase schema | `supabase/migrations/20260628000001_phase1_init.sql`, `supabase/README.md` |

## Architectural decisions (locked in)

- **D1: PAKE-lite pairing, not raw ECDH** — see [ISSUES #11](../issues/ISSUES.md). The relay threat
  for enrollment is forgery/key-swap, not eavesdropping (keys are public). HKDF(code)→HMAC binds the
  browser's signing pubkey into the enroll request; daemon's ack carries an Ed25519 signature whose
  pubkey the browser already learned from the trusted server directory. Phase 2 swaps in SPAKE2 +
  WebAuthn passkeys without changing the protocol shape.
- **D2: Relay = authenticated + ownership-scoped, still untrusted pipe** — `AuthVerifier` seam +
  `Directory` lookup. Browser JWT → userId; daemon token → {userId, deviceId}. Cross-user routing
  → `forbidden`. Phase 0 shared-token mode preserved for legacy dev path.
- **D3: PairingStore becomes enrolled-key registry** — `EnrolledKeyStore` (persistent, revocable
  records) implements the new `PairingKeyStore` interface so `CommandVerifier` is untouched.

## Tests

- **52 shared tests** (Phase-0 28 + Phase-1 16 pairing + 8 JWT).
- **19 relay tests** (Phase-0 10 + Phase-1 9 auth — JWT happy/forbidden/bad_token, daemon-token-mismatch,
  per-user isolation, legacy shared-token preserved, throws-on-missing-config).
- **28 daemon tests** (Phase-0 19 + Phase-1 9 EnrollmentManager — round-trip + device-signed ack,
  signed-command-verifies-via-enrolled-key, revoke, bad_code/tampered/consumed, idempotent retry,
  expired-code, persist-across-reopen).
- **16 web tests** (Phase-0 6 + Phase-1 10 — MockAuthClient flows, pairing-flow happy/impersonation/
  directory-miss/bad-code/error-type, persistence).
- **5 e2e tests** (unchanged; multi-client-resume note: ISSUES #13 flake under combined load).

`npm test` → 120 tests across 15 files (119 reliably; e2e flake — pass 5/5 in isolation).
`npm run typecheck` (root + web) → clean.

## Live preview verification

`?phase=1` switches the web app into the new shell:
- LoginScreen renders (dark theme, dev defaults visible) → no CSP / console errors.
- Sign-in with `alice@example.com` / `alice-pw` → MockAuthClient mints an HS256 JWT (verifiable with
  `RELAY_JWT_SECRET=phase-1-dev-jwt-secret-32-bytes!`), persists to localStorage.
- PairingScreen renders with the entry field, daemon instructions, and a collapsible reveal of the
  browser pubkey.
- CSP header in `index.html` is active and blocks inline scripts / eval; Vite HMR + styles continue
  to work (style-src 'unsafe-inline' is the Phase-1 dev compromise — see file comment).

## Single remaining manual gate: S1.6

Documented in [supabase/README.md](../../supabase/README.md). Provision a real Supabase project via the
MCP tools (`apply_migration`, `generate_typescript_types`, `get_publishable_keys`); replace
`InMemoryDirectory` + `InMemoryDaemonTokenStore` (relay) + `MockAuthClient` (web) with Supabase-backed
impls; validate cross-user isolation live with two real accounts.

## Bug found + fixed in this story

- `Phase1Shell` initial subscribe callback captured a stale `identity` from closure (null at
  subscribe-time) → sign-in succeeded but UI didn't advance. Fixed by tracking identity via
  `useRef` so the callback always sees the current value. Caught during live preview validation.

## Next

S1.6 manual gate (when an authenticated Claude machine + a fresh Supabase project are available).
Phase 1 protocol + UI are otherwise feature-complete behind the seams.
