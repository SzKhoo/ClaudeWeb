/**
 * S3.2 AEAD payload wrapping (Phase 2b, ISSUES #15) — the "encrypt later" half of "sign now,
 * encrypt later". The pairing exchange already derives a shared 32-byte channel key on both sides
 * (see x25519.test.ts). This module wraps a fully-signed TransportEnvelope in an outer EncryptedFrame
 * so the relay forwards ciphertext: only `deviceId` stays cleartext (invariant #5 routing), and it's
 * bound as AES-GCM AAD so a relay cannot retarget a ciphertext to another device.
 *
 * The whole existing sign/verify/replay pipeline is unchanged — it runs on the DECRYPTED inner
 * envelope exactly as before. These tests prove: exact round-trip, confidentiality, and that any
 * tamper (wrong key, mutated ciphertext/nonce, swapped deviceId AAD) is rejected.
 */
import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  newEnvelope,
  signed,
  toBase64Url,
  verifyEnvelope,
  PROTOCOL_VERSION,
} from "../src/index.js";
import {
  isEncryptedFrame,
  importChannelKey,
  openEnvelope,
  sealEnvelope,
} from "../src/protocol/seal.js";
import type { TransportEnvelope } from "../src/index.js";

const DEVICE_ID = "device-abc";
const SECRET_MARKER = "TOP-SECRET-PROMPT-9f3a";

async function makeSignedEnvelope(): Promise<{ env: TransportEnvelope; pub: Uint8Array }> {
  const kp = await generateKeyPair();
  const base = newEnvelope({
    protocolVersion: PROTOCOL_VERSION,
    deviceId: DEVICE_ID,
    sessionId: "sess-1",
    clientInstanceId: "browser-1",
    seq: 7,
    timestamp: 1_700_000_000_000,
    payload: { type: "user_message", text: SECRET_MARKER } as never,
  });
  const env = await signed(base, kp.secretKey);
  return { env, pub: kp.publicKey };
}

function randomChannelKey(): Uint8Array {
  const k = new Uint8Array(32);
  crypto.getRandomValues(k);
  return k;
}

describe("sealEnvelope / openEnvelope", () => {
  it("round-trips an envelope byte-for-byte through seal→open", async () => {
    const { env } = await makeSignedEnvelope();
    const key = randomChannelKey();
    const frame = await sealEnvelope(env, key);
    const back = await openEnvelope(frame, key);
    expect(back).toEqual(env);
  });

  it("produces an EncryptedFrame with only deviceId cleartext (payload is confidential)", async () => {
    const { env } = await makeSignedEnvelope();
    const key = randomChannelKey();
    const frame = await sealEnvelope(env, key);
    expect(isEncryptedFrame(frame)).toBe(true);
    expect(frame.deviceId).toBe(DEVICE_ID);
    // The plaintext prompt must not appear anywhere in the serialized frame.
    expect(JSON.stringify(frame)).not.toContain(SECRET_MARKER);
    // Neither should the signature, sessionId or clientInstanceId leak in cleartext.
    expect(JSON.stringify(frame)).not.toContain("sess-1");
    expect(JSON.stringify(frame)).not.toContain(env.sig!);
  });

  it("preserves the Ed25519 signature so the opened envelope still verifies", async () => {
    const { env, pub } = await makeSignedEnvelope();
    const key = randomChannelKey();
    const frame = await sealEnvelope(env, key);
    const back = await openEnvelope(frame, key);
    const result = await verifyEnvelope(back, pub, { now: 1_700_000_000_000 });
    expect(result.ok).toBe(true);
  });

  it("uses a fresh random nonce per seal (same input → different ciphertext)", async () => {
    const { env } = await makeSignedEnvelope();
    const key = randomChannelKey();
    const a = await sealEnvelope(env, key);
    const b = await sealEnvelope(env, key);
    expect(a.enc.n).not.toBe(b.enc.n);
    expect(a.enc.ct).not.toBe(b.enc.ct);
    // Both still decrypt to the same envelope.
    expect(await openEnvelope(a, key)).toEqual(env);
    expect(await openEnvelope(b, key)).toEqual(env);
  });

  it("rejects opening with the wrong key", async () => {
    const { env } = await makeSignedEnvelope();
    const frame = await sealEnvelope(env, randomChannelKey());
    await expect(openEnvelope(frame, randomChannelKey())).rejects.toThrow();
  });

  it("rejects a frame whose ciphertext was tampered with", async () => {
    const { env } = await makeSignedEnvelope();
    const key = randomChannelKey();
    const frame = await sealEnvelope(env, key);
    const ctBytes = Array.from(atob(frame.enc.ct.replace(/-/g, "+").replace(/_/g, "/")));
    ctBytes[0] = String.fromCharCode(ctBytes[0]!.charCodeAt(0) ^ 0xff);
    const tampered = { ...frame, enc: { ...frame.enc, ct: toBase64Url(Uint8Array.from(ctBytes.map((c) => c.charCodeAt(0)))) } };
    await expect(openEnvelope(tampered, key)).rejects.toThrow();
  });

  it("rejects a frame whose deviceId (AAD) was swapped by the relay", async () => {
    const { env } = await makeSignedEnvelope();
    const key = randomChannelKey();
    const frame = await sealEnvelope(env, key);
    const retargeted = { ...frame, deviceId: "attacker-device" };
    await expect(openEnvelope(retargeted, key)).rejects.toThrow();
  });

  it("accepts either raw key bytes or an imported CryptoKey", async () => {
    const { env } = await makeSignedEnvelope();
    const raw = randomChannelKey();
    const cryptoKey = await importChannelKey(raw);
    const frame = await sealEnvelope(env, cryptoKey);
    expect(await openEnvelope(frame, raw)).toEqual(env);
  });
});

describe("isEncryptedFrame", () => {
  it("rejects plain transport envelopes and junk", async () => {
    const { env } = await makeSignedEnvelope();
    expect(isEncryptedFrame(env)).toBe(false);
    expect(isEncryptedFrame(null)).toBe(false);
    expect(isEncryptedFrame({ deviceId: "x" })).toBe(false);
    expect(isEncryptedFrame({ v: 1, protocolVersion: "1", deviceId: "x", enc: { n: "a" } })).toBe(false);
  });
});
