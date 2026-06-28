/**
 * HS256 JWT verifier (relay use). Supabase issues HS256-signed access tokens; the relay needs to
 * verify them against the project's JWT secret to extract `sub` (= userId) without trusting payload.
 * `signJwtHs256` is exported only so tests + the InMemoryDirectory can mint local fixture tokens.
 *
 * Deliberately minimal — no kid/alg negotiation, no RS256 — because Supabase HS256 is what we need
 * and a focused verifier keeps the attack surface small. No third-party JWT dep; WebCrypto subtle
 * is available in Node 20+ and modern browsers (and we already mandate it for pairing).
 */

import { fromBase64Url, toBase64Url } from "../protocol/sign.js";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto subtle is required");
  return c.subtle;
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function b64uJson(v: unknown): string {
  return toBase64Url(ENC.encode(JSON.stringify(v)));
}

function parseJson(b64u: string): unknown {
  return JSON.parse(DEC.decode(fromBase64Url(b64u)));
}

async function importHmac(secret: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey("raw", ab(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export interface JwtClaims {
  sub?: string;
  iss?: string;
  aud?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
  [k: string]: unknown;
}

export async function signJwtHs256(claims: JwtClaims, secret: Uint8Array): Promise<string> {
  const header = b64uJson({ alg: "HS256", typ: "JWT" });
  const payload = b64uJson(claims);
  const signingInput = `${header}.${payload}`;
  const key = await importHmac(secret, ["sign"]);
  const sig = await subtle().sign("HMAC", key, ab(ENC.encode(signingInput)));
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

export type JwtVerifyFailReason = "malformed" | "bad_signature" | "expired" | "not_yet_valid";
export type JwtVerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: JwtVerifyFailReason };

export interface JwtVerifyOptions {
  /** Override clock (epoch ms). */
  now?: number;
  /** Tolerance for nbf/exp (default 30s). */
  clockSkewMs?: number;
}

export async function verifyJwtHs256(
  token: string,
  secret: Uint8Array,
  opts: JwtVerifyOptions = {},
): Promise<JwtVerifyResult> {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string };
  let claims: JwtClaims;
  let sig: Uint8Array;
  try {
    header = parseJson(headerB64) as { alg?: string };
    const c = parseJson(payloadB64);
    if (typeof c !== "object" || c === null) return { ok: false, reason: "malformed" };
    claims = c as JwtClaims;
    sig = fromBase64Url(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "malformed" };

  const key = await importHmac(secret, ["verify"]);
  const valid = await subtle().verify(
    "HMAC",
    key,
    ab(sig),
    ab(ENC.encode(`${headerB64}.${payloadB64}`)),
  );
  if (!valid) return { ok: false, reason: "bad_signature" };

  const nowS = (opts.now ?? Date.now()) / 1000;
  const skewS = (opts.clockSkewMs ?? 30_000) / 1000;
  if (typeof claims.exp === "number" && nowS > claims.exp + skewS) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && nowS + skewS < claims.nbf) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, claims };
}
