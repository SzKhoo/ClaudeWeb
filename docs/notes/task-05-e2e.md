# Task 5 — full-stack e2e (automated + live preview) — ✅ DONE

Date: 2026-06-28. Milestone M0 / Story S5. This is the Phase 0 "Done =" gate (MockEngine path).

## Automated e2e — `packages/e2e/test/slice.e2e.test.ts`
Wires the REAL stack over REAL WebSockets and folds events through the REAL web SessionModel:

```
web Connection ⇄ RelayServer ⇄ DaemonClient ⇄ Daemon ⇄ Session ⇄ MockEngine
```

**5 tests, all green:**
1. `create hello.txt` → permission with **diff** → approve → file exists on disk + streamed output + UI idle.
2. Deny → file not created, turn ends.
3. Interrupt while awaiting approval → turn ends interrupted, no file, system note shown.
4. **Multi-client resume** — a fresh second browser (cursor 0) backfills the entire transcript via `resume`.
5. **Dirty-exit** — FileJournal-backed daemon killed mid-turn (open turn on disk); restart on the same
   journal → it emits `turn_complete{error}`; the browser re-handshakes + resumes → **UI unlocks** (idle,
   pending cleared, "restarted" notice).

Signature/replay rejection (unsigned + replayed) is proven in `packages/daemon/test/Daemon.integration.test.ts`.

## Live preview (browser)
Ran the actual product: `scripts/bundle.mjs` (esbuild, `@wcc/shared` aliased, `ws` external) → `dist/relay.mjs`
+ `dist/daemon.mjs`; started relay (:8787) + daemon (paired pubkey, workspace `E:/StorageContent/tmp/preview-ws`);
served the web app via Vite (:5179). Injected the paired dev key into `localStorage`, then drove it in-browser:

- Typed `create greeting.txt with content "hello from the browser"` → Send.
- UI streamed **"Working on it… ▍"**, went to **awaiting approval**, showed the **Write permission card with a
  colored unified diff**.
- Clicked **Approve once** → tool card showed **done** + `Wrote 22 bytes to greeting.txt` → final
  `Created greeting.txt.` → status back to **idle**, composer restored.
- On disk: `greeting.txt` = `hello from the browser` (22 bytes). Journal shows the full turn (tool_stream →
  tool_result ok → turn_complete ok → session_status idle). **No console errors/warnings.**

This satisfies the plan's Phase 0 "Done =": *prompt → Claude proposes writing a file → approval (with diff) →
Approve → file created → streams.*

## How to re-run the live demo
1. `node scripts/bundle.mjs` (rebuild dist if daemon/relay changed).
2. `RELAY_PORT=8787 RELAY_TOKEN=dev-relay-token node dist/relay.mjs`
3. `WCC_RELAY_URL=ws://localhost:8787 WCC_RELAY_TOKEN=dev-relay-token WCC_DEVICE_ID=dev-device \`
   `WCC_SESSION_ID=dev-session WCC_WORKSPACE_ROOT=<dir> WCC_PAIRED_PUBKEY=<browser pubkey> node dist/daemon.mjs`
4. `npm run dev:web` (Vite on :5179). Open it; reveal the **pairing key** in the status bar and set it as the
   daemon's `WCC_PAIRED_PUBKEY` (or inject a known key into `localStorage.wcc.identity.v1`).
   - Preview tooling note: the in-IDE preview reads `D:\Qynix\LamResearch\.claude\launch.json` (the harness's
     working dir), so a `web` config pointing at the E: Vite binary was added there. The E: project also has its
     own `.claude/launch.json`.

## What is NOT covered (the single remaining gate)
- **0A/0B — real `ClaudeAgentEngine`** (subscription auth, real `canUseTool`, interrupt, resume/compaction):
  requires an authenticated Claude machine. Everything is built behind `IAgentEngine`; flip `WCC_ENGINE=claude`
  once the engine class is implemented + the spike confirms the SDK API. This is the only manual gate left in Phase 0.
