# Milestone M0 — Core Slice (Phase 0)

**Goal:** From a browser, run a live interactive session on one machine — signed + replay-protected
prompt, signed approval round-trip, mid-tool reconnect with stdout backfill, dirty-exit UI-unlock.
No accounts (locally-provisioned signing keypair; env pairing).

## Stories
### S1 — shared/ protocol layer  ← (Task 1) ✅ DONE
- [x] `protocol/version.ts`: PROTOCOL_VERSION, numeric semver compat, ConnHello/ConnAck, capabilities.
- [x] `protocol/envelope.ts`: TransportEnvelope type + factory + type guards.
- [x] `protocol/messages.ts`: Command union, Event union, Workspace/ExecutionMode/MachineState.
- [x] `protocol/canonical.ts`: deterministic bytes incl. deviceId + clientInstanceId; recursive key sort.
- [x] `protocol/sign.ts`: Ed25519 sign/verify; 60s window; per-(session,client) monotonic seq replay reject.
- [x] `engine/IAgentEngine.ts`: connect/send/approveTool/denyTool/interrupt/resumeConversation/onEvent/dispose.
- [x] tests: canonical-byte stability + valid/forged/unsigned/stale/replayed vectors. **28/28 green.**

### S2 — relay/ untrusted pipe  ← (Task 2) ✅ DONE
- [x] `ws` server; deviceId routing table; daemon register + browser attach; heartbeat; opaque forward.
- [x] Token-gated connect (Phase 0 = shared env token). Zero session-content state.
- [x] tests: route browser↔daemon by deviceId; reject bad token; broadcast; presence; cannot read/modify payload (byte-identical). 10/10.

### S3 — daemon/ security boundary + sessions  ← (Task 3)
- [ ] Outbound WS to relay; register deviceId; reconnect/backoff.
- [ ] WorkspaceManager → 1 Workspace → 1 Session; SessionStorage (journal + replay window + stream windows).
- [ ] IAgentEngine impl (mock first, then real SDK once 0B/0A confirm); canUseTool → permission_request.
- [ ] Verify signed user_message + permission_response; reject unsigned/forged/stale/replayed; default-deny.
- [ ] Workspace allowlist; no auto-approve Bash; resume{sinceSeq,toolStreamOffsets} backfill; dirty-exit detect.
- [ ] tests: signed round-trip; default-deny on unsigned; replay-with-stdout-backfill; multi-client cursors; dirty-exit→unlock.

### S4 — web/ UI  ← (Task 4)
- [ ] React+Vite; locally-provisioned signing key (Ed25519 via WebCrypto); WSS to relay.
- [ ] Streaming transcript + tool cards + diff preview; signed Commands; clientInstanceId + ack.
- [ ] Auto-reconnect + resume.
- [ ] tests: transcript render; permission/diff prompt; e2e reconnect/resume against a fake relay.

### S5 — end-to-end verification  ← (Task 5)
- [ ] Real relay + daemon + browser: "create hello.txt" → approve(diff) → file exists + streams.
- [ ] Deny; interrupt mid-run; drop browser mid-Bash → re-hydrate w/ backfilled stdout.
- [ ] Two clients attached, each resumes cleanly; inject unsigned/replayed approval at relay → rejected.
- [ ] Kill daemon mid-turn → restart → UI unlocks with error.

## Blocking research
- **0B** engine specifics: subscription-auth vs ANTHROPIC_API_KEY; canUseTool signature; Stop hook;
  interrupt(); resume + compaction. Lock the IAgentEngine impl. (Use claude-code-guide.)
- **0A [GATE]** runtime spike: prove engine holds one long-lived interactive session w/ streaming +
  approval + interrupt + reconnect + multiple prompts over external transport; native resume preserves
  compacted context. Needs an authenticated Claude machine.

## Strategy note
S1/S2 need no Claude auth → build + fully test first with a **MockEngine** behind IAgentEngine. Slot the
real SDK engine in during S3 once 0B confirms the API. This keeps progress non-blocked while 0A/0B
depend on an authed machine.
