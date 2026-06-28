import { describe, expect, it, beforeEach } from "vitest";
import { MockAuthClient } from "../src/auth-client.js";
import { verifyJwtHs256 } from "@wcc/shared";

const SECRET = new TextEncoder().encode("test-jwt-secret-32-bytes-long-pls!");

// localStorage mock for node — vitest's happy-dom/jsdom isn't configured for this package.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
});

describe("MockAuthClient", () => {
  it("starts signed-out, then signs in with a verifiable JWT", async () => {
    const client = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "alice@example.com": { userId: "alice", password: "pw" } },
    });
    expect(client.current()).toEqual({ status: "signed-out" });

    const session = await client.signInWithPassword("alice@example.com", "pw");
    expect(session.userId).toBe("alice");
    expect(client.current()).toMatchObject({ status: "signed-in", session: { userId: "alice" } });

    const verified = await verifyJwtHs256(session.accessToken, SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims.sub).toBe("alice");
  });

  it("rejects wrong password", async () => {
    const client = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "alice@example.com": { userId: "alice", password: "pw" } },
    });
    await expect(client.signInWithPassword("alice@example.com", "WRONG")).rejects.toThrow(/invalid/);
    expect(client.current()).toEqual({ status: "signed-out" });
  });

  it("subscribe fires on state change and unsubscribe stops it", async () => {
    const client = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "u@e.com": { userId: "u", password: "p" } },
    });
    const events: string[] = [];
    const off = client.subscribe((s) => events.push(s.status));
    expect(events).toEqual(["signed-out"]);
    await client.signInWithPassword("u@e.com", "p");
    expect(events).toEqual(["signed-out", "signed-in"]);
    off();
    await client.signOut();
    expect(events).toEqual(["signed-out", "signed-in"]); // listener removed
  });

  it("persists session across instances via localStorage", async () => {
    const a = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "u@e.com": { userId: "u", password: "p" } },
    });
    await a.signInWithPassword("u@e.com", "p");

    const b = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "u@e.com": { userId: "u", password: "p" } },
    });
    expect(b.current()).toMatchObject({ status: "signed-in", session: { userId: "u" } });
  });

  it("signOut clears persisted state", async () => {
    const a = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "u@e.com": { userId: "u", password: "p" } },
    });
    await a.signInWithPassword("u@e.com", "p");
    await a.signOut();
    const b = new MockAuthClient({
      jwtSecret: SECRET,
      users: { "u@e.com": { userId: "u", password: "p" } },
    });
    expect(b.current()).toEqual({ status: "signed-out" });
  });
});
