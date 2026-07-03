/**
 * One-command local dev launcher for the P1 phone flow (see docs/RUN-LOCAL.md).
 *
 * Boots relay + daemon + web together, auto-detects this machine's LAN IP, and wires the browser's
 * VITE_RELAY_URL to it so a phone on the same Wi-Fi "just works" — removing the 3-terminal setup.
 * It surfaces the phone URL and the daemon pairing code prominently, and tears all three down on
 * Ctrl+C.
 *
 * Config via env (all optional):
 *   WCC_WORKSPACE_ROOT  the ONE project to drive        (default: process.cwd())
 *   WCC_ENGINE          claude | mock                    (default: claude)
 *   WCC_MODEL           model override                   (passed through if set)
 *   RELAY_PORT          relay port                       (default: 8787)
 *   WEB_PORT            vite port                        (default: 5179)
 *
 * Usage:  node scripts/dev.mjs   (or: npm run dev:all)
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const RELAY_PORT = process.env.RELAY_PORT ?? "8787";
const WEB_PORT = process.env.WEB_PORT ?? "5179";
const ENGINE = process.env.WCC_ENGINE ?? "claude";
const WORKSPACE_ROOT = process.env.WCC_WORKSPACE_ROOT ?? process.cwd();

/** First non-internal IPv4 on a private range — what the phone dials. */
function lanIp() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return "localhost";
}

const IP = lanIp();
const RELAY_URL_LAN = `ws://${IP}:${RELAY_PORT}`;

const children = [];
let shuttingDown = false;

/**
 * Spawn one child, stream its tagged output, and resolve `ready` when a line matches `readyRe`
 * (or after `readyTimeoutMs` as a fallback). Startup is sequenced by awaiting `ready` between
 * children so only one tsx transpile/cold-start runs at a time — this machine's small pagefile
 * (ISSUES #7) crashes a process if relay+daemon+web all cold-start simultaneously.
 */
function run(name, color, args, extraEnv, readyRe, readyTimeoutMs = 15000) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const timer = setTimeout(() => resolveReady(), readyTimeoutMs);
  timer.unref?.();
  const pump = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        console.log(`${tag} ${line}`);
        highlight(name, line);
        if (readyRe && readyRe.test(line)) {
          clearTimeout(timer);
          resolveReady();
        }
      }
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  child.on("exit", (code) => {
    console.log(`${tag} exited (code ${code})`);
    if (!shuttingDown) shutdown(code ?? 1);
  });
  children.push(child);
  return { child, ready };
}

/** Re-surface the two lines the user actually needs, so they don't scroll past. */
function highlight(name, line) {
  if (name === "daemon" && line.includes("PAIRING CODE")) {
    console.log(`\x1b[1m\x1b[32m>>> ${line.replace(/^.*PAIRING CODE:/, "PAIRING CODE:")}\x1b[0m`);
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[dev] shutting down…");
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const tsx = `${root}node_modules/tsx/dist/cli.mjs`;
const vite = `${root}node_modules/vite/bin/vite.js`;

console.log("─".repeat(64));
console.log(`  WebClaudeCode dev — engine=${ENGINE}  project=${WORKSPACE_ROOT}`);
console.log(`  On your phone (same Wi-Fi):  \x1b[1mhttp://${IP}:${WEB_PORT}/\x1b[0m`);
console.log(`  (browser relay = ${RELAY_URL_LAN})`);
console.log("─".repeat(64));

// Sequential cold-start (see run()'s note): relay → daemon → web, one at a time.
async function boot() {
  const relay = run("relay", "36", [tsx, `${root}packages/relay/src/index.ts`], {
    RELAY_HOST: "0.0.0.0",
    RELAY_PORT,
  }, /up on ws:\/\//);
  await relay.ready;

  const daemon = run(
    "daemon",
    "35",
    [tsx, `${root}packages/daemon/src/index.ts`],
    {
      WCC_ENGINE: ENGINE,
      WCC_WORKSPACE_ROOT: WORKSPACE_ROOT,
      WCC_RELAY_URL: `ws://localhost:${RELAY_PORT}`,
      WCC_PRINT_PAIRING_CODE: "1",
      ...(process.env.WCC_MODEL ? { WCC_MODEL: process.env.WCC_MODEL } : {}),
    },
    /daemon up/,
  );
  await daemon.ready;

  run("web", "33", [vite, "--config", `${root}packages/web/vite.config.ts`], {
    VITE_RELAY_URL: RELAY_URL_LAN,
  }, /Network:/);
}

boot();
