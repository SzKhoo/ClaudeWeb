/**
 * Task 5 — full-stack e2e for the Phase 0 core slice. Wires the REAL pieces over REAL WebSockets:
 *
 *   web Connection ⇄ RelayServer ⇄ DaemonClient ⇄ Daemon ⇄ Session ⇄ MockEngine
 *
 * and folds the daemon's events through the REAL SessionModel — i.e. it exercises exactly what the
 * browser app runs, minus React. Covers: signed prompt → approve-with-diff → file created + streamed;
 * deny; interrupt; multi-client resume backfill; and dirty-exit → UI unlock across a daemon restart.
 *
 * Signature/replay rejection is proven in packages/daemon/test/Daemon.integration.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateKeyPair, type KeyPair } from "@wcc/shared";
import { RelayServer } from "../../relay/src/RelayServer.js";
import { Daemon } from "../../daemon/src/Daemon.js";
import { DaemonClient } from "../../daemon/src/transport/DaemonClient.js";
import { MockEngine } from "../../daemon/src/engine/MockEngine.js";
import { PairingStore } from "../../daemon/src/security/CommandVerifier.js";
import { Connection, type ConnectionStatus, type WebSocketCtor } from "../../web/src/protocol-client.js";
import { SessionModel, type SessionView } from "../../web/src/session-model.js";
import { makeTempWorkspace, cleanupWorkspace, fileExists, readWorkspaceFile } from "../../daemon/test/helpers.js";

const TOKEN = "e2e-token";
const DEVICE = "e2e-device";
const SESSION = "e2e-session";
const WS_IMPL = WebSocket as unknown as WebSocketCtor;

async function poll<T>(get: () => T | undefined | false, attempts = 600): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = get();
    if (v !== undefined && v !== false) return v as T;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error("poll timed out");
}

/** A browser participant: the real Connection folding events into the real SessionModel. */
class Browser {
  readonly model = new SessionModel();
  readonly conn: Connection;
  status: ConnectionStatus = "connecting";
  constructor(url: string, keys: KeyPair, clientInstanceId: string) {
    this.conn = new Connection({
      url,
      token: TOKEN,
      deviceId: DEVICE,
      sessionId: SESSION,
      clientInstanceId,
      secretKey: keys.secretKey,
      WebSocketImpl: WS_IMPL,
      minBackoffMs: 50,
      maxBackoffMs: 200,
      onEvent: (e) => this.model.apply(e),
      onStatus: (s) => {
        this.status = s;
      },
    });
  }
  start(): void {
    this.conn.connect();
  }
  view(): SessionView {
    return this.model.view();
  }
  async ready(): Promise<void> {
    await poll(() => this.status === "ready" || undefined);
  }
  async command(cmd: Parameters<Connection["send"]>[0]): Promise<void> {
    await this.ready();
    const ok = await this.conn.send(cmd);
    if (!ok) throw new Error("command send failed (socket not ready)");
  }
  async send(text: string): Promise<void> {
    this.model.addLocalUserMessage(text);
    await this.command({ type: "user_message", text });
  }
  close(): void {
    this.conn.close();
  }
}

interface Stack {
  relay: RelayServer;
  daemon: Daemon;
  client: DaemonClient;
  url: string;
  root: string;
  keys: KeyPair;
}

async function startDaemon(opts: { url: string; keys: KeyPair; root: string }): Promise<{ daemon: Daemon; client: DaemonClient }> {
  const pairing = new PairingStore();
  pairing.addPublicKey(opts.keys.publicKey);
  const daemon = new Daemon({
    deviceId: DEVICE,
    sessionId: SESSION,
    workspaces: [{ workspaceId: "default", name: "e2e", root: opts.root }],
    engine: new MockEngine(),
    workspaceRoot: opts.root,
    pairing,
    permissionTimeoutMs: 60_000,
    logger: () => {},
  });
  await daemon.start();
  const client = new DaemonClient({ url: opts.url, token: TOKEN, deviceId: DEVICE, daemon, logger: () => {} });
  await client.start();
  return { daemon, client };
}

async function startStack(root: string): Promise<Stack> {
  const relay = new RelayServer({ port: 0, token: TOKEN, logger: () => {} });
  const { port } = await relay.start();
  const url = `ws://localhost:${port}`;
  const keys = await generateKeyPair();
  const { daemon, client } = await startDaemon({ url, keys, root });
  return { relay, daemon, client, url, root, keys };
}

