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
 *   WCC_PAIRED_PUBKEY    base64url Ed25519 browser public key (Phase-0 static pairing; optional in P1)
 *   WCC_ENGINE           mock | claude           (default mock)
 *   WCC_DEVICE_KEY_PATH  device identity file    (default <root>/.wcc/device.key.json)
 *   WCC_KEYS_PATH        enrolled-keys file      (default <root>/.wcc/keys.json)
 *   WCC_PRINT_PAIRING_CODE  if set, mints a pairing code on startup and prints it to stdout
 */

import { join } from "node:path";
import { fromBase64Url, toBase64Url } from "@wcc/shared";
import { Daemon } from "./Daemon.js";
import { DaemonClient } from "./transport/DaemonClient.js";
import { MockEngine } from "./engine/MockEngine.js";
import { ClaudeAgentEngine } from "./engine/ClaudeAgentEngine.js";
import type { EffortLevel, IAgentEngine } from "@wcc/shared";
import { PairingStore } from "./security/CommandVerifier.js";
import { EnrolledKeyStore } from "./security/EnrolledKeyStore.js";
import { PairingCodeStore } from "./security/PairingCodeStore.js";
import { openDeviceIdentity } from "./security/DeviceIdentity.js";
import type { EnrollmentManagerOptions } from "./security/EnrollmentManager.js";
import { formatCode } from "@wcc/shared";
import type { PairingKeyStore } from "./security/CommandVerifier.js";
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
  const engineKind = env["WCC_ENGINE"] ?? "mock";
  const deviceKeyPath = env["WCC_DEVICE_KEY_PATH"] ?? join(root, ".wcc", "device.key.json");
  const enrolledKeysPath = env["WCC_KEYS_PATH"] ?? join(root, ".wcc", "keys.json");

  // Phase 1: dynamic enrolled-key store + EnrollmentManager. Phase 0's WCC_PAIRED_PUBKEY is honored
  // by pre-seeding the static store, so existing deployments / tests keep working.
  const enrolledKeys = await EnrolledKeyStore.open(enrolledKeysPath);
  const staticPairing = new PairingStore();
  const pubkeyB64 = env["WCC_PAIRED_PUBKEY"];
  if (pubkeyB64) {
    staticPairing.addPublicKey(fromBase64Url(pubkeyB64));
    logger("info", "honoring static WCC_PAIRED_PUBKEY (Phase-0 compat path)");
  }

  // Compose: verifier sees BOTH the enrolled keys AND the static key (if any).
  const pairing: PairingKeyStore = {
    keys: () => [...enrolledKeys.keys(), ...staticPairing.keys()],
    get size() {
      return enrolledKeys.size + staticPairing.size;
    },
  };
  if (pairing.size === 0) {
    logger(
      "warn",
      "no enrolled or static keys — daemon will reject ALL commands until a browser is paired.",
    );
  }

  const deviceIdentity = await openDeviceIdentity(deviceKeyPath);
  logger("info", "device identity ready", { devicePubKey: deviceIdentity.pubkeyB64 });

  let engine: IAgentEngine;
  if (engineKind === "mock") {
    engine = new MockEngine();
  } else if (engineKind === "claude") {
    // 0A/0B gate passed 2026-07-03: streaming-input + canUseTool + interrupt + resume proven on
    // this machine's local Claude Code login (see docs/notes/task-07-real-engine.md). No API key.
    engine = new ClaudeAgentEngine({
      ...(env["WCC_MODEL"] ? { model: env["WCC_MODEL"] } : {}),
      ...(env["WCC_EFFORT"] ? { effort: env["WCC_EFFORT"] as EffortLevel } : {}),
      logger,
    });
    logger("info", "using ClaudeAgentEngine", {
      model: env["WCC_MODEL"] ?? "(CLI default)",
      effort: env["WCC_EFFORT"] ?? "(CLI default)",
    });
  } else {
    logger("error", `WCC_ENGINE=${engineKind} unknown; use "mock" or "claude".`);
    process.exit(2);
  }
  const workspaces: WorkspaceConfig[] = [{ workspaceId: "default", name, root }];

  const codes = new PairingCodeStore();
  const enrollmentOpts: EnrollmentManagerOptions = {
    enrolledKeys,
    codes,
    deviceSecretKey: deviceIdentity.secretKey,
    devicePubKey: deviceIdentity.pubkey,
  };

  const daemon = new Daemon({
    deviceId,
    sessionId,
    workspaces,
    engine,
    workspaceRoot: root,
    pairing,
    enrollment: enrollmentOpts,
    logger,
  });

  if (env["WCC_PRINT_PAIRING_CODE"]) {
    const code = daemon.enroll()!.mintCode("startup");
    console.log(`[daemon] PAIRING CODE: ${formatCode(code)} (raw=${code})`);
    console.log(`[daemon] DEVICE PUBKEY: ${deviceIdentity.pubkeyB64}`);
  }
  // Avoid an unused-var warning even when WCC_PRINT_PAIRING_CODE is unset.
  void toBase64Url;
  await daemon.start();

  const client = new DaemonClient({ url: relayUrl, token, deviceId, daemon, logger });
  await client.start();
  logger("info", "daemon up", { relayUrl, deviceId, sessionId, root });

  const shutdown = async () => {
    logger("info", "shutting down");
    await client.stop();
    await daemon.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logger("error", "fatal", { err: String(err) });
  process.exit(1);
});
