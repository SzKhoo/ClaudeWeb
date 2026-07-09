import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  newEnvelope,
  type ApplicationCommand,
  type ApplicationEvent,
  type ConnHello,
  type EvtPermissionRequest,
  type TransportEnvelope,
} from "@wcc/shared";
import { RelayServer } from "../../relay/src/RelayServer.js";
import { Daemon } from "../src/Daemon.js";
import { DaemonClient } from "../src/transport/DaemonClient.js";
import { MockEngine } from "../src/engine/MockEngine.js";
import { PairingStore } from "../src/security/CommandVerifier.js";
import {
  cleanupWorkspace,
  fileExists,
  makeTempWorkspace,
  makeTestBrowser,
  signCommand,
  type TestBrowser,
} from "./helpers.js";

const TOKEN = "integration-token";
const DEVICE = "dev-device";
const SESSION = "dev-session";

/** A minimal browser peer: registers with the relay, speaks the E2E handshake, collects frames. */
class FakeBrowser {
  private ws!: WebSocket;
  readonly frames: unknown[] = [];

  constructor(
    private readonly url: string,
    private readonly identity: TestBrowser,
  ) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      try {
        this.frames.push(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });
    this.sendJson({
      type: "relay_register",
      token: TOKEN,
      role: "browser",
      deviceId: this.identity.deviceId,
      clientInstanceId: this.identity.clientInstanceId,
    });
    await this.waitForFrame((f) => isType(f, "relay_registered"));
  }

  async handshake(): Promise<void> {
    const hello: ConnHello = {
      type: "conn_hello",
      role: "browser",
      protocolVersion: "1.0.0",
      minProtocolVersion: "1.0.0",
      capabilities: ["stream", "tool-approval", "diff-preview", "interrupt", "resume"],
      deviceId: this.identity.deviceId,
      clientInstanceId: this.identity.clientInstanceId,
    };
    this.sendJson(hello);
    const ack = await this.waitForFrame(
      (f) => isType(f, "conn_ack") && asRecord(f)["clientInstanceId"] === this.identity.clientInstanceId,
    );
    expect(asRecord(ack)["ok"]).toBe(true);
  }

  /** Send a signed command and return the envelope (so it can be replayed in a test). */
  async sendCommand(command: ApplicationCommand): Promise<TransportEnvelope> {
    const env = await signCommand(this.identity, command);
    this.ws.send(JSON.stringify(env));
    return env;
  }

  /** Send an UNSIGNED command envelope (should be rejected by the daemon). */
  sendUnsigned(command: ApplicationCommand, seq: number): void {
    const env = newEnvelope({
      protocolVersion: "1.0.0",
      deviceId: this.identity.deviceId,
      sessionId: this.identity.sessionId,
      clientInstanceId: this.identity.clientInstanceId,
      seq,
      payload: command,
    });
    this.ws.send(JSON.stringify(env));
  }

  sendRaw(env: TransportEnvelope): void {
    this.ws.send(JSON.stringify(env));
  }

  private sendJson(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Events whose payload is addressed to this browser or to "*". */
  events(): ApplicationEvent[] {
    const out: ApplicationEvent[] = [];
    for (const f of this.frames) {
      const r = asRecord(f);
      const payload = r["payload"];
      if (payload && typeof payload === "object" && typeof (payload as { type?: unknown }).type === "string") {
        out.push(payload as ApplicationEvent);
      }
    }
    return out;
  }

  async waitForEvent<T extends ApplicationEvent["type"]>(
    type: T,
  ): Promise<Extract<ApplicationEvent, { type: T }>> {
    const found = await poll(() => this.events().find((e) => e.type === type));
    return found as Extract<ApplicationEvent, { type: T }>;
  }

  private async waitForFrame(pred: (f: unknown) => boolean): Promise<unknown> {
    return poll(() => this.frames.find(pred));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function isType(f: unknown, type: string): boolean {
  return asRecord(f)["type"] === type;
}
function asRecord(f: unknown): Record<string, unknown> {
  return (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
}
async function poll<T>(get: () => T | undefined, attempts = 400): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  const v = get();
  if (v === undefined) throw new Error("poll timed out");
  return v;
}

describe("Daemon ↔ relay ↔ browser integration", () => {
  let relay: RelayServer;
  let client: DaemonClient;
  let daemon: Daemon;
  let root: string;
  let url: string;

  beforeEach(async () => {
    root = makeTempWorkspace();
    relay = new RelayServer({ port: 0, token: TOKEN, logger: () => {} });
    const { port } = await relay.start();
    url = `ws://localhost:${port}`;

    const browserKeys = await SHARED_BROWSER();
    const pairing = new PairingStore();
    pairing.addPublicKey(browserKeys.keys.publicKey);

    daemon = new Daemon({
      deviceId: DEVICE,
      sessionId: SESSION,
      workspaces: [{ workspaceId: "default", name: "test", root }],
      engine: new MockEngine(),
      workspaceRoot: root,
      pairing,
      logger: () => {},
    });
    await daemon.start();
    client = new DaemonClient({ url, token: TOKEN, deviceId: DEVICE, daemon, logger: () => {} });
    await client.start();
  });

  afterEach(async () => {
    await client.stop();
    await daemon.dispose();
    await relay.stop();
    cleanupWorkspace(root);
  });

  it("end-to-end: handshake, signed prompt, approve-with-diff, file created + streamed", async () => {
    const browser = new FakeBrowser(url, await SHARED_BROWSER());
    await browser.connect();
    await browser.handshake();

    await browser.sendCommand({ type: "user_message", text: 'create hello.txt with content "world"' });

    const req = (await browser.waitForEvent("permission_request")) as EvtPermissionRequest;
    expect(req.toolName).toBe("Write");
    expect(req.diff?.unified).toContain("world");
    expect(fileExists(root, "hello.txt")).toBe(false);

    await browser.sendCommand({ type: "permission_response", requestId: req.requestId, decision: "approve" });

    const done = await browser.waitForEvent("turn_complete");
    expect(done.status).toBe("ok");
    expect(fileExists(root, "hello.txt")).toBe(true);

    const stream = browser.events().find((e) => e.type === "tool_stream");
    expect(stream).toBeDefined();
    await browser.close();
  });

  it("rejects an UNSIGNED command at the daemon (relay cannot forge a prompt)", async () => {
    const browser = new FakeBrowser(url, await SHARED_BROWSER());
    await browser.connect();
    await browser.handshake();

    browser.sendUnsigned({ type: "user_message", text: "create forged.txt" }, 1);

    const err = await browser.waitForEvent("error");
    expect(err.code).toBe("rejected_command");
    expect(daemon.stats().rejected).toBeGreaterThanOrEqual(1);
    expect(fileExists(root, "forged.txt")).toBe(false);
    await browser.close();
  });

  it("rejects a REPLAYED approval (same signed envelope sent twice)", async () => {
    const browser = new FakeBrowser(url, await SHARED_BROWSER());
    await browser.connect();
    await browser.handshake();

    await browser.sendCommand({ type: "user_message", text: "create replay.txt" });
    const req = (await browser.waitForEvent("permission_request")) as EvtPermissionRequest;
    const approve = await browser.sendCommand({
      type: "permission_response",
      requestId: req.requestId,
      decision: "approve",
    });
    await browser.waitForEvent("turn_complete");

    const before = daemon.stats().rejected;
    browser.sendRaw(approve); // replay the already-consumed envelope
    await poll(() => (daemon.stats().rejected > before ? true : undefined));
    expect(daemon.stats().rejected).toBeGreaterThan(before);
    await browser.close();
  });
});

/**
 * Both the daemon's pairing and the browser must use the SAME keypair (Phase 0 "env pairing"). We
 * generate it once per test via a module-scoped memo so the daemon pairs the exact key the browser signs
 * with.
 */
let _shared: TestBrowser | undefined;
async function SHARED_BROWSER(): Promise<TestBrowser> {
  if (!_shared) _shared = await makeTestBrowser({ deviceId: DEVICE, sessionId: SESSION });
  return _shared;
}
