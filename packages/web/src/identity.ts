/**
 * Browser signing identity (Phase 0: locally-provisioned keypair, persisted in localStorage). The
 * PUBLIC key must be paired with the daemon (env `WCC_PAIRED_PUBKEY`) for commands to be accepted —
 * the UI surfaces `publicKeyB64` so the user can paste it into their daemon config.
 *
 * WebCrypto caveat (plan): a non-extractable key would stop exfiltration but not in-tab XSS calling
 * sign(). Phase 1 replaces this with a WebAuthn passkey (hardware-backed, biometric-gated) + strict CSP.
 */

import { fromBase64Url, generateKeyPair, publicKeyFor, toBase64Url } from "@wcc/shared";

export interface Identity {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  clientInstanceId: string;
  publicKeyB64: string;
}

const STORAGE_KEY = "wcc.identity.v1";

interface StoredIdentity {
  secret: string;
  clientInstanceId: string;
}

export async function loadOrCreateIdentity(): Promise<Identity> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredIdentity;
      const secretKey = fromBase64Url(parsed.secret);
      const publicKey = await publicKeyFor(secretKey);
      return { secretKey, publicKey, clientInstanceId: parsed.clientInstanceId, publicKeyB64: toBase64Url(publicKey) };
    } catch {
      /* corrupt — regenerate below */
    }
  }
  const { secretKey, publicKey } = await generateKeyPair();
  const clientInstanceId = "browser-" + toBase64Url(crypto.getRandomValues(new Uint8Array(6)));
  const stored: StoredIdentity = { secret: toBase64Url(secretKey), clientInstanceId };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  return { secretKey, publicKey, clientInstanceId, publicKeyB64: toBase64Url(publicKey) };
}
