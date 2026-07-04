import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayServer } from "../src/RelayServer.js";
import { newEnvelope } from "@wcc/shared";
import { generateKeyPair, signed } from "@wcc/shared";

const TOKEN = "test-token";

/** Buffers inbound frames so tests can await them deterministically (no message races). */
class TestClient {
  private readonly queue: Array<{ parsed: unknown; text: string; isBinary: boolean }> = [];
  private readonly waiters: Array<(m: { parsed: unknown; text: string; isBinary: boolean }) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      const text = data.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const msg = { parsed, text, isBinary };
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
    });
  }

  next(): Promise<{ parsed: unknown; text: string; isBinary: boolean }> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Resolve true if NO message arrives within ms (used for isolation assertions). */
  async silentFor(ms: number): Promise<boolean> {
    const got = this.next().then(() => false);
    const quiet = new Promise<boolean>((r) => setTimeout(() => r(true), ms));
    return Promise.race([got, quiet]);
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  async register(
    role: "daemon" | "browser",
    deviceId: string,
    token = TOKEN,
    clientInstanceId?: string,
  ): Promise<{ parsed: unknown; text: string }> {
    this.send({ type: "relay_register", token, role, deviceId, clientInstanceId });
    return this.next();
  }

  close(): void {
    this.ws.close();
  }

  waitClose(): Promise<number> {
    return new Promise((resolve) => this.ws.once("close", (code) => resolve(code)));
  }
}

describe("RelayServer", () => {
  let server: RelayServer;
  let url: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    server = new RelayServer({
      port: 0,
      token: TOKEN,
      logger: () => {},
      heartbeatMs: 60_000,
      registerTimeoutMs: 2_000,
    });
    const { port } = await server.start();
    url = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.stop();
  });

  async function client(): Promise<TestClient> {
    const c = await TestClient.connect(url);
    clients.push(c);
    return c;
  }

  it("rejects a bad token and closes the socket", async () => {
    const c = await client();
    const res = await c.register("browser", "dev-1", "WRONG");
    expect(res.parsed).toMatchObject({ type: "relay_error", code: "bad_token" });
    await c.waitClose();
  });

  it("serves an HTTP 200 health check at /healthz (for platform probes)", async () => {
    const httpUrl = url.replace(/^ws/, "http") + "/healthz";
    const res = await fetch(httpUrl);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
  });

  it("rejects a malformed first frame", async () => {
    const c = await client();
    c.send("this is not json");
    const res = await c.next();
    expect(res.parsed).toMatchObject({ type: "relay_error", code: "bad_register" });
  });

  it("acks a valid registration", async () => {
    const c = await client();
    const res = await c.register("daemon", "dev-1");
    expect(res.parsed).toMatchObject({ type: "relay_registered", ok: true, role: "daemon", deviceId: "dev-1" });
  });

  it("routes a browser frame to the device's daemon (and back)", async () => {
    const daemon = await client();
    await daemon.register("daemon", "dev-1");
    const browser = await client();
    const reg = await browser.register("browser", "dev-1", TOKEN, "client-A");
    expect(reg.parsed).toMatchObject({ type: "relay_registered", peerOnline: true });

    const up = JSON.stringify({ payload: { type: "user_message", text: "hi" }, seq: 1 });
    browser.send(up);
    expect((await daemon.next()).text).toBe(up);

    const down = JSON.stringify({ payload: { type: "assistant_delta", text: "yo" }, seq: 2 });
    daemon.send(down);
    expect((await browser.next()).text).toBe(down);
  });

  it("forwards application frames OPAQUELY — a signed envelope arrives byte-identical", async () => {
    const daemon = await client();
    await daemon.register("daemon", "dev-1");
    const browser = await client();
    await browser.register("browser", "dev-1", TOKEN, "client-A");

    const kp = await generateKeyPair();
    const env = await signed(
      newEnvelope({
        protocolVersion: "1.0.0",
        deviceId: "dev-1",
        sessionId: "sess-1",
        clientInstanceId: "client-A",
        seq: 1,
        payload: { type: "user_message", text: "create hello.txt" },
      }),
      kp.secretKey,
    );
    const wire = JSON.stringify(env);
    browser.send(wire);
    const received = await daemon.next();
    expect(received.text).toBe(wire); // not parsed, not reordered, not re-signed
  });

  it("broadcasts a daemon frame to every browser on the device", async () => {
    const daemon = await client();
    await daemon.register("daemon", "dev-1");
    const b1 = await client();
    await b1.register("browser", "dev-1", TOKEN, "A");
    const b2 = await client();
    await b2.register("browser", "dev-1", TOKEN, "B");

    const evt = JSON.stringify({ payload: { type: "assistant_delta", text: "broadcast" } });
    daemon.send(evt);
    expect((await b1.next()).text).toBe(evt);
    expect((await b2.next()).text).toBe(evt);
  });

  it("does NOT cross-route between different devices", async () => {
    const d1 = await client();
    await d1.register("daemon", "dev-1");
    const d2 = await client();
    await d2.register("daemon", "dev-2");
    const browser = await client();
    await browser.register("browser", "dev-1");

    browser.send(JSON.stringify({ payload: { type: "user_message", text: "only for dev-1" } }));
    expect((await d1.next()).text).toContain("only for dev-1");
    expect(await d2.silentFor(150)).toBe(true); // dev-2 daemon hears nothing
  });

  it("tells a browser the device is offline when no daemon is connected", async () => {
    const browser = await client();
    const reg = await browser.register("browser", "lonely-dev");
    expect(reg.parsed).toMatchObject({ type: "relay_registered", peerOnline: false });
    browser.send(JSON.stringify({ payload: { type: "user_message", text: "anyone?" } }));
    expect((await browser.next()).parsed).toMatchObject({ type: "relay_error", code: "device_offline" });
  });

  it("notifies browsers of daemon presence changes", async () => {
    const browser = await client();
    await browser.register("browser", "dev-1");
    const daemon = await client();
    await daemon.register("daemon", "dev-1");
    expect((await browser.next()).parsed).toMatchObject({ type: "relay_peer", role: "daemon", online: true });

    daemon.close();
    expect((await browser.next()).parsed).toMatchObject({ type: "relay_peer", role: "daemon", online: false });
  });

  it("replaces a reconnecting daemon and terminates the stale socket", async () => {
    const daemonOld = await client();
    await daemonOld.register("daemon", "dev-1");
    const daemonNew = await client();
    const closedPromise = daemonOld.waitClose();
    await daemonNew.register("daemon", "dev-1");
    await closedPromise; // old socket was terminated by the relay
    expect(server.stats().daemons).toBe(1);
  });
});
