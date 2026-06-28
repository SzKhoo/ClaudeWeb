# Milestone M1 — Multi-tenant shell (Phase 1)

**Goal:** Turn the single-machine Phase-0 slice into a multi-tenant product shell. Accounts (Supabase
Auth), a device/workspace registry (Supabase Postgres + RLS), a **secure browser-key enrollment**
(pairing) flow that replaces Phase 0's static `WCC_PAIRED_PUBKEY`, **relay authorization** that routes
only within a user's own devices (cross-user rejection), and a **strict CSP** on the web app.

**Strategy (mirrors Phase 0's MockEngine gate):** Supabase is an external cloud dependency. Build ALL
logic behind seams and test it locally; the *real Supabase project* is the manual gate (like 0A/0B),
documented in `docs/issues/ISSUES.md`. The relay's auth verifier, the directory lookups, and the web
auth client are all interfaces with in-memory impls for tests and a Supabase impl flipped on at the gate.

## Architectural decisions (locked)

### D1 — Pairing = code-authenticated enrollment, not raw ECDH (see ISSUES #11)
The plan said "Pairing = ECDH key exchange". On implementation review: the relay threat for enrollment
is **forgery / key-swap**, not eavesdropping (the keys exchanged are *public*). A Diffie-Hellman shared
secret would buy confidentiality we don't need and still require an out-of-band authenticator to stop a
MITM. So Phase 1 uses a **PAKE-lite**: a short, one-shot, TTL-bounded **pairing code** shown on the
trusted daemon machine, used to derive an HMAC key (HKDF) that **binds** the browser's signing pubkey in
the enroll request. The relay, lacking the code, can neither forge nor swap the enrolled key. The daemon
confirms with an **Ed25519 signature over its device key**, whose pubkey the browser learned from the
*trusted server directory* (not the relay) — so a relay impostor can't complete the handshake either.
Phase 2 upgrades this to SPAKE2 + WebAuthn passkeys (no protocol-shape change for callers). No new crypto
dependency (WebCrypto HMAC/HKDF + the existing Ed25519), which matters: C: is full, installs are risky (#1).

### D2 — Relay stays an untrusted pipe, but now *authenticated* and *ownership-scoped*
The relay gains a pluggable `AuthVerifier`: a browser proves identity with a Supabase JWT → `userId`; a
daemon proves identity with a device token → `{userId, deviceId}`. A browser may only register/route to a
deviceId its **own** user owns (directory lookup). Cross-user routing is rejected (`forbidden`). The relay
still never parses application payloads, holds no session content, and routes by deviceId only — it just
refuses to *connect* peers that aren't authenticated and co-owned. Phase 0's shared-token mode remains for
local dev (used when no `AuthVerifier` is injected).

### D3 — PairingStore becomes an enrolled-key registry
Phase 0's flat pubkey list becomes records `{ keyId, pubkey, label, enrolledAt, revoked }` — revocable,
labelled, persisted. An `EnrollmentManager` processes `enroll_request` pairing frames (pre-session,
relay-forwarded), verifies the code-HMAC, adds the key, and emits a device-signed `enroll_ack`.

## Stories
### S1.1 — Supabase data model (schema + RLS)  ← migrations only; real project = gate
- [ ] `supabase/migrations/*.sql`: `devices`, `workspaces`, `sessions`, `pairing_codes`, `browser_keys`.
- [ ] Row-Level Security: every table scoped to `auth.uid()`; daemon writes via service role / device token.
- [ ] `generate types` step documented (the real run is the gate).

### S1.2 — Pairing / enrollment protocol (shared/)  ← fully unit-tested, no cloud
- [ ] `pairing/pairing.ts`: code gen (Crockford base32), HKDF→HMAC tag, build/verify enroll_request + enroll_ack.
- [ ] `pairing/jwt.ts`: HS256 sign (tests) + verify (relay) with exp/nbf checks.
- [ ] tests: tamper/forge/replay/expired-code/wrong-code/swapped-pubkey rejection; happy round trip; JWT valid/expired/forged.

### S1.3 — Relay authorization (per-user device isolation)  ← tested with local JWTs
- [ ] `relay/auth.ts`: `AuthVerifier`, `Directory`, `JwtAuthVerifier`, `InMemoryDirectory`.
- [ ] `RelayServer` enforces verifier when injected; cross-user register/route → `forbidden`.
- [ ] tests: browser JWT→userId; daemon token→device; same-user routes; cross-user rejected; bad JWT rejected; legacy shared-token mode still works.

### S1.4 — Daemon enrollment wiring  ← tested
- [ ] `EnrollmentManager` + enrolled-key `PairingStore`; `enroll_request`→`enroll_ack`; revoke.
- [ ] `Daemon` handles pairing frames pre-session; persists enrolled keys (file).
- [ ] tests: enroll → signed command now verifies; wrong code rejected; revoke → command rejected; replay of enroll rejected.

### S1.5 — Web: auth + pairing UI + CSP
- [ ] `auth-client.ts` seam (Supabase impl + mock); login screen; device/workspace picker; pairing UI (enter code).
- [ ] Strict CSP (no inline script, no eval; connect-src = relay + supabase) — meta + documented header.
- [ ] tests: auth-client mock flows; pairing reducer.

### S1.6 — Supabase integration gate (manual)
- [ ] Provision the real project (via Supabase MCP or dashboard), apply migrations, wire JWT secret + URL/anon key.
- [ ] Validate login → pair → drive a session end-to-end across two users (cross-user isolation holds live).

## Done =
A second user cannot see or route to the first user's device (relay rejects). A browser enrolls to a
daemon via a one-shot code over the untrusted relay; a relay that forges/swaps the enrolled key is
rejected; the enrolled browser then drives a signed session exactly as in Phase 0. Strict CSP active.
Real-Supabase wiring is the single remaining manual gate (S1.6).
