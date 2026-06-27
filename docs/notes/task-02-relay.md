# Task 2 — `packages/relay` (untrusted deviceId-routed WS pipe) — ✅ DONE

Date: 2026-06-28. Milestone M0 / Story S2.

## What was built
| File | Purpose |
|------|---------|
| `src/messages.ts` | Relay-LOCAL control frames (`relay_register`/`relay_registered`/`relay_error`/`relay_peer`) + `isRelayRegister` guard. Separate from the E2E protocol. |
| `src/RelayServer.ts` | The dumb pipe: token auth, `deviceId` routing table, opaque raw-byte forwarding, daemon-presence notices, heartbeat, register-timeout, daemon-replacement. |
| `src/index.ts` | Entry point (env config: `RELAY_PORT`/`RELAY_TOKEN`/`RELAY_HEARTBEAT_MS`/`RELAY_REGISTER_TIMEOUT_MS`/`RELAY_HOST`). |
| `test/relay.test.ts` | 10 integration tests with real `ws` clients on an ephemeral port. |

## Design (honoring invariants #1 + #5)
- **Two handshakes:** (1) relay-local `relay_register` (token + role + deviceId) consumed by the relay,
  never forwarded; (2) the E2E `ConnHello`/`ConnAck` flows browser↔daemon THROUGH the relay, opaque.
- **Routing = deviceId only.** browser→the one daemon for that deviceId; daemon→broadcast to all
  browsers for that deviceId. Routes by the **connection's REGISTERED deviceId**, so a peer can't
  cross-route by spoofing `deviceId` inside a frame. `sessionId`/`clientInstanceId` are never inspected.
- **Opaque forwarding:** after registration, frames are forwarded as raw bytes (`ws.send(data,{binary})`),
  never parsed/reserialized. Proven by a test: a signed `@wcc/shared` envelope arrives byte-identical.
- **Presence:** relay emits `relay_peer{role:daemon,online}` to browsers on daemon connect/disconnect;
  `relay_registered.peerOnline` reports current state. `device_offline` error if a browser sends with no daemon.
- **Robustness:** timing-safe token compare, register-timeout drop, heartbeat ping/pong with dead-socket
  termination, daemon-replacement on reconnect (stale socket terminated), 16 MiB max frame, unref'd timers.
- **Zero session content.** Relay holds only the routing table (sockets + deviceId), nothing else.

## Verification
- `npm run typecheck` → clean.
- `npx vitest run packages/relay` → **10/10 pass**: bad-token reject, malformed reject, valid ack,
  browser↔daemon routing, **opaque byte-identical forward**, broadcast to multiple browsers,
  no cross-device routing, device_offline, presence up/down, daemon-replacement.
- Ran the real entrypoint via `tsx` on port 8791 → listened + accepted a live `ws` register. Run path OK.

## Notes for later
- Phase 1: replace shared token with Supabase JWT (browser) + device token (daemon); authorize that the
  browser's user owns the deviceId. Redis backplane keyed by deviceId for multi-node (Phase 2).
- The relay does NOT depend on `@wcc/shared` in src (reinforces "dumb pipe"); the TEST imports it only
  to build a realistic envelope for the opaque-forward assertion.

## Next
Task 3 — `packages/daemon` (the security boundary): WorkspaceManager→Workspace→Session, SessionStorage
(journal + replay window + stream windows), MockEngine behind IAgentEngine, signed-command verify +
replay, default-deny policy, permission round-trip, dirty-exit detection. This is the biggest task.