describe("Phase 0 slice — full stack (web Connection ⇄ relay ⇄ daemon ⇄ MockEngine)", () => {
  let stack: Stack;
  let root: string;

  beforeEach(async () => {
    root = makeTempWorkspace();
    stack = await startStack(root);
  });
  afterEach(async () => {
    await stack.client.stop().catch(() => {});
    await stack.daemon.dispose().catch(() => {});
    await stack.relay.stop().catch(() => {});
    cleanupWorkspace(root);
  });

  it("create hello.txt → approve(diff) → file exists + streamed output, UI returns to idle", async () => {
    const b = new Browser(stack.url, stack.keys, "browser-A");
    b.start();
    await b.ready();
    await b.send('create hello.txt with content "world"');

    const pending = await poll(() => b.view().pending);
    expect(pending.toolName).toBe("Write");
    expect(pending.diff?.unified).toContain("world");
    expect(fileExists(root, "hello.txt")).toBe(false);

    await b.command({ type: "permission_response", requestId: pending.requestId, decision: "approve" });
    b.model.clearPending();

    await poll(() => (b.view().state === "idle" && fileExists(root, "hello.txt") ? true : undefined));
    expect(readWorkspaceFile(root, "hello.txt")).toBe("world");
    const tool = b.view().items.find((i) => i.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.output : "").toContain("Wrote");
    b.close();
  }, 20_000);

  it("deny → file not created, turn ends", async () => {
    const b = new Browser(stack.url, stack.keys, "browser-A");
    b.start();
    await b.send("create denied.txt");
    const pending = await poll(() => b.view().pending);
    await b.command({ type: "permission_response", requestId: pending.requestId, decision: "deny" });
    b.model.clearPending();
    await poll(() => (b.view().state === "idle" ? true : undefined));
    expect(fileExists(root, "denied.txt")).toBe(false);
    b.close();
  }, 20_000);

  it("interrupt while awaiting approval → turn ends interrupted, no file", async () => {
    const b = new Browser(stack.url, stack.keys, "browser-A");
    b.start();
    await b.send("create never.txt");
    await poll(() => b.view().pending);
    await b.command({ type: "interrupt" });
    await poll(() => (b.view().state === "idle" ? true : undefined));
    expect(fileExists(root, "never.txt")).toBe(false);
    const hasInterrupted = b.view().items.some((i) => i.kind === "system" && i.text.includes("interrupted"));
    expect(hasInterrupted).toBe(true);
    b.close();
  }, 20_000);

  it("multi-client resume: a fresh second browser backfills the whole transcript", async () => {
    const a = new Browser(stack.url, stack.keys, "browser-A");
    a.start();
    await a.send('create shared.txt with content "two clients"');
    const pending = await poll(() => a.view().pending);
    await a.command({ type: "permission_response", requestId: pending.requestId, decision: "approve" });
    a.model.clearPending();
    await poll(() => (fileExists(root, "shared.txt") ? true : undefined));

    // Second browser connects fresh (cursor 0) → resume backfills the full history.
    // ISSUES #13: poll for the TERMINAL condition (tool item present AND state idle), not just the
    // first tool item — the backfill replays events incrementally, so a poll that fires mid-replay
    // legitimately sees state "tool-running" for a few frames until the final session_status
    // snapshot lands. 3000 attempts ≈ 15s nominal budget also covers full-suite CPU contention.
    const b = new Browser(stack.url, stack.keys, "browser-B");
    b.start();
    await poll(() => {
      const v = b.view();
      return v.items.some((i) => i.kind === "tool") && v.state === "idle" ? true : undefined;
    }, 3000);
    expect(b.view().items.some((i) => i.kind === "tool")).toBe(true);
    expect(b.view().state).toBe("idle");
    expect(b.conn.cursor).toBeGreaterThan(0);
    a.close();
    b.close();
  }, 20_000);

  it("dirty-exit: daemon killed mid-turn → restart → UI unlocks with an error turn", async () => {
    // SessionManager persists the active session id + its journal under `root/.wcc/sessions/<id>/`,
    // so restarting a daemon on the SAME workspace root automatically resumes the same journal —
    // no manual FileJournal wiring needed (unlike the old single-journal Daemon).
    await stack.client.stop();
    await stack.daemon.dispose();
    let d1 = await startDaemon({ url: stack.url, keys: stack.keys, root });

    const b = new Browser(stack.url, stack.keys, "browser-A");
    b.start();
    await b.send("create crash.txt");
    await poll(() => b.view().pending); // turn_start journaled, awaiting approval = dirty if we die now

    // "Kill" the daemon mid-turn (close its relay link + flush the journal to disk).
    await d1.client.stop();
    await d1.daemon.dispose();
    // Connection-level status (distinct from the session state) flips to machine-offline.
    await poll(() => (b.status === "daemon-offline" || b.status === "closed" ? true : undefined));

    // Restart the daemon on the SAME workspace root → it detects the open turn and emits turn_complete{error}.
    const d2 = await startDaemon({ url: stack.url, keys: stack.keys, root });

    // Browser re-hydrates via resume → sees the error turn and unlocks (idle, pending cleared).
    await poll(() => (b.view().state === "idle" ? true : undefined));
    expect(b.view().pending).toBeUndefined();
    const unlocked = b.view().items.some(
      (i) => (i.kind === "system" || i.kind === "error") && JSON.stringify(i).includes("restarted"),
    );
    expect(unlocked).toBe(true);

    b.close();
    await d2.client.stop();
    await d2.daemon.dispose();
    // beforeEach's stack is already torn down; point afterEach at the live relay only.
    stack = { ...stack, daemon: d2.daemon, client: d2.client };
    void d1;
  }, 25_000);
});
