/**
 * HKDF-SHA256 → HMAC-SHA256 via WebCrypto subtle. Used to derive a one-shot HMAC key from a
 * pairing code + per-request salt, which binds the browser's signing pubkey into the enroll request
 * so a relay (lacking the code) cannot forge or swap the enrolled key.
 *
 * No third-party crypto dependency on purpose: WebCrypto subtle is available in Node 20+ and every
 * modern browser, and adding deps is risky given C: is full (ISSUES #1).
 */

const ENC = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto subtle is required");
  return c.subtle;
}

function ab(bytes: Uint8Array): ArrayBuffer {
  // Slice into a tight ArrayBuffer so subtle.* never receives a view with extra bytes.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Derive an HMAC-SHA256 CryptoKey from a normalized pairing code + per-request salt. `info` provides
 * domain separation so the derived key can't be misused across protocols/versions.
 */
export async function hkdfHmacKey(
  codeNormalized: string,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const s = subtle();
  const ikm = ENC.encode(codeNormalized);
  const baseKey = await s.importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  const derived = await s.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(ENC.encode(info)) },
    baseKey,
    256,
  );
  return s.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** HMAC-SHA256(key, data) → 32-byte tag. */
export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await subtle().sign("HMAC", key, ab(data));
  return new Uint8Array(sig);
}

/** Constant-time HMAC-SHA256 verification via subtle.verify. */
export async function hmacVerify(
  key: CryptoKey,
  data: Uint8Array,
  tag: Uint8Array,
): Promise<boolean> {
  return subtle().verify("HMAC", key, ab(tag), ab(data));
}
