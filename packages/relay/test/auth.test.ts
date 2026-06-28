/**
 * Relay authorization (S1.3 / decision D2). Cross-user device isolation, per-role token paths,
 * legacy shared-token preservation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RelayServer } from "../src/RelayServer.js";
import {
  InMemoryDaemonTokenStore,
  InMemoryDirectory,
  JwtAuthVerifier,
} from "../src/auth.js";
import { signJwtHs256 } from "@wcc/shared";

const JWT_SECRET = new TextEncoder().encode("phase-1-test-secret-please-rotate!");

class TC {
  private readonly queue: Array<unknown> = [];
  private readonly waiters: Array<(m: unknown) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = undefined;
      }
      const w = this.waiters.shift();
      if (w) w(parsed);
      else this.queue.push(parsed);
    });
  }
  static connect(url: string): Promise<TC> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new TC(ws)));
      ws.once("error", reject);
    });
  }
  next(): Promise<unknown> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
  waitClose(): Promise<number> {
    return new Promise((resolve) => this.ws.once("close", (code) => resolve(code)));
  }
}

async function mintBrowserJwt(userId: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  return signJwtHs256({ sub: userId, iat: nowS, exp: nowS + 300 }, JWT_SECRET);
}

describe("RelayServer + JwtAuthVerifier (S1.3)", () => {
  let server: RelayServer;
  let url: string;
  let directory: InMemoryDirectory;
  let daemonTokens: InMemoryDaemonTokenStore;
  const clients: TC[] = [];

  beforeEach(async () => {
    directory = new InMemoryDirectory();
    daemonTokens = new InMemoryDaemonTokenStore();
    // Two users; alice owns dev-A, bob owns dev-B.
    directory.add("alice", "dev-A");
    directory.add("bob", "dev-B");
    await daemonTokens.issue("d-token-A", { userId: "alice", deviceId: "dev-A" });
    await daemonTokens.issue("d-token-B", { userId: "bob", deviceId: "dev-B" });

    const auth = new JwtAuthVerifier({ jwtSecret: JWT_SECRET, directory, daemonTokens });
    server = new RelayServer({
      port: 0,
      auth,
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

  async function client(): Promise<TC> {
    const c = await TC.connect(url);
    clients.push(c);
    return c;
  }

  it("browser with valid JWT for an owned device → registered", async () => {
    const jwt = await mintBrowserJwt("alice");
    const c = await client();
    c.send({ type: "relay_register", token: jwt, role: "browser", deviceId: "dev-A" });
    expect(await c.next()).toMatchObject({ type: "relay_registered", ok: true });
  });

  it("browser with valid JWT for a DIFFERENT user's device → forbidden", async () => {
    const jwt = await mintBrowserJwt("alice"); // alice
    const c = await client();
    c.send({ type: "relay_register", token: jwt, role: "browser", deviceId: "dev-B" }); // bob's device
    expect(await c.next()).toMatchObject({ type: "relay_error", code: "forbidden" });
    await c.waitClose();
  });

  it("browser with invalid JWT (wrong signature) → bad_token", async () => {
    const wrongSecret = new TextEncoder().encode("not-the-real-secret-padded-up!!!!");
    const jwt = await signJwtHs256({ sub: "alice", exp: Math.floor(Date.now() / 1000) + 60 }, wrongSecret);
    const c = await client();
    c.send({ type: "relay_register", token: jwt, role: "browser", deviceId: "dev-A" });
    expect(await c.next()).toMatchObject({ type: "relay_error", code: "bad_token" });
    await c.waitClose();
  });

  it("daemon with valid token for its own deviceId → registered", async () => {
    const c = await client();
    c.send({ type: "relay_register", token: "d-token-A", role: "daemon", deviceId: "dev-A" });
    expect(await c.next()).toMatchObject({ type: "relay_registered", ok: true, role: "daemon" });
  });

  it("daemon with valid token but mismatched deviceId → forbidden", async () => {
    const c = await client();
    c.send({ type: "relay_register", token: "d-token-A", role: "daemon", deviceId: "dev-B" });
    expect(await c.next()).toMatchObject({ type: "relay_error", code: "forbidden" });
    await c.waitClose();
  });

  it("daemon with unknown token → bad_token", async () => {
    const c = await client();
    c.send({ type: "relay_register", token: "nope", role: "daemon", deviceId: "dev-A" });
    expect(await c.next()).toMatchObject({ type: "relay_error", code: "bad_token" });
    await c.waitClose();
  });

  it("isolation: alice's browser cannot route to bob's daemon (different devices)", async () => {
    // bob's daemon up
    const dB = await client();
    dB.send({ type: "relay_register", token: "d-token-B", role: "daemon", deviceId: "dev-B" });
    expect(await dB.next()).toMatchObject({ type: "relay_registered" });

    // alice tries to attach to bob's device — rejected at register time.
    const aJwt = await mintBrowserJwt("alice");
    const bBad = await client();
    bBad.send({ type: "relay_register", token: aJwt, role: "browser", deviceId: "dev-B" });
    expect(await bBad.next()).toMatchObject({ type: "relay_error", code: "forbidden" });
    await bBad.waitClose();

    // alice on her own device — fine, but she sees no peer (no daemon for dev-A).
    const aJwt2 = await mintBrowserJwt("alice");
    const bA = await client();
    bA.send({ type: "relay_register", token: aJwt2, role: "browser", deviceId: "dev-A" });
    expect(await bA.next()).toMatchObject({ type: "relay_registered", peerOnline: false });
  });

  it("legacy shared-token mode still works when no auth verifier is injected", async () => {
    await server.stop();
    server = new RelayServer({
      port: 0,
      token: "legacy-token",
      logger: () => {},
      heartbeatMs: 60_000,
      registerTimeoutMs: 2_000,
    });
    const { port } = await server.start();
    url = `ws://127.0.0.1:${port}`;
    const c = await client();
    c.send({ type: "relay_register", token: "legacy-token", role: "daemon", deviceId: "dev-X" });
    expect(await c.next()).toMatchObject({ type: "relay_registered", ok: true });
  });

  it("throws if neither auth nor token is provided", () => {
    expect(
      () =>
        new RelayServer({
          port: 0,
          logger: () => {},
        }),
    ).toThrow(/auth.*token/);
  });
});
