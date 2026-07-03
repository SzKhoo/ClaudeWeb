# Run locally + drive it from your phone (P1)

The P1 goal: from your **phone on the same Wi‑Fi**, drive the real Claude Code running on this
laptop against **one** project, seeing the full live transcript. This is the prototype that validates
the whole idea before we add internet access (P2), multi-project (P3), and phone-preview (P4).

Three processes run on the laptop: **relay** (WebSocket hub), **daemon** (security boundary + the real
`claude` engine), and **web** (the Vite UI). The phone is just a browser pointed at the laptop.

## Quickstart — one command

```powershell
$env:WCC_WORKSPACE_ROOT = "D:\Personal\YourProject"   # the ONE project to drive
npm run dev:all
```

`dev:all` ([scripts/dev.mjs](../scripts/dev.mjs)) boots all three, **auto-detects your LAN IP**, wires
the browser's relay URL to it, and prints the phone URL + pairing code. It starts them sequentially
(one at a time) so this machine's small pagefile (ISSUES #7) doesn't crash a process on cold start.
Defaults: `WCC_ENGINE=claude`, `RELAY_PORT=8787`, `WEB_PORT=5179`. Ctrl+C stops everything. Then jump
to **step 4 (Pair the phone)** below.

The manual 3-terminal flow below is the fallback if you want separate logs or hit a launcher issue.

## 0. Find your laptop's LAN IP

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' }).IPAddress
```

Example used below: **192.168.0.119**. Substitute yours everywhere you see `<LAN-IP>`.

## 1. Start the relay (terminal 1)

```powershell
$env:RELAY_HOST = "0.0.0.0"   # bind all interfaces so the phone can reach it
$env:RELAY_PORT = "8787"
npm run dev:relay
```

Expect: `[relay] up on ws://0.0.0.0:8787`.

## 2. Start the daemon with the REAL engine (terminal 2)

Point it at the ONE project you want to drive. The daemon dials the relay on localhost (same machine).

```powershell
$env:WCC_ENGINE         = "claude"                 # real Claude Code (0A/0B gate passed)
$env:WCC_WORKSPACE_ROOT = "D:\Personal\YourProject" # the single project for P1
$env:WCC_PRINT_PAIRING_CODE = "1"                  # prints a pairing code on startup
# optional: $env:WCC_MODEL = "claude-opus-4-8"
npm run dev:daemon
```

Expect a line like `[daemon] PAIRING CODE: JHEY-0054-VJ` and `registered with relay`. The daemon runs
the real `claude` CLI using whatever login you already set up — **no API key needed**.

> Note: the daemon writes its journal + device key under `<WCC_WORKSPACE_ROOT>\.wcc\`.

## 3. Start the web UI, told to reach the relay over the LAN (terminal 3)

The browser (on the phone) must reach the relay at the **LAN IP**, not localhost:

```powershell
$env:VITE_RELAY_URL = "ws://<LAN-IP>:8787"
npm run dev:web
```

Vite prints a **Network** URL like `http://<LAN-IP>:5179/`. That's what you open on the phone.

## 4. Pair the phone + run a task

Open `http://<LAN-IP>:5179/` on the phone. Two pairing paths:

**A. Static pairing (simplest, most proven — the e2e path):**
1. On the phone, tap the pair/key toggle in the status bar to reveal this browser's public key; copy it.
2. Stop the daemon (Ctrl+C), set `$env:WCC_PAIRED_PUBKEY = "<that key>"`, and start it again.
3. Reload the phone. Commands from that browser are now accepted. Send a prompt.

**B. Pairing-code flow (nicer; what P2 builds on):**
1. Open `http://<LAN-IP>:5179/?phase=1` on the phone.
2. Log in (mock auth in dev — any credentials), pick the device, enter the pairing code from step 2.
3. Send a prompt.

## Exit criteria (P1 done)

You complete a **real** coding task from the phone — send a prompt, watch the streaming transcript,
approve a Write with its diff, and see the file appear on disk in the project — **without touching
Telegram**. Note any friction; that friction list feeds P2/P3/P4.

## Bash equivalents (if you use the Bash tool instead of PowerShell)

```bash
RELAY_HOST=0.0.0.0 RELAY_PORT=8787 npm run dev:relay
WCC_ENGINE=claude WCC_WORKSPACE_ROOT="D:/Personal/YourProject" WCC_PRINT_PAIRING_CODE=1 npm run dev:daemon
VITE_RELAY_URL="ws://<LAN-IP>:8787" npm run dev:web
```

## Troubleshooting

- **Phone can't load the page:** confirm both devices are on the same Wi‑Fi; Windows Firewall may prompt
  to allow Node on private networks — allow it. Vite must show a `Network:` URL (needs `host: true`, set
  in `packages/web/vite.config.ts`).
- **Page loads but won't connect / commands rejected:** `VITE_RELAY_URL` must be the LAN IP (not
  localhost), and the browser must be paired (step 4). "reject ALL commands until a browser is paired"
  in the daemon log means pairing hasn't completed.
- **exFAT / npm ENOSPC:** see `docs/issues/ISSUES.md` #1 (cache + TEMP must be on E:).
