/**
 * Relay entry point. Config via env:
 *   RELAY_PORT               (default 8787)
 *   RELAY_TOKEN              shared bearer token (Phase 0). If unset, a loud dev default is used.
 *   RELAY_HEARTBEAT_MS       (default 30000)
 *   RELAY_REGISTER_TIMEOUT_MS(default 10000)
 *   RELAY_HOST               (optional bind host)
 */
import { RelayServer } from "./RelayServer.js";

const DEV_TOKEN = "dev-relay-token";

async function main(): Promise<void> {
  const port = Number(process.env["RELAY_PORT"] ?? 8787);
  let token = process.env["RELAY_TOKEN"] ?? "";
  if (!token) {
    token = DEV_TOKEN;
    console.warn(
      "[relay] WARNING: RELAY_TOKEN not set — using insecure dev token. Set RELAY_TOKEN in production.",
    );
  }

  const server = new RelayServer({
    port,
    token,
    host: process.env["RELAY_HOST"],
    heartbeatMs: process.env["RELAY_HEARTBEAT_MS"] ? Number(process.env["RELAY_HEARTBEAT_MS"]) : undefined,
    registerTimeoutMs: process.env["RELAY_REGISTER_TIMEOUT_MS"]
      ? Number(process.env["RELAY_REGISTER_TIMEOUT_MS"])
      : undefined,
  });

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
