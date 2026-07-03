/**
 * S3.1 X25519 in pairing (Phase 2b, ISSUES #15).
 *
 * Tests two levels:
 *   1. The X25519 helper (`x25519.ts`) directly — both sides derive the same 32-byte key from an
 *      ECDH exchange; different contextSalt values produce different keys.
 *   2. The pairing round-trip end-to-end with X25519 pubkeys attached — a relay that swaps EITHER
 *      the browser's or the daemon's X25519 pubkey breaks the enroll_request tag OR the enroll_ack
 *      Ed25519 signature (defense inherited from ISSUES #11's authentication story).
 */
import { describe, expect, it } from "vitest";
import {
  buildEnrollAck,
  buildEnrollRequest,
  deriveChannelKey,
  deriveChannelKeyFromRaw,
  fromBase64Url,
  generateKeyPair,
  generateX25519KeyPair,
  importX25519PublicKey,
  toBase64Url,
  verifyEnrollAck,
  verifyEnrollRequest,
} from "../src/index.js";

const DEVICE_ID = "device-1";
const CODE = "ABCDEFGHJK";

describe("x25519 helpers", () => {
  it("generates 32-byte public keys", async () => {
    const kp = await generateX25519KeyPair();
    expect(kp.publicKey.byteLength).toBe(32);
  });

  it("derives the same 32-byte channel key on both sides", async () => {
    const a = await generateX25519KeyPair();
    const b = await generateX25519KeyPair();
    const salt = new TextEncoder().encode("context");
    const aPub = await importX25519PublicKey(a.publicKey);
    const bPub = await importX25519PublicKey(b.publicKey);
    const kA = await deriveChannelKey(a.privateKey, bPub, salt);
    const kB = await deriveChannelKey(b.privateKey, aPub, salt);
    expect(kA.byteLength).toBe(32);
    expect(toBase64Url(kA)).toBe(toBase64Url(kB));
  });

  it("different context salts produce different channel keys", async () => {
    const a = await generateX25519KeyPair();
    const b = await generateX25519KeyPair();
    const k1 = await deriveChannelKeyFromRaw(a.privateKey, b.publicKey, new Uint8Array([1]));
    const k2 = await deriveChannelKeyFromRaw(a.privateKey, b.publicKey, new Uint8Array([2]));
    expect(toBase64Url(k1)).not.toBe(toBase64Url(k2));
  });
});

describe("pairing with X25519 attached", () => {
  it("round-trip: browser and daemon derive the SAME channel key", async () => {
    const browserSign = await generateKeyPair();
    const browserX = await generateX25519KeyPair();
    const deviceSign = await generateKeyPair();
    const deviceX = await generateX25519KeyPair();

    const req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: browserSign.publicKey,
      pairingCode: CODE,
      browserX25519PubKey: browserX.publicKey,
    });

    // Daemon verifies the request with X25519 field bound into the tag
    const v = await verifyEnrollRequest({
      request: req,
      expectedDeviceId: DEVICE_ID,
      pairingCode: CODE,
    });
    expect(v.ok).toBe(true);

    // Daemon derives channel key from browser's X25519 pubkey
    const daemonChannelKey = await deriveChannelKeyFromRaw(
      deviceX.privateKey,
      fromBase64Url(req.browserX25519PubKey!),
      browserSign.publicKey,
    );

    // Daemon signs an ack including its own X25519 pubkey
    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: req.browserPubKey,
      deviceSecretKey: deviceSign.secretKey,
      devicePubKey: deviceSign.publicKey,
      deviceX25519PubKey: deviceX.publicKey,
      keyId: "k-1",
    });

    // Browser verifies the ack (deviceX25519PubKey bound into the Ed25519 signature)
    expect(await verifyEnrollAck({
      ack,
      expectedBrowserPubKey: req.browserPubKey,
      expectedDevicePubKey: deviceSign.publicKey,
    })).toBe(true);

    // Browser derives channel key from the ack's deviceX25519PubKey
    const browserChannelKey = await deriveChannelKeyFromRaw(
      browserX.privateKey,
      fromBase64Url(ack.deviceX25519PubKey!),
      browserSign.publicKey,
    );

    expect(toBase64Url(browserChannelKey)).toBe(toBase64Url(daemonChannelKey));
  });

  it("relay swap of browserX25519PubKey defeats the HMAC tag → bad_code", async () => {
    const browserSign = await generateKeyPair();
    const browserX = await generateX25519KeyPair();
    const attackerX = await generateX25519KeyPair();

    const req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: browserSign.publicKey,
      pairingCode: CODE,
      browserX25519PubKey: browserX.publicKey,
    });

    // Relay swaps the X25519 pubkey while keeping the original tag.
    const tampered = { ...req, browserX25519PubKey: toBase64Url(attackerX.publicKey) };
    const v = await verifyEnrollRequest({
      request: tampered,
      expectedDeviceId: DEVICE_ID,
      pairingCode: CODE,
    });
    expect(v).toEqual({ ok: false, reason: "bad_code" });
  });

  it("relay swap of deviceX25519PubKey in the ack defeats the Ed25519 signature", async () => {
    const browserSign = await generateKeyPair();
    const deviceSign = await generateKeyPair();
    const deviceX = await generateX25519KeyPair();
    const attackerX = await generateX25519KeyPair();

    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: toBase64Url(browserSign.publicKey),
      deviceSecretKey: deviceSign.secretKey,
      devicePubKey: deviceSign.publicKey,
      deviceX25519PubKey: deviceX.publicKey,
      keyId: "k-1",
    });

    // Relay swaps the daemon's X25519 pubkey. Signature should now fail.
    const tampered = { ...ack, deviceX25519PubKey: toBase64Url(attackerX.publicKey) };
    expect(await verifyEnrollAck({
      ack: tampered,
      expectedBrowserPubKey: toBase64Url(browserSign.publicKey),
      expectedDevicePubKey: deviceSign.publicKey,
    })).toBe(false);
  });

  it("backward compat: request/ack without X25519 fields still round-trip", async () => {
    const browserSign = await generateKeyPair();
    const deviceSign = await generateKeyPair();

    // Legacy shape — no X25519 fields at all.
    const req = await buildEnrollRequest({
      deviceId: DEVICE_ID,
      browserPubKey: browserSign.publicKey,
      pairingCode: CODE,
    });
    expect(req.browserX25519PubKey).toBeUndefined();
    const v = await verifyEnrollRequest({
      request: req,
      expectedDeviceId: DEVICE_ID,
      pairingCode: CODE,
    });
    expect(v.ok).toBe(true);

    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: req.browserPubKey,
      deviceSecretKey: deviceSign.secretKey,
      devicePubKey: deviceSign.publicKey,
      keyId: "k-1",
    });
    expect(ack.deviceX25519PubKey).toBeUndefined();
    expect(await verifyEnrollAck({
      ack,
      expectedBrowserPubKey: req.browserPubKey,
      expectedDevicePubKey: deviceSign.publicKey,
    })).toBe(true);
  });
});
