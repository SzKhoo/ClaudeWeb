/**
 * S1.4 — daemon enrollment wiring. Exercises the full pairing protocol round-trip + revocation +
 * idempotency + rejection vectors, without going through a real WebSocket.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEnrollRequest,
  fromBase64Url,
  generateCode,
  generateKeyPair,
  toBase64Url,
  verifyEnrollAck,
  type KeyPair,
} from "@wcc/shared";
import { EnrolledKeyStore } from "../src/security/EnrolledKeyStore.js";
import { EnrollmentManager } from "../src/security/EnrollmentManager.js";
import { PairingCodeStore } from "../src/security/PairingCodeStore.js";
import { CommandVerifier } from "../src/security/CommandVerifier.js";
import {
  newEnvelope,
  signed,
  signEnvelope,
} from "@wcc/shared";

const DEVICE_ID = "device-1";
const SESSION_ID = "sess-1";

interface Ctx {
  tmpDir: string;
  storePath: string;
  store: EnrolledKeyStore;
  codes: PairingCodeStore;
  device: KeyPair;
  manager: EnrollmentManager;
}

async function setup(now: () => number = Date.now): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), "wcc-enroll-"));
  const storePath = join(tmpDir, "keys.json");
  const store = await EnrolledKeyStore.open(storePath);
  const codes = new PairingCodeStore({ now });
  const device = await generateKeyPair();
  let n = 0;
  const manager = new EnrollmentManager({
    deviceId: DEVICE_ID,
    enrolledKeys: store,
    codes,
    deviceSecretKey: device.secretKey,
    devicePubKey: device.publicKey,
    now,
    newKeyId: () => `k-${++n}`,
  });
  return { tmpDir, storePath, store, codes, device, manager };
}

function cleanup(ctx: Ctx): void {
  try {
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe("EnrollmentManager", () => {
  let ctx: Ctx;
  afterEach(() => cleanup(ctx));

  it("happy path: mint code → enroll_request → device-signed enroll_ack → key is active", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode("iPhone");
    const browser = await generateKeyPair();

    const req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: browser.publicKey,
      pairingCode: code,
      label: "iPhone",
    });
    const ack = await ctx.manager.handle(req);
    expect(ack.ok).toBe(true);
    expect(ack.keyId).toBe("k-1");
    expect(
      await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: toBase64Url(browser.publicKey),
        expectedDevicePubKey: ctx.device.publicKey,
      }),
    ).toBe(true);
    expect(ctx.store.size).toBe(1);
    expect(ctx.store.findActiveByPubkey(toBase64Url(browser.publicKey))).toBeDefined();
  });

  it("enrolled key is accepted by CommandVerifier; revoked key is rejected", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode();
    const browser = await generateKeyPair();
    const ack = await ctx.manager.handle(
      await buildEnrollRequest({
        deviceId: DEVICE_ID,
        browserPubKey: browser.publicKey,
        pairingCode: code,
      }),
    );
    expect(ack.ok).toBe(true);

    // Sign a normal command with the enrolled key. CommandVerifier consuming the EnrolledKeyStore
    // should accept it.
    const verifier = new CommandVerifier(ctx.store);
    const env = await signed(
      newEnvelope({
        protocolVersion: "1.0.0",
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        clientInstanceId: toBase64Url(browser.publicKey),
        seq: 1,
        payload: { type: "user_message", text: "hi" },
      }),
      browser.secretKey,
    );
    const r1 = await verifier.verify(env);
    expect(r1.ok).toBe(true);

    // Revoke; a fresh signed command (new seq) should now be unauthorized.
    expect(await ctx.manager.revoke(ack.keyId!)).toBe(true);
    const verifier2 = new CommandVerifier(ctx.store);
    const env2 = await signed(
      newEnvelope({
        protocolVersion: "1.0.0",
        deviceId: DEVICE_ID,
        sessionId: SESSION_ID,
        clientInstanceId: toBase64Url(browser.publicKey),
        seq: 2,
        payload: { type: "user_message", text: "hi after revoke" },
      }),
      browser.secretKey,
    );
    const r2 = await verifier2.verify(env2);
    expect(r2).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("wrong code → enroll_ack ok=false reason=bad_code", async () => {
    ctx = await setup();
    ctx.manager.mintCode();
    const browser = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: browser.publicKey,
      pairingCode: generateCode(), // a totally different code
    });
    const ack = await ctx.manager.handle(req);
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("bad_code");
    expect(ctx.store.size).toBe(0);
  });

  it("wrong deviceId in request → enroll_ack ok=false reason=tampered", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode();
    const browser = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId: "different-device",
      browserPubKey: browser.publicKey,
      pairingCode: code,
    });
    const ack = await ctx.manager.handle(req);
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("tampered");
  });

  it("relay swaps browserPubKey but keeps the original tag → bad_code (HMAC fails)", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode();
    const real = await generateKeyPair();
    const attacker = await generateKeyPair();
    const real_req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: real.publicKey,
      pairingCode: code,
    });
    const tampered = { ...real_req, browserPubKey: toBase64Url(attacker.publicKey) };
    const ack = await ctx.manager.handle(tampered);
    expect(ack.ok).toBe(false);
    expect(ack.reason).toBe("bad_code");
    expect(ctx.store.size).toBe(0);
  });

  it("idempotent retry by the SAME browser pubkey returns the same enrolled record", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode();
    const browser = await generateKeyPair();
    const ack1 = await ctx.manager.handle(
      await buildEnrollRequest({
        deviceId: DEVICE_ID,
        browserPubKey: browser.publicKey,
        pairingCode: code,
      }),
    );
    expect(ack1.ok).toBe(true);
    const ack2 = await ctx.manager.handle(
      await buildEnrollRequest({
        deviceId: DEVICE_ID,
        browserPubKey: browser.publicKey,
        pairingCode: code,
      }),
    );
    expect(ack2.ok).toBe(true);
    expect(ack2.keyId).toBe(ack1.keyId);
    expect(ctx.store.size).toBe(1);
  });

  it("second browser cannot reuse a code already consumed by the first → consumed", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode();
    const b1 = await generateKeyPair();
    const b2 = await generateKeyPair();
    const ack1 = await ctx.manager.handle(
      await buildEnrollRequest({ deviceId: DEVICE_ID, browserPubKey: b1.publicKey, pairingCode: code }),
    );
    expect(ack1.ok).toBe(true);
    const ack2 = await ctx.manager.handle(
      await buildEnrollRequest({ deviceId: DEVICE_ID, browserPubKey: b2.publicKey, pairingCode: code }),
    );
    expect(ack2.ok).toBe(false);
    expect(ack2.reason).toBe("consumed");
    expect(ctx.store.size).toBe(1);
  });

  it("expired pairing code → bad_code (lookup prunes; nothing matches)", async () => {
    let now = 1_700_000_000_000;
    ctx = await setup(() => now);
    const code = ctx.manager.mintCode();
    now += 6 * 60_000; // 6 min later — past the 5-min code TTL
    const browser = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: browser.publicKey,
      pairingCode: code,
      timestamp: now,
    });
    const ack = await ctx.manager.handle(req);
    expect(ack.ok).toBe(false);
    expect(["bad_code", "stale"]).toContain(ack.reason);
  });

  it("EnrolledKeyStore persists across reopen", async () => {
    ctx = await setup();
    const code = ctx.manager.mintCode();
    const browser = await generateKeyPair();
    await ctx.manager.handle(
      await buildEnrollRequest({
        deviceId: DEVICE_ID,
        browserPubKey: browser.publicKey,
        pairingCode: code,
        label: "kept",
      }),
    );
    expect(ctx.store.size).toBe(1);

    // Reopen — should load the same key list
    const reopened = await EnrolledKeyStore.open(ctx.storePath);
    expect(reopened.size).toBe(1);
    const records = reopened.all();
    expect(records[0]!.label).toBe("kept");
    expect(records[0]!.pubkey).toBe(toBase64Url(browser.publicKey));
  });
});
