/**
 * X25519 keypair + ECDH-derived channel keys (Phase 2b, ISSUES #15).
 *
 * Why this file exists:
 *   Phase 0 pairing (D1, ISSUES #11) used HMAC to *authenticate* the browser's Ed25519 signing pubkey
 *   through an untrusted relay. That was fine for the control channel — but the relay can still
 *   read every prompt, diff and file byte because the payload itself is plaintext. Multi-tenant
 *   launch is a non-starter without payload confidentiality.
 *
 *   Phase 2b upgrades the pairing exchange to also carry each side's *X25519* public key alongside
 *   its existing identity/signing pubkey. Both sides then compute an ECDH shared secret and HKDF
 *   it into a symmetric AEAD channel key. The HMAC over enroll_request already binds the browser's
 *   X25519 key; the Ed25519 signature over enroll_ack already binds the device's X25519 key — the
 *   ISSUES #11 authentication story stands unchanged, we just add material to it. No new npm dep:
 *   Node 22+ and modern browsers ship X25519 in WebCrypto.
 *
 *   AEAD payload wrapping (Stage 2 of S3) lands next; this module only owns the key material.
 */

/** Fresh X25519 keypair. `privateKey` is non-extractable — held as a CryptoKey handle. */
export interface X25519KeyPair {
  privateKey: CryptoKey;
  publicKey: Uint8Array; // raw 32-byte X25519 point
}

const CHANNEL_KEY_INFO = "wcc-channel-v1";

function subtle(): SubtleCrypto {
  const c = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto subtle is required");
  return c.subtle;
}

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Generate an X25519 keypair. The private half stays inside a non-extractable CryptoKey handle. */
export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const s = subtle();
  // Node 22+ / Chrome 133+ / Safari 17+ / Firefox 138+ support X25519 natively.
  const pair = (await s.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const raw = await s.exportKey("raw", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(raw) };
}

/** Import a peer's raw X25519 public key for ECDH. */
export async function importX25519PublicKey(rawPubKey: Uint8Array): Promise<CryptoKey> {
  if (rawPubKey.length !== 32) {
    throw new Error(`importX25519PublicKey: expected 32 bytes, got ${rawPubKey.length}`);
  }
  // Public keys need no usages — deriveBits runs against the private key.
  return subtle().importKey("raw", ab(rawPubKey), { name: "X25519" }, false, []);
}

/**
 * Derive a 32-byte symmetric channel key from our private half + the peer's public half.
 *
 * `contextSalt` binds the derivation to something exchanged during pairing that both sides agree
 * on and neither an attacker can silently replace — we use the browser's Ed25519 signing pubkey.
 * That way, a relay that swaps ANY pairing material (browserPubKey, hkdfSalt, code-derived HMAC
 * key, X25519 pubkey…) fails BOTH the existing enroll_request/enroll_ack integrity checks AND
 * this channel key ends up different on the two sides — encrypted traffic then round-trips as
 * garbage rather than silently leaking through a relay-owned key.
 */
export async function deriveChannelKey(
  myPrivate: CryptoKey,
  peerPublic: CryptoKey,
  contextSalt: Uint8Array,
): Promise<Uint8Array> {
  const s = subtle();
  const sharedBits = await s.deriveBits(
    { name: "X25519", public: peerPublic },
    myPrivate,
    256,
  );
  // Ingest the raw ECDH output through HKDF so we hash the point and can add domain separation via `info`.
  const ikm = await s.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const derived = await s.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ab(contextSalt),
      info: ab(new TextEncoder().encode(CHANNEL_KEY_INFO)),
    },
    ikm,
    256,
  );
  return new Uint8Array(derived);
}

/** Small helper: derive channel key from raw peer pubkey bytes, useful at the pairing boundary. */
export async function deriveChannelKeyFromRaw(
  myPrivate: CryptoKey,
  peerPublicRaw: Uint8Array,
  contextSalt: Uint8Array,
): Promise<Uint8Array> {
  const peerPublic = await importX25519PublicKey(peerPublicRaw);
  return deriveChannelKey(myPrivate, peerPublic, contextSalt);
}
