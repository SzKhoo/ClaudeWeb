import { describe, expect, it } from "vitest";
import {
  buildEnrollAck,
  buildEnrollRequest,
  formatCode,
  fromBase64Url,
  generateCode,
  generateKeyPair,
  isEnrollAck,
  isEnrollRequest,
  normalizeCode,
  PAIRING_FRESHNESS_MS,
  publicKeyFor,
  toBase64Url,
  verifyEnrollAck,
  verifyEnrollRequest,
} from "../src/index.js";

describe("pairing codes", () => {
  it("generateCode returns 10 valid Crockford chars", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
      // normalize is the identity on a freshly generated code
      expect(normalizeCode(c)).toBe(c);
    }
  });

  it("normalize maps I/L → 1, O → 0, accepts dashes + lowercase", () => {
    const cases: [string, string | undefined][] = [
      ["abcd-efgh-jk", "ABCDEFGHJK"],
      ["abcl-1foi-jk", "ABC11F01JK"], // L→1, I→1, O→0
      ["  ABCDEFGHJK  ", "ABCDEFGHJK"],
      ["short", undefined],
      ["1234567890U", undefined], // U is not in the Crockford alphabet
    ];
    for (const [input, expected] of cases) {
      expect(normalizeCode(input)).toBe(expected);
    }
  });

  it("formatCode produces XXXX-XXXX-XX", () => {
    expect(formatCode("ABCDEFGHJK")).toBe("ABCD-EFGH-JK");
    expect(() => formatCode("nope")).toThrow();
  });
});

describe("enroll_request", () => {
  const ts = 1_700_000_000_000;
  const deviceId = "device-1";
  const code = "ABCDEFGHJK"; // a fixed code so the daemon and browser can compute the same HMAC key

  it("happy path: round-trip verifies", async () => {
    const kp = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      label: "iPhone",
      timestamp: ts,
    });
    expect(isEnrollRequest(req)).toBe(true);
    const r = await verifyEnrollRequest({
      request: req,
      expectedDeviceId: deviceId,
      pairingCode: code,
      now: ts,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects wrong code → bad_code", async () => {
    const kp = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      timestamp: ts,
    });
    const r = await verifyEnrollRequest({
      request: req,
      expectedDeviceId: deviceId,
      pairingCode: "ZZZZZZZZZZ",
      now: ts,
    });
    expect(r).toEqual({ ok: false, reason: "bad_code" });
  });

  it("rejects swapped browserPubKey → bad_code (HMAC fails)", async () => {
    const kp = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      timestamp: ts,
    });
    // Relay attack: swap in a different pubkey while keeping the original tag.
    const tampered = { ...req, browserPubKey: toBase64Url(kp2.publicKey) };
    const r = await verifyEnrollRequest({
      request: tampered,
      expectedDeviceId: deviceId,
      pairingCode: code,
      now: ts,
    });
    expect(r).toEqual({ ok: false, reason: "bad_code" });
  });

  it("rejects wrong deviceId → tampered", async () => {
    const kp = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      timestamp: ts,
    });
    const r = await verifyEnrollRequest({
      request: req,
      expectedDeviceId: "different-device",
      pairingCode: code,
      now: ts,
    });
    expect(r).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects stale timestamp → stale (replay defence)", async () => {
    const kp = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      timestamp: ts,
    });
    const r = await verifyEnrollRequest({
      request: req,
      expectedDeviceId: deviceId,
      pairingCode: code,
      now: ts + PAIRING_FRESHNESS_MS + 1,
    });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects mutated label → bad_code", async () => {
    const kp = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      label: "iPhone",
      timestamp: ts,
    });
    const tampered = { ...req, label: "Eve's laptop" };
    const r = await verifyEnrollRequest({
      request: tampered,
      expectedDeviceId: deviceId,
      pairingCode: code,
      now: ts,
    });
    expect(r).toEqual({ ok: false, reason: "bad_code" });
  });

  it("rejects malformed salt/tag → tampered", async () => {
    const kp = await generateKeyPair();
    const req = await buildEnrollRequest({
      deviceId,
      browserPubKey: kp.publicKey,
      pairingCode: code,
      timestamp: ts,
    });
    const broken = { ...req, hkdfSalt: "$$not-base64$$" };
    const r = await verifyEnrollRequest({
      request: broken,
      expectedDeviceId: deviceId,
      pairingCode: code,
      now: ts,
    });
    // Either "tampered" (caught at fromBase64Url) or "bad_code" (HMAC mismatch on corrupted bytes) is
    // a valid rejection — both keep the attacker out. Assert it FAILS.
    expect(r.ok).toBe(false);
  });
});

