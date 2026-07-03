/**
 * AEAD payload wrapping (Phase 2b, ISSUES #15) — the "encrypt" half of "sign now, encrypt later".
 *
 * The pairing exchange (see x25519.ts / pairing.ts) already derives a shared 32-byte channel key on
 * both the browser and the daemon. This module uses that key to wrap a fully-signed
 * `TransportEnvelope` in an outer `EncryptedFrame` so the relay forwards ciphertext:
 *
 *   - `deviceId` stays cleartext because the relay routes by it (invariant #5). It is also bound as
 *     AES-GCM Additional Authenticated Data, so a relay that retargets a ciphertext to another device
 *     makes decryption fail rather than silently reroute it.
 *   - EVERYTHING else — sessionId, clientInstanceId, seq, timestamp, sig and the application payload
 *     (prompts, diffs, file bytes) — is inside the ciphertext. The relay learns nothing but routing.
 *
 * The existing sign/verify/replay pipeline is unchanged: `openEnvelope` returns the plaintext inner
 * envelope, which the endpoint verifies with `verifyEnvelope` exactly as before. Encryption is a pure
 * transport-edge wrap/unwrap, layered UNDER signing (sign-then-encrypt): the signature covers the
 * plaintext and is only revealed after a successful decrypt.
 */

import { fromBase64Url, toBase64Url } from "./sign.js";
import { isTransportEnvelope, type TransportEnvelope } from "./envelope.js";

/** Wire frame the relay actually forwards. `enc` is opaque to it; only `deviceId` is inspected. */
export interface EncryptedFrame {
  /** Seal format version — lets us evolve the AEAD scheme without ambiguity. */
  v: 1;
  /** Pass-through protocol version (cleartext, same value as the sealed inner envelope). */
  protocolVersion: string;
  /** Routing key — the ONLY cleartext field with meaning; also the AES-GCM AAD. */
  deviceId: string;
  enc: {
    /** base64url 12-byte AES-GCM nonce (fresh per seal). */
    n: string;
    /** base64url AES-GCM ciphertext, GCM tag appended. */
    ct: string;
  };
}

const NONCE_BYTES = 12;

function getCrypto(): Crypto {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto is required");
  return c;
}

function subtle(): SubtleCrypto {
  return getCrypto().subtle;
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Import a 32-byte channel key as an AES-GCM CryptoKey (encrypt + decrypt). */
export async function importChannelKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new Error(`importChannelKey: expected 32 bytes, got ${raw.length}`);
  }
  return subtle().importKey("raw", ab(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function asKey(key: Uint8Array | CryptoKey): Promise<CryptoKey> {
  return key instanceof Uint8Array ? importChannelKey(key) : key;
}

/** Structural guard: is this inbound value an EncryptedFrame (vs a plaintext envelope or junk)? */
export function isEncryptedFrame(value: unknown): value is EncryptedFrame {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (f["v"] !== 1) return false;
  if (typeof f["protocolVersion"] !== "string") return false;
  if (typeof f["deviceId"] !== "string") return false;
  const enc = f["enc"];
  if (typeof enc !== "object" || enc === null) return false;
  const e = enc as Record<string, unknown>;
  return typeof e["n"] === "string" && typeof e["ct"] === "string";
}

/** Encrypt a signed envelope into an EncryptedFrame using the pairing-derived channel key. */
export async function sealEnvelope(
  env: TransportEnvelope,
  key: Uint8Array | CryptoKey,
): Promise<EncryptedFrame> {
  const cryptoKey = await asKey(key);
  const nonce = new Uint8Array(NONCE_BYTES);
  getCrypto().getRandomValues(nonce);
  const plaintext = ENCODER.encode(JSON.stringify(env));
  const aad = ENCODER.encode(env.deviceId);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: ab(nonce), additionalData: ab(aad) },
    cryptoKey,
    ab(plaintext),
  );
  return {
    v: 1,
    protocolVersion: env.protocolVersion,
    deviceId: env.deviceId,
    enc: { n: toBase64Url(nonce), ct: toBase64Url(new Uint8Array(ct)) },
  };
}

/**
 * Decrypt an EncryptedFrame back to its inner TransportEnvelope. Throws on any tamper: wrong key,
 * mutated ciphertext/nonce, or a swapped `deviceId` (AAD mismatch). Also rejects a decrypted payload
 * that isn't a valid envelope or whose inner deviceId disagrees with the outer routing field.
 */
export async function openEnvelope(
  frame: EncryptedFrame,
  key: Uint8Array | CryptoKey,
): Promise<TransportEnvelope> {
  if (!isEncryptedFrame(frame)) throw new Error("openEnvelope: not an EncryptedFrame");
  const cryptoKey = await asKey(key);
  const nonce = fromBase64Url(frame.enc.n);
  const ct = fromBase64Url(frame.enc.ct);
  const aad = ENCODER.encode(frame.deviceId);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await subtle().decrypt(
      { name: "AES-GCM", iv: ab(nonce), additionalData: ab(aad) },
      cryptoKey,
      ab(ct),
    );
  } catch {
    throw new Error("openEnvelope: AEAD authentication failed (wrong key or tampered frame)");
  }
  let env: unknown;
  try {
    env = JSON.parse(DECODER.decode(new Uint8Array(ptBuf)));
  } catch {
    throw new Error("openEnvelope: decrypted payload is not JSON");
  }
  if (!isTransportEnvelope(env)) throw new Error("openEnvelope: decrypted payload is not an envelope");
  if (env.deviceId !== frame.deviceId) {
    throw new Error("openEnvelope: inner/outer deviceId mismatch");
  }
  return env;
}
