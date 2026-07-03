# ISSUES #15 — payload E2E encryption: staged plan + Stage 3 design

Goal: the relay must become a **blind pipe** — unable to read prompts, diffs, or file bytes — before
any public multi-tenant exposure. "Sign now, encrypt later"; this is the "later".

## Status

| Stage | What | State |
|---|---|---|
| **1** | Pairing carries an ephemeral **X25519** pubkey each way; both sides ECDH→HKDF a shared 32-byte channel key. Daemon persists it on the enrolled record; browser stores it with the pairing. Integrity inherited from #11 (HMAC over request, Ed25519 over ack). Backward compatible. | ✅ DONE (`x25519.ts`, `pairing.ts`, `EnrollmentManager.ts`, `pairing-flow.ts`, `EnrolledKeyStore.ts`; tests in `x25519.test.ts`) |
| **2** | **AEAD seal primitive** `shared/protocol/seal.ts`: `sealEnvelope`/`openEnvelope` wrap a signed `TransportEnvelope` in an `EncryptedFrame` (AES-GCM under the channel key; `deviceId` cleartext + bound as AAD). Sign-then-encrypt; the existing verify/replay pipeline runs unchanged on the opened inner envelope. | ✅ DONE (`seal.ts`; 9 tests in `seal.test.ts`) |
| **3** | **Transport wiring** — seal on send, open on receive, at both edges; the relay then forwards ciphertext. | 📋 DESIGNED (this note) — **needs owner review before landing** (security-critical live path; two real design forks below) |

## Key finding that simplifies Stage 3

**The relay never parses application frames.** `RelayServer` routes by the *socket's registered
deviceId* (set at `relay_register` handshake), and `forward()` sends raw bytes verbatim
(`RelayServer.ts` `onMessage`→`routeBrowserToDaemon`/`routeDaemonToBrowsers`→`forward`). So:
- Encryption is **invisible to the relay** — no relay code changes at all.
- The `deviceId` inside the `EncryptedFrame` isn't even a routing dependency; we keep it only as the
  AES-GCM AAD (binds a ciphertext to its device so it can't be retargeted).

## Wiring points (both are the same two functions per side)

- **Web** (`packages/web/src/protocol-client.ts`): seal outbound `TransportEnvelope`s before `ws.send`;
  on inbound, if `isEncryptedFrame` → `openEnvelope` before the normal parse. Channel key = the paired
  `PairingResult.channelKey` for this device.
- **Daemon** (`packages/daemon/src/Daemon.ts` + the `setTransport` sender installed by
  `DaemonClient`): open inbound encrypted frames before `handleInbound` logic; seal outbound events
  before handing bytes to the transport.

## Design forks — DECISIONS NEEDED (recommended defaults marked ★)

**D1 — how does the daemon pick the channel key to decrypt an inbound frame?**
An `EncryptedFrame` hides `sessionId`/`clientInstanceId`, so the daemon can't see which enrolled
browser sent it before decrypting.
- (a) Try every enrolled key until one AEAD-authenticates. Fine for a personal tool (≤ a few keys), O(keys)/msg.
- ★ (b) Add a cleartext `kid` (enrolled keyId) hint to `EncryptedFrame`; daemon looks up the key O(1).
  Bind `kid` into the AAD alongside `deviceId`. Leak = an opaque key id (not content). Cleaner; also
  gives the daemon the session→key association for outbound.

**D2 — daemon→browser is a broadcast; per-browser keys don't fit one frame.**
The relay broadcasts a daemon frame to *all* browsers on the device, but each browser has its own
channel key.
- ★ (a) Single-active-browser assumption (true for personal use): the daemon seals each session's
  events with the channel key of the browser that *owns* that session (captured from the first
  verified command's `kid`). Other connected browsers simply fail to open and drop the frame —
  acceptable degradation; revisit for real multi-browser.
- (b) Per-session shared key (larger change; defer).

**D3 — handshake + pre-session frames stay cleartext.**
`ConnHello`/`ConnAck` (version + capability negotiation) and the pre-session pairing frames carry no
secrets. Leave them plaintext. Add an `encrypt` **capability**; encryption applies only to
post-handshake `TransportEnvelope`s when a channel key exists.

**D4 — sign-then-encrypt (already how `seal.ts` works).** Sign plaintext → seal. Open → verify.
Replay/freshness/`ReplayGuard` unchanged; they operate on the decrypted inner envelope.

**D5 — downgrade protection (security-critical).** A malicious relay must not be able to strip
encryption and force plaintext. Rule: **if an enrolled key has a `channelKey`, the daemon REQUIRES
encryption from it** — a plaintext signed command arriving for an encryption-capable enrolled key is
rejected, not accepted. (Static `WCC_PAIRED_PUBKEY` Phase-0 keys have no channel key and stay
plaintext — that path is local-only and never public.)

## Rollout / backward-compat

- Encryption is opt-in via the `encrypt` capability AND presence of a channel key. Phase-0 static
  pairing (no channel key) and existing tests keep working unchanged.
- The e2e slice should gain an *encrypted* variant asserting (a) the bytes the relay forwards contain
  no plaintext marker, (b) the full flow still works (create→approve→file→resume).

## Stage 3 test plan (all mock-validatable, no external services)

1. Unit: daemon resolves the right key by `kid`; wrong/absent `kid` → rejected (D1/D5).
2. Unit: encryption-capable enrolled key sending plaintext → rejected (D5 downgrade guard).
3. e2e: negotiate `encrypt`; capture relay-forwarded frames; assert no plaintext prompt/diff; assert
   session behaves identically to the plaintext slice.

## Why this is paused for review

Stages 1–2 are pure, tested, and safe (no live-path behavior change — the relay still forwards
plaintext today). Stage 3 changes the live message path and encodes the D1/D2/D5 security decisions.
Those decisions (esp. the multi-browser degradation D2 and the downgrade-rejection D5) should get an
explicit owner sign-off before landing, since getting them wrong silently weakens confidentiality.
