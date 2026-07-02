# Plan: Web-hosted Claude Code ("remote-control your own machine from the browser")

> Working codename: **ClaudeBridge**. Greenfield repo at `E:\StorageContent\Personal\WebClaudeCode`.

## Context
A subscriber opens a website, logs in, and — as long as their own laptop/PC is powered on — drives the
**real Claude Code running on their own machine** from anywhere. `claude.ai/code` runs in Anthropic's
sandbox; Dispatch isn't the Claude Code feel. Product = "a web UI with the real Claude Code feel that
drives Claude Code on the user's *own* powered-on machine."

**Decisions:** multi-tenant product; live interactive session (stream + tool-approval); north star =
remote-control app, seams only (Claude-only, future-proof via `IAgentEngine`, layered protocol,
`deviceId` routing, capability discovery); engine behind `IAgentEngine`; stack = Supabase + dedicated WS
relay (hybrid); prove the core slice first; control-channel trust = "sign now, encrypt later"
**(AMENDED 2026-07-02: "later" = before any public multi-tenant launch, not open-ended — see
ISSUES #15 and the Phase 2b entry below)**.

> **2026-07-02 plan review** (see [MARKET.md](./MARKET.md) for the honest market assessment):
> five unreasonable points fixed — U1 gate reorder, U2 encryption reclassification, U3 Phase-2
> re-cut, U4 Phase-3 cloud added with corrected trust model, U5 ToS risk recorded (ISSUES #14).

**Non-goals (seams reserved, do NOT build now):** multi-engine AgentHost, plugin manager, extra
transports (WebRTC/IPC/SSH), multi-region relays, Routines/scheduling.

## Architectural invariants (do not violate)
1. **Daemon = security boundary; relay = UNTRUSTED pipe.** Daemon enforces all policy; never executes on relay's say-so.
2. **Human-origin messages are E2E-signed with replay protection** (`user_message`, `permission_response`, `policy_update`, workspace-switch). Canonical bytes include `timestamp` + `seq`-as-nonce; daemon rejects >60s stale or re-used nonce. Relay can DoS but cannot forge/replay.
3. **Daemon owns sessions and is buffer-of-record.** A dropped browser WS never stops a running tool. Append-only journal is source of truth; in-memory windows serve replay; relay holds no session content.
4. **Default-deny execution + daemon-side policy** (workspace allowlist, no auto-approve Bash, session-scoped allow-lists, diff-preview-before-approval, workspace-switch as its own permission).
5. **Relay routes by `deviceId` ONLY.** `sessionId`/`clientInstanceId` are end-to-end, opaque to the relay.
6. **Versioned + capability-negotiated protocol; `turn_complete` ≠ `session_ended`.**
7. **Device holds long-term identity; browser keys are enrolled, revocable credentials** (WebAuthn passkeys in P1+).

## shared/ design (Task 1)
```
shared/src/
  protocol/version.ts     # PROTOCOL_VERSION, min/max compat, ConnHello{daemonVersion, capabilities[]}, ConnAck
  protocol/envelope.ts    # TransportEnvelope{protocolVersion,deviceId,sessionId,clientInstanceId,seq,timestamp,ack?,sig?,payload}
  protocol/messages.ts    # ApplicationMessage: Command | Event; Workspace, ExecutionMode, MachineState
  protocol/canonical.ts   # deterministic bytes over (deviceId, clientInstanceId, sessionId, seq, timestamp, type, payload)
  protocol/sign.ts        # sign()/verify() Ed25519; verify enforces 60s window + monotonic seq replay reject
  engine/IAgentEngine.ts  # connect/send/approveTool/denyTool/interrupt/resumeConversation/onEvent/dispose
shared/test/canonical.test.ts  # stable bytes
shared/test/sign.test.ts       # valid + FORGED + UNSIGNED + STALE(>60s) + REPLAYED-seq rejection vectors
```

### Task 1 corrections (MUST apply — found in review of drafted code)
1. **Semver compare numerically** — not string `>=`.
2. **Sign the routing-security fields** — canonical bytes include `clientInstanceId` + `deviceId`.
3. **Don't trust `JSON.stringify` as canonical** — sort `[key,value]` pairs recursively, stable number/format handling.
4. **Replay dedup = per-(sessionId, clientInstanceId) monotonic seq** (reject `seq ≤ lastSeen`), not unbounded `Set<nonce>`.
5. **Disambiguate two "resume"s** — engine `resumeConversation(checkpoint)` vs transport `resume{sinceSeq,toolStreamOffsets}`.
6. **Clock-window assumes loosely-synced clocks (NTP)** — documented assumption.

## Phases (re-cut 2026-07-02 — U1/U2/U3/U4)
- **Phase 0 — core slice: ✅ DONE (MockEngine path).** 1 shared/, 2 relay/, 3 daemon/, 4 web/, 5 e2e.
  No accounts; locally-provisioned keypair; env pairing.
- **Phase 1 — multi-tenant shell: ✅ DONE behind seams (S1.6 Supabase gate pending).** Supabase
  Auth + Postgres registry (migrations written); pairing = code-authenticated enrollment (PAKE-lite,
  ISSUES #11 — passkeys deferred to P2b); relay authz w/ per-user device isolation; strict CSP.
- **Phase 2a — REAL ENGINE + dogfood (M2, NEXT — this was the inverted gate, U1):**
  - **0B engine specifics:** subscription auth reality check — Anthropic constrains third-party use
    of subscription/OAuth auth via the Agent SDK; on the user's OWN machine the licensed path is the
    installed `claude` CLI itself (spawn with `--input-format stream-json --output-format
    stream-json`), which uses whatever auth the user already set up. Lock `ClaudeAgentEngine` impl
    choice (CLI stream-json vs Agent SDK) from this, not from assumption.
  - **0A runtime spike [GATE]:** long-lived interactive session w/ streaming + canUseTool approval +
    interrupt + multiple prompts + native resume/compaction over external transport. **Runnable on
    the current dev machine — it IS an authenticated Claude machine.** No longer "blocked".
  - `ClaudeAgentEngine` behind `IAgentEngine`; flip `WCC_ENGINE=claude`; owner dogfoods daily.
- **Phase 2b — hardening (before ANY public multi-tenant exposure):**
  - **Payload E2E encryption — REQUIRED, not stretch (U2, ISSUES #15).** Design: extend pairing with
    X25519 — the code-HMAC still authenticates the exchange (D1's insight stands), the ECDH output
    becomes the session channel key ⇒ authenticated key exchange; relay becomes a truly blind pipe.
  - WebAuthn passkeys + biometric gate on high-priv approvals; revoke/kill-switch; history audit
    split; daemon packaging + auto-update. CSP: pin `connect-src` to the real relay origin in prod
    builds (dev meta stays permissive for HMR).
- **Phase 2c — monetization (ONLY with evidence, U3/U5):** gate on (a) niche demand validated by
  real usage, (b) Anthropic ToS check for commercial subscription piggybacking (ISSUES #14). Then
  Stripe + plan gating. Redis backplane / multi-region stay deferred until load exists.
- **Phase 3 — Cloud Workspaces (owner's end-goal: "no laptop, rent a VM") — U4:**
  - **Feasible today:** the daemon is location-agnostic. A cloud workspace = the same daemon in a
    per-user container/VM (Fly Machines / Hetzner to start) with Claude Code preinstalled; the user
    signs into their own Claude account once inside it; a persistent volume keeps env + `claude`
    auth + repos. Browser UX is IDENTICAL to own-machine mode (same relay, same protocol).
  - **Trust model INVERTS — document honestly:** on a rented VM the user must trust the HOST; the
    E2E-signing-vs-relay story is no longer the headline. The security story becomes: per-tenant VM
    isolation, encryption at rest, no cross-tenant access, kill switch, and the same daemon-side
    policy/audit plane. Never market cloud mode with the own-machine trust claims.
  - **Differentiation requirement:** persistent full dev VM + own-machine-parity UX + policy plane.
    A throwaway sandbox loses to claude.ai/code and Codex cloud (vendor-subsidized — see MARKET.md).

## Phase 0 Done =
prompt → Claude proposes writing a file → approval (with diff) → Approve → file created → streams;
kill browser mid-Bash, reopen → re-hydrates with backfilled stdout; an unsigned/forged/replayed approval
at the relay is rejected; a daemon restart mid-turn unlocks the UI with an error.
