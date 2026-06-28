/**
 * Daemon entry point. Phase 0 runs with the MockEngine (no Claude auth), so the whole relay/daemon/web
 * slice is buildable + testable on any machine. The real ClaudeAgentEngine slots in behind the same
 * IAgentEngine once the 0A/0B spikes land on an authenticated machine (WCC_ENGINE=claude, gated).
 *
 * Config via env:
 *   WCC_RELAY_URL        relay ws url            (default ws://localhost:8787)
 *   WCC_RELAY_TOKEN      shared relay token      (default dev-relay-token)
 *   WCC_DEVICE_ID        routing key             (default dev-device)
 *   WCC_SESSION_ID       session id              (default dev-session)
 *   WCC_WORKSPACE_ROOT   allowlisted root        (default cwd)
 *   WCC_WORKSPACE_NAME   display name            (default default)
 *   WCC_PAIRED_PUBKEY    base64url Ed25519 browser public key (REQUIRED to accept any command)
 *   WCC_JOURNAL_PATH     journal jsonl path      (default <root>/.wcc/sessions/<sessionId>.jsonl)
 *   WCC_ENGINE           mock | claude           (default mock)
 */

import { join } from "node:path";
import { fromBase64Url } from "@wcc/shared";
import { Daemon } from "./Daemon.js";
import { DaemonClient } from "./transport/DaemonClient.js";
import { MockEngine } from "./engine/MockEngine.js";
import { FileJournal } from "./storage/journal.js";
import { PairingStore } from "./security/CommandVerifier.js";
import type { WorkspaceConfig } from "./workspace/workspace.js";

const logger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => {
  const line = `[daemon] ${level} ${message}`;
  if (level === "error" || level === "warn") console.error(line, meta ?? "");
  else console.log(line, meta ?? "");
};

async function main(): Promise<void> {
  const env = process.env;
  const relayUrl = env["WCC_RELAY_URL"] ?? "ws://localhost:8787";
  const token = env["WCC_RELAY_TOKEN"] ?? "dev-relay-token";
  const deviceId = env["WCC_DEVICE_ID"] ?? "dev-device";
  const sessionId = env["WCC_SESSION_ID"] ?? "dev-session";
  const root = env["WCC_WORKSPACE_ROOT"] ?? process.cwd();
  const name = env["WCC_WORKSPACE_NAME"] ?? "default";
  const journalPath = env["WCC_JOURNAL_PATH"] ?? join(root, ".wcc", "sessions", `${sessionId}.jsonl`);
  const engineKind = env["WCC_ENGINE"] ?? "mock";

  const pairing = new PairingStore();
  const pubkeyB64 = env["WCC_PAIRED_PUBKEY"];
  if (pubkeyB64) {
    pairing.addPublicKey(fromBase64Url(pubkeyB64));
  } else {
    logger("warn", "WCC_PAIRED_PUBKEY not set — NO commands will be accepted until a key is paired.");
  }

  if (engineKind !== "mock") {
    logger("error", `WCC_ENGINE=${engineKind} not available yet (real engine is the 0A/0B gate). Use mock.`);
    process.exit(2);
  }

  const engine = new MockEngine();
  const journal = await FileJournal.open(journalPath);
  const workspaces: WorkspaceConfig[] = [{ workspaceId: "default", name, root }];

  const daemon = new Daemon({
    deviceId,
    sessionId,
    workspaces,
    engine,
    journal,
    pairing,
    logger,
  });
  await daemon.start();

  const client = new DaemonClient({ url: relayUrl, token, deviceId, daemon, logger });
  await client.start();
  logger("info", "daemon up", { relayUrl, deviceId, sessionId, root, journalPath });

  const shutdown = async () => {
    logger("info", "shutting down");
    await client.stop();
    await daemon.dispose();
    await journal.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logger("error", "fatal", { err: String(err) });
  process.exit(1);
});
