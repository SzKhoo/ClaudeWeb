import { describe, expect, it } from "vitest";
import { signJwtHs256, verifyJwtHs256 } from "../src/index.js";

const ENC = new TextEncoder();
const secret = ENC.encode("super-secret-test-key-32-bytes-min!!!");
const otherSecret = ENC.encode("a-different-jwt-secret-of-similar-len!!");

describe("HS256 JWT", () => {
  const nowMs = 1_700_000_000_000;
  const nowS = Math.floor(nowMs / 1000);

  it("verifies a valid token and exposes claims", async () => {
    const token = await signJwtHs256(
      { sub: "user-123", iat: nowS, exp: nowS + 60, foo: "bar" },
      secret,
    );
    const r = await verifyJwtHs256(token, secret, { now: nowMs });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.sub).toBe("user-123");
      expect(r.claims["foo"]).toBe("bar");
    }
  });

  it("rejects malformed (not 3 segments)", async () => {
    const r = await verifyJwtHs256("not.a.jwt.token", secret, { now: nowMs });
    expect(r).toEqual({ ok: false, reason: "malformed" });
    const r2 = await verifyJwtHs256("oneonly", secret, { now: nowMs });
    expect(r2).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects wrong signing key → bad_signature", async () => {
    const token = await signJwtHs256({ sub: "u", iat: nowS, exp: nowS + 60 }, secret);
    const r = await verifyJwtHs256(token, otherSecret, { now: nowMs });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects tampered claims → bad_signature", async () => {
    const token = await signJwtHs256({ sub: "u", iat: nowS, exp: nowS + 60 }, secret);
    const [h, _p, s] = token.split(".") as [string, string, string];
    // Replace payload with a different base64url(JSON) but keep sig.
    const evil = `${h}.${Buffer.from(JSON.stringify({ sub: "admin", exp: nowS + 60 })).toString("base64url")}.${s}`;
    const r = await verifyJwtHs256(evil, secret, { now: nowMs });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects expired token", async () => {
    const token = await signJwtHs256({ sub: "u", iat: nowS, exp: nowS - 120 }, secret);
    const r = await verifyJwtHs256(token, secret, { now: nowMs, clockSkewMs: 0 });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects not-yet-valid token (nbf in the future)", async () => {
    const token = await signJwtHs256({ sub: "u", iat: nowS, nbf: nowS + 120 }, secret);
    const r = await verifyJwtHs256(token, secret, { now: nowMs, clockSkewMs: 0 });
    expect(r).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("rejects non-HS256 alg → malformed", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u" })).toString("base64url");
    const r = await verifyJwtHs256(`${header}.${payload}.`, secret, { now: nowMs });
    expect(r).toEqual({ ok: false, reason: "malformed" });
  });

  it("tolerates small clock skew (default 30s)", async () => {
    const token = await signJwtHs256({ sub: "u", iat: nowS, exp: nowS - 10 }, secret);
    // 10s expired but within the 30s default skew → accept
    const r = await verifyJwtHs256(token, secret, { now: nowMs });
    expect(r.ok).toBe(true);
  });

  it("enforces expectedAud when set (string + array forms), skips when unset", async () => {
    const good = await signJwtHs256(
      { sub: "u", exp: nowS + 60, aud: "authenticated" },
      secret,
    );
    expect((await verifyJwtHs256(good, secret, { now: nowMs, expectedAud: "authenticated" })).ok).toBe(true);
    // Array aud containing the expected value also passes.
    const arr = await signJwtHs256(
      { sub: "u", exp: nowS + 60, aud: ["other", "authenticated"] as unknown as string },
      secret,
    );
    expect((await verifyJwtHs256(arr, secret, { now: nowMs, expectedAud: "authenticated" })).ok).toBe(true);
    // Wrong / missing aud → bad_aud.
    const wrong = await signJwtHs256({ sub: "u", exp: nowS + 60, aud: "anon" }, secret);
    expect(await verifyJwtHs256(wrong, secret, { now: nowMs, expectedAud: "authenticated" })).toEqual({
      ok: false,
      reason: "bad_aud",
    });
    const missing = await signJwtHs256({ sub: "u", exp: nowS + 60 }, secret);
    expect(await verifyJwtHs256(missing, secret, { now: nowMs, expectedAud: "authenticated" })).toEqual({
      ok: false,
      reason: "bad_aud",
    });
    // Unset → not enforced (back-compat for dev tokens).
    expect((await verifyJwtHs256(missing, secret, { now: nowMs })).ok).toBe(true);
  });

  it("enforces expectedIss when set", async () => {
    const iss = "https://ref.supabase.co/auth/v1";
    const good = await signJwtHs256({ sub: "u", exp: nowS + 60, iss }, secret);
    expect((await verifyJwtHs256(good, secret, { now: nowMs, expectedIss: iss })).ok).toBe(true);
    const wrong = await signJwtHs256({ sub: "u", exp: nowS + 60, iss: "https://evil.example" }, secret);
    expect(await verifyJwtHs256(wrong, secret, { now: nowMs, expectedIss: iss })).toEqual({
      ok: false,
      reason: "bad_iss",
    });
  });
});
