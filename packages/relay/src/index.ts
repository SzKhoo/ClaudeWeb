/**
 * Relay entry point. Config via env:
 *   RELAY_PORT                  (default 8787)
 *   RELAY_TOKEN                 shared bearer token (Phase 0). Used only when RELAY_JWT_SECRET unset.
 *   RELAY_JWT_SECRET            Phase 1: HS256 secret for browser JWT verification (Supabase secret).
 *                               When set, AuthVerifier replaces shared-token mode.
 *   RELAY_DAEMON_TOKENS         Phase 1: JSON `[{token,userId,deviceId}, ...]` to bootstrap daemon
 *                               tokens locally (Supabase-backed store comes at S1.6).
 *   RELAY_DIRECTORY             Phase 1: JSON `[{userId,deviceIds:[...]}]` for the in-memory directory.
 *   RELAY_HEARTBEAT_MS          (default 30000)
 *   RELAY_REGISTER_TIMEOUT_MS   (default 10000)
 *   RELAY_HOST                  (optional bind host)
 */
import { RelayServer, type RelayServerOptions } from "./RelayServer.js";
import {
  InMemoryDaemonTokenStore,
  InMemoryDirectory,
  JwtAuthVerifier,
  type AuthVerifier,
} from "./auth.js";

const DEV_TOKEN = "dev-relay-token";

async function buildAuthFromEnv(): Promise<AuthVerifier | undefined> {
  const secret = process.env["RELAY_JWT_SECRET"];
  if (!secret) return undefined;
  const directory = new InMemoryDirectory();
  const daemonTokens = new InMemoryDaemonTokenStore();
  const dirJson = process.env["RELAY_DIRECTORY"];
  if (dirJson) {
    const arr = JSON.parse(dirJson) as Array<{ userId: string; deviceIds: string[] }>;
    for (const e of arr) for (const d of e.deviceIds) directory.add(e.userId, d);
  }
  const tokensJson = process.env["RELAY_DAEMON_TOKENS"];
  if (tokensJson) {
    const arr = JSON.parse(tokensJson) as Array<{
      token: string;
      userId: string;
      deviceId: string;
    }>;
    for (const e of arr) {
      await daemonTokens.issue(e.token, { userId: e.userId, deviceId: e.deviceId });
      directory.add(e.userId, e.deviceId); // owning user must own the daemon's deviceId too
    }
  }
  return new JwtAuthVerifier({
    jwtSecret: new TextEncoder().encode(secret),
    directory,
    daemonTokens,
  });
}

async function main(): Promise<void> {
  const port = Number(process.env["RELAY_PORT"] ?? 8787);
  const auth = await buildAuthFromEnv();
  let token = process.env["RELAY_TOKEN"] ?? "";
  if (!auth && !token) {
    token = DEV_TOKEN;
    console.warn(
      "[relay] WARNING: RELAY_TOKEN not set — using insecure dev token. Set RELAY_TOKEN or RELAY_JWT_SECRET in production.",
    );
  }

  const opts: RelayServerOptions = {
    port,
    ...(auth ? { auth } : {}),
    ...(token ? { token } : {}),
    ...(process.env["RELAY_HOST"] ? { host: process.env["RELAY_HOST"] } : {}),
    ...(process.env["RELAY_HEARTBEAT_MS"]
      ? { heartbeatMs: Number(process.env["RELAY_HEARTBEAT_MS"]) }
      : {}),
    ...(process.env["RELAY_REGISTER_TIMEOUT_MS"]
      ? { registerTimeoutMs: Number(process.env["RELAY_REGISTER_TIMEOUT_MS"]) }
      : {}),
  };
  const server = new RelayServer(opts);

  const { port: bound } = await server.start();
  console.log(`[relay] up on ws://${process.env["RELAY_HOST"] ?? "localhost"}:${bound}`);

  const shutdown = () => {
    console.log("[relay] shutting down");
    server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[relay] fatal", err);
  process.exit(1);
});
