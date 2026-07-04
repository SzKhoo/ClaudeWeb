# Deploying WebClaudeCode beyond your LAN (P2 — "use it from anywhere")

You only ever host **one** thing publicly: the **relay** (a dumb WebSocket pipe). Your **daemon**
stays on your own machine and *dials out* to the relay — so there is **no home port-forwarding** and
your filesystem/Claude login never leave your machine. Browsers (your phone) connect to the relay too.

```
  phone browser ──wss──▶  RELAY (public host)  ◀──wss── daemon (your PC, dials out)
                          routes by deviceId only,
                          never parses payloads
```

## Can GitHub host it?

- **GitHub Pages: no** for the relay. Pages only serves *static files* — it cannot run a persistent
  Node process or accept WebSocket connections. It **can** host the built web client (`npm run
  build:web` → static assets), but the relay must run somewhere that keeps a process alive.
- **GitHub Actions: no** — it runs ephemeral CI jobs, not a public long-lived server.

So: host the **relay** on a small always-on host (Render / Railway / Fly.io / any VPS), and optionally
host the **web client** static build on GitHub Pages (or the same host).

## What's already wired for deployment

- The relay honors the platform `PORT` env var (Render/Railway/Heroku/Fly inject it); `RELAY_PORT`
  still overrides for local dev.
- `GET /healthz` returns `{ ok: true }` for platform health probes (same server that upgrades WS).
- In `NODE_ENV=production` the relay **hard-fails** if no `RELAY_TOKEN` / `RELAY_JWT_SECRET` is set —
  it will never fall back to the insecure dev token.
- `Dockerfile` (repo root) + `render.yaml` blueprint + `.dockerignore` are included.

## Option A — Render (blueprint, ~5 min)

1. Push this repo to GitHub.
2. Render → **New +** → **Blueprint** → pick the repo. It reads `render.yaml`, builds the Dockerfile,
   injects `PORT`, and generates a strong `RELAY_TOKEN`. Copy that token and the public URL
   (`https://wcc-relay-xxxx.onrender.com`).
3. Point your daemon at it (note **wss://**, and pass the same token):
   ```powershell
   $env:WCC_RELAY_URL   = "wss://wcc-relay-xxxx.onrender.com"
   $env:WCC_RELAY_TOKEN = "<the token Render generated>"
   $env:WCC_ENGINE      = "claude"
   $env:WCC_WORKSPACE_ROOT = "D:\your\project"
   $env:WCC_PAIRED_PUBKEY  = "<your browser pairing key>"
   npm run dev:daemon
   ```
4. Build + serve the web client with `VITE_RELAY_URL=wss://wcc-relay-xxxx.onrender.com` (and the same
   `VITE_RELAY_TOKEN` in Phase 0), then open it on your phone.

Verify: `curl https://wcc-relay-xxxx.onrender.com/healthz` → `{"ok":true,"service":"wcc-relay"}`.

## Option B — Docker anywhere (Railway / Fly / a VPS)

```bash
docker build -t wcc-relay .
docker run -p 8787:8787 -e NODE_ENV=production -e RELAY_TOKEN="<strong-token>" wcc-relay
# health: curl http://localhost:8787/healthz
```
Then set the host to route :8787 (or its injected PORT) behind TLS and use the resulting **wss://** URL
as above. Fly.io: `fly launch` (uses the Dockerfile) then `fly deploy`.

## Notes / next hardening (tracked separately)

- **Payload E2E encryption (issue #15)** is designed and partly built (`packages/shared/src/pairing/
  x25519.ts`, `protocol/seal.ts`). Until it's wired end-to-end, the hosted relay sees ciphertext only
  once #15 lands; today it forwards frames opaquely but they are not yet encrypted. Prefer a trusted
  host and a strong `RELAY_TOKEN` in the meantime, and finish #15 before routing sensitive work over a
  third-party relay.
- **Auth**: for multi-device login set `RELAY_JWT_SECRET` (Supabase) instead of a shared `RELAY_TOKEN`
  (see `packages/relay/src/index.ts` env docs and `supabase/README.md`).
- Phone over **plain http** has no `crypto.subtle`; serving the web client over **https** (or via the
  same host) is required before #15 encryption can run on the phone.