describe("enroll_ack", () => {
  const ts = 1_700_000_000_000;

  it("happy path: device signature verifies", async () => {
    const device = await generateKeyPair();
    const browser = await generateKeyPair();
    const browserPubB64 = toBase64Url(browser.publicKey);

    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: browserPubB64,
      deviceSecretKey: device.secretKey,
      devicePubKey: device.publicKey,
      keyId: "k-1",
      enrolledAt: ts,
      timestamp: ts,
    });
    expect(isEnrollAck(ack)).toBe(true);
    expect(
      await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: browserPubB64,
        expectedDevicePubKey: device.publicKey,
      }),
    ).toBe(true);
  });

  it("rejects when devicePubKey doesn't match the trusted directory pubkey", async () => {
    const device = await generateKeyPair();
    const impostor = await generateKeyPair();
    const browser = await generateKeyPair();
    const browserPubB64 = toBase64Url(browser.publicKey);

    // Impostor relay signs with its OWN key but claims to be the daemon.
    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: browserPubB64,
      deviceSecretKey: impostor.secretKey,
      devicePubKey: impostor.publicKey,
      keyId: "k-x",
      enrolledAt: ts,
      timestamp: ts,
    });
    // Browser checks against the REAL device pubkey it learned from the directory.
    expect(
      await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: browserPubB64,
        expectedDevicePubKey: device.publicKey,
      }),
    ).toBe(false);
  });

  it("rejects when ack is for a different browser pubkey", async () => {
    const device = await generateKeyPair();
    const a = await generateKeyPair();
    const b = await generateKeyPair();

    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: toBase64Url(a.publicKey),
      deviceSecretKey: device.secretKey,
      devicePubKey: device.publicKey,
      timestamp: ts,
    });
    expect(
      await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: toBase64Url(b.publicKey),
        expectedDevicePubKey: device.publicKey,
      }),
    ).toBe(false);
  });

  it("rejects an unsigned (ok=false) failure ack", async () => {
    const device = await generateKeyPair();
    const browser = await generateKeyPair();
    const browserPubB64 = toBase64Url(browser.publicKey);

    const ack = await buildEnrollAck({
      ok: false,
      browserPubKey: browserPubB64,
      reason: "bad_code",
      timestamp: ts,
    });
    expect(
      await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: browserPubB64,
        expectedDevicePubKey: device.publicKey,
      }),
    ).toBe(false);
  });

  it("rejects forged signature (sig from a different deviceSecretKey)", async () => {
    const device = await generateKeyPair();
    const attacker = await generateKeyPair();
    const browser = await generateKeyPair();
    const browserPubB64 = toBase64Url(browser.publicKey);

    // Built with attacker's key but advertising the real device pubkey:
    const ack = await buildEnrollAck({
      ok: true,
      browserPubKey: browserPubB64,
      deviceSecretKey: attacker.secretKey,
      devicePubKey: device.publicKey, // lies about who it is
      timestamp: ts,
    });
    expect(
      await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: browserPubB64,
        expectedDevicePubKey: device.publicKey,
      }),
    ).toBe(false);
  });
});

describe("publicKeyFor", () => {
  it("derives the public key for an existing secret key (sanity check)", async () => {
    const kp = await generateKeyPair();
    const pk = await publicKeyFor(kp.secretKey);
    expect(toBase64Url(pk)).toBe(toBase64Url(kp.publicKey));
    // unused fromBase64Url import sanity
    expect(fromBase64Url(toBase64Url(pk))).toEqual(pk);
  });
});
