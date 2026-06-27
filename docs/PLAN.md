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
relay (hybrid); prove the core slice first; control-channel trust = "sign now, encrypt later".

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

## Phases
- **Phase 0 — core slice:** 0A runtime spike [GATE], 0B engine specifics [BLOCKING], 1 shared/, 2 relay/, 3 daemon/, 4 web/. No accounts; locally-provisioned keypair; env pairing.
- **Phase 1 — multi-tenant shell:** Supabase Auth + Postgres registry; pairing = ECDH + WebAuthn passkey enrollment; relay authz; strict CSP; "My machines" picker.
- **Phase 2 — hardening:** Stripe billing; history audit split; WebAuthn biometric gate on high-priv approvals; revoke/kill-switch; Redis backplane keyed by deviceId; multi-workspace/session; daemon packaging+auto-update; (stretch) full payload E2E encryption.

## Phase 0 Done =
prompt → Claude proposes writing a file → approval (with diff) → Approve → file created → streams;
kill browser mid-Bash, reopen → re-hydrates with backfilled stdout; an unsigned/forged/replayed approval
at the relay is rejected; a daemon restart mid-turn unlocks the UI with an error.
