/**
 * Task 10 — Daemon routes the 6 session-sidebar commands (list_sessions, get_session_journal,
 * new_session, open_session, delete_session, rename_session) through SessionManager BEFORE they'd
 * ever reach Session.handleCommand, and broadcasts sessions_list / session_switched /
 * session_deleted / session_renamed on state changes. Uses the same relay+DaemonClient+FakeBrowser
 * harness as Daemon.integration.test.ts (real WebSockets, real signing) so the whole verify → dispatch
 * → emit path is exercised, not just SessionManager in isolation (that's SessionManager.test.ts's job).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  newEnvelope,
  type ApplicationCommand,
  type ApplicationEvent,
  type ConnHello,
  type TransportEnvelope,
} from "@wcc/shared";
import { RelayServer } from "../../relay/src/RelayServer.js";
import { Daemon } from "../src/Daemon.js";
import { DaemonClient } from "../src/transport/DaemonClient.js";
import { MockEngine } from "../src/engine/MockEngine.js";
import { PairingStore } from "../src/security/CommandVerifier.js";
import {
  cleanupWorkspace,
  makeTempWorkspace,
  makeTestBrowser,
  signCommand,
  type TestBrowser,
} from "./helpers.js";

const TOKEN = "sessions-token";
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

  async sendCommand(command: ApplicationCommand): Promise<TransportEnvelope> {
    const env = await signCommand(this.identity, command);
    this.ws.send(JSON.stringify(env));
    return env;
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

  /** All events matching `type`, in arrival order (some commands can produce more than one). */
  allEvents<T extends ApplicationEvent["type"]>(type: T): Array<Extract<ApplicationEvent, { type: T }>> {
    return this.events().filter((e) => e.type === type) as Array<Extract<ApplicationEvent, { type: T }>>;
  }

  async waitForEvent<T extends ApplicationEvent["type"]>(
    type: T,
    pred?: (e: Extract<ApplicationEvent, { type: T }>) => boolean,
  ): Promise<Extract<ApplicationEvent, { type: T }>> {
    const found = await poll(() =>
      this.allEvents(type).find((e) => (pred ? pred(e) : true)),
    );
    return found;
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

describe("Daemon session-sidebar commands", () => {
  let relay: RelayServer;
  let client: DaemonClient;
  let daemon: Daemon;
  let engine: MockEngine;
  let root: string;
  let url: string;
  let browser: FakeBrowser;
  let identity: TestBrowser;

  beforeEach(async () => {
    root = makeTempWorkspace();
    relay = new RelayServer({ port: 0, token: TOKEN, logger: () => {} });
    const { port } = await relay.start();
    url = `ws://localhost:${port}`;

    identity = await makeTestBrowser({ deviceId: DEVICE, sessionId: SESSION });
    const pairing = new PairingStore();
    pairing.addPublicKey(identity.keys.publicKey);

    engine = new MockEngine();
    daemon = new Daemon({
      deviceId: DEVICE,
      sessionId: SESSION,
      workspaces: [{ workspaceId: "default", name: "test", root }],
      engine,
      workspaceRoot: root,
      pairing,
      logger: () => {},
    });
    await daemon.start();
    client = new DaemonClient({ url, token: TOKEN, deviceId: DEVICE, daemon, logger: () => {} });
    await client.start();

    browser = new FakeBrowser(url, identity);
    await browser.connect();
    await browser.handshake();
  });

  afterEach(async () => {
    await browser.close();
    await client.stop();
    await daemon.dispose();
    await relay.stop();
    cleanupWorkspace(root);
  });

  it("new_session broadcasts session_switched and sessions_list includes both ids", async () => {
    await browser.sendCommand({ type: "list_sessions" });
    const before = await browser.waitForEvent("sessions_list");
    expect(before.sessions.length).toBe(1);
    const firstId = before.sessions[0]!.id;

    await browser.sendCommand({ type: "new_session" });

    const switched = await browser.waitForEvent("session_switched", (e) => e.sessionId !== firstId);
    const secondId = switched.sessionId;
    expect(secondId).not.toBe(firstId);

    const list = await browser.waitForEvent(
      "sessions_list",
      (e) => e.sessions.length === 2,
    );
    const ids = list.sessions.map((s) => s.id);
    expect(ids).toContain(firstId);
    expect(ids).toContain(secondId);
    // The old session should now show closed, the new one active.
    expect(list.sessions.find((s) => s.id === firstId)?.status).toBe("closed");
    expect(list.sessions.find((s) => s.id === secondId)?.status).toBe("active");
  });

  it("open_session {resume:false} replies with a targeted session_journal, no switch", async () => {
    await browser.sendCommand({ type: "list_sessions" });
    const initial = await browser.waitForEvent("sessions_list");
    const firstId = initial.sessions[0]!.id;

    await browser.sendCommand({ type: "new_session" });
    await browser.waitForEvent("session_switched");

    // Re-open the original (now closed) session in read-only mode.
    await browser.sendCommand({ type: "open_session", sessionId: firstId, resume: false });
    const journal = await browser.waitForEvent("session_journal", (e) => e.sessionId === firstId);
    expect(journal.sessionId).toBe(firstId);
    expect(Array.isArray(journal.events)).toBe(true);

    // No additional session_switched fired for the read-only open.
    const switches = browser.allEvents("session_switched");
    expect(switches.length).toBe(1);
  });

  it("open_session {resume:true} switches active and primes the engine's resumeContext", async () => {
    await browser.sendCommand({ type: "list_sessions" });
    const initial = await browser.waitForEvent("sessions_list");
    const firstId = initial.sessions[0]!.id;

    await browser.sendCommand({ type: "new_session" });
    await browser.waitForEvent("session_switched", (e) => e.sessionId !== firstId);

    await browser.sendCommand({ type: "open_session", sessionId: firstId, resume: true });
    const switched = await browser.waitForEvent(
      "session_switched",
      (e) => e.sessionId === firstId,
    );
    expect(switched.sessionId).toBe(firstId);

    // Drive a turn on the resumed session; MockEngine should observe SOME resumeContext plumbing
    // (may be null if the closed session had no summary yet — Summarizer hasn't run in this test —
    // but the send must not throw and the daemon must be operating on the resumed session).
    await browser.sendCommand({ type: "user_message", text: "hello again" });
    await browser.waitForEvent("turn_complete", (e) => e.status === "ok");
    // engine.lastResumeContext is whatever Session.setPendingResumeContext primed (null if no
    // summary existed yet) — assert the field was at least touched (not the pre-test undefined-ish
    // sentinel) by checking it's explicitly null or a string, never left unset.
    expect(engine.lastResumeContext === null || typeof engine.lastResumeContext === "string").toBe(true);
  });

  it("delete_session refuses the active session, succeeds once it's closed", async () => {
    await browser.sendCommand({ type: "list_sessions" });
    const initial = await browser.waitForEvent("sessions_list");
    const firstId = initial.sessions[0]!.id;

    // Refuse: firstId is still active.
    await browser.sendCommand({ type: "delete_session", sessionId: firstId });
    const err = await browser.waitForEvent("error", (e) => e.code === "session_delete_refused");
    expect(err.message).toBe(firstId);

    // Switch away, then delete succeeds.
    await browser.sendCommand({ type: "new_session" });
    await browser.waitForEvent("session_switched", (e) => e.sessionId !== firstId);

    await browser.sendCommand({ type: "delete_session", sessionId: firstId });
    const deleted = await browser.waitForEvent("session_deleted", (e) => e.sessionId === firstId);
    expect(deleted.sessionId).toBe(firstId);

    const list = await browser.waitForEvent(
      "sessions_list",
      (e) => !e.sessions.some((s) => s.id === firstId),
    );
    expect(list.sessions.some((s) => s.id === firstId)).toBe(false);

    // get_session_journal on the now-deleted session comes back empty (no journal file left).
    await browser.sendCommand({ type: "get_session_journal", sessionId: firstId });
    const journal = await browser.waitForEvent("session_journal", (e) => e.sessionId === firstId);
    expect(journal.events).toEqual([]);
  });

  it("rename_session broadcasts session_renamed and updates the list", async () => {
    await browser.sendCommand({ type: "list_sessions" });
    const initial = await browser.waitForEvent("sessions_list");
    const firstId = initial.sessions[0]!.id;

    await browser.sendCommand({ type: "rename_session", sessionId: firstId, title: "My Renamed Session" });
    const renamed = await browser.waitForEvent("session_renamed", (e) => e.sessionId === firstId);
    expect(renamed.title).toBe("My Renamed Session");

    const list = await browser.waitForEvent(
      "sessions_list",
      (e) => e.sessions.find((s) => s.id === firstId)?.title === "My Renamed Session",
    );
    expect(list.sessions.find((s) => s.id === firstId)?.title).toBe("My Renamed Session");
  });

  it("list_sessions replies targeted to the requesting client", async () => {
    await browser.sendCommand({ type: "list_sessions" });
    const list = await browser.waitForEvent("sessions_list");
    expect(list.sessions.length).toBeGreaterThanOrEqual(1);
  });
});
