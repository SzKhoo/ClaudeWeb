# Task 4 — `packages/web` (React+Vite browser client) — ✅ DONE

Date: 2026-06-28. Milestone M0 / Story S4.

## What was built
| File | Purpose |
|------|---------|
| `src/identity.ts` | Locally-provisioned Ed25519 signing identity, persisted in `localStorage`. Surfaces `publicKeyB64` for pairing with the daemon (`WCC_PAIRED_PUBKEY`). |
| `src/protocol-client.ts` | `Connection`: relay_register (browser) + ConnHello/ConnAck handshake, SIGNS every command, orders/dedups inbound events by session seq, tracks the resume cursor + per-tool stream offsets, auto-reconnect (capped backoff) + `resume` on (re)connect. Environment-agnostic (structural `WebSocketLike`) so the node e2e injects `ws`. |
| `src/session-model.ts` | `SessionModel`: pure event→transcript reducer (user/assistant bubbles, tool cards, system/error lines, pending permission, session state). No DOM/React — shared with the e2e. |
| `src/config.ts` | Vite-env config with dev defaults matching the daemon/relay. |
| `src/App.tsx` | Wires identity + Connection + SessionModel via hooks; sends signed user_message / permission_response / interrupt / policy_update. |
| `src/ui/StatusBar.tsx` | Connection health dot, session state, execution-mode selector, pairing-key reveal. |
| `src/ui/Transcript.tsx` | Streaming bubbles + tool cards (output + result badge), auto-scroll. |
| `src/ui/PermissionPrompt.tsx` | Approve-with-diff gate (Approve once / Approve for session / Deny). |
| `src/ui/DiffView.tsx` | Unified-diff renderer with +/- coloring. |
| `src/ui/Composer.tsx` | Prompt input (Enter to send) + Interrupt while busy. |
| `src/styles.css` | Dark, terminal-leaning theme (the "Claude Code feel"). |
| `index.html`, `src/main.tsx` | Vite entry (no StrictMode → avoids double WS connect in dev). |
| `vite.config.ts`, `tsconfig.json` | Bundler/DOM module mode + `@wcc/shared` alias. |
| `test/session-model.test.ts` | 6 tests: delta accumulation+finalize, tool lifecycle ordering, permission set/clear, status tracking, non-ok turn system item, local user message + error + session end. |

## Build/tsconfig story (exFAT + mixed module modes)
- The web package needs **Bundler** module resolution + **DOM** lib + **react-jsx**, which is incompatible
  with the repo's NodeNext. So it has **its own `packages/web/tsconfig.json`**; the root tsconfig
  **excludes** `packages/web`. `npm run typecheck` runs BOTH (`tsc -p tsconfig.json && tsc -p packages/web/tsconfig.json`).
- `protocol-client.ts` + `session-model.ts` are written **node-safe** (no DOM-only type references) so the
  NodeNext e2e can import them; relative imports keep `.js` extensions (valid in Bundler AND NodeNext).
- `@wcc/shared` resolves via the Vite alias at runtime, the web tsconfig `paths` (inherited) at type-check,
  and the Vitest alias in tests — never a node_modules symlink (exFAT).
- Added deps: `react`, `react-dom`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `vite@6`.

## Verification
- `tsc -p packages/web/tsconfig.json` → clean.
- `vitest run packages/web` → **6/6**.
- LIVE preview (see task-05 note): real relay + daemon + this app in a browser → prompt → permission
  prompt with **diff** → Approve → file created on disk + streamed output → UI returns to idle. No console errors.

## Notes for later
- Phase 1: WebAuthn passkey identity (hardware-backed, biometric) + strict CSP; Supabase JWT for relay auth.
- The pairing-key reveal is the Phase 0 manual pairing UX; Phase 1 replaces it with ECDH + passkey enrollment.

## Next
Task 5 — full-stack e2e (automated + live).
