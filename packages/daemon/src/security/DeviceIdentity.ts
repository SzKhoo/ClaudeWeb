/**
 * Long-term Ed25519 device identity. Persisted on disk; generated on first run. The pubkey is what
 * Supabase stores in the directory for this device, and what the browser uses to verify enroll_acks.
 *
 * File format: JSON with base64url secretKey + pubkey. The secretKey is sensitive — file mode is set
 * to 0o600 on Unix; on Windows we rely on the user's profile directory permissions.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fromBase64Url,
  generateKeyPair,
  publicKeyFor,
  toBase64Url,
  type KeyPair,
} from "@wcc/shared";

export interface DeviceIdentityFile {
  version: 1;
  secretKey: string; // base64url
  pubkey: string; // base64url (derived; stored for human/log convenience)
}

export interface DeviceIdentity {
  secretKey: Uint8Array;
  pubkey: Uint8Array;
  pubkeyB64: string;
}

/** Load existing identity, or generate + persist a new one if the file doesn't exist. */
export async function openDeviceIdentity(path: string): Promise<DeviceIdentity> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as DeviceIdentityFile;
    if (parsed?.version === 1 && typeof parsed.secretKey === "string") {
      const secretKey = fromBase64Url(parsed.secretKey);
      const pubkey = await publicKeyFor(secretKey);
      return { secretKey, pubkey, pubkeyB64: toBase64Url(pubkey) };
    }
    throw new Error(`unrecognized device identity file at ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const kp: KeyPair = await generateKeyPair();
  const file: DeviceIdentityFile = {
    version: 1,
    secretKey: toBase64Url(kp.secretKey),
    pubkey: toBase64Url(kp.publicKey),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), "utf8");
  // Best-effort lockdown on Unix; chmod is a no-op on Windows.
  try {
    await chmod(path, 0o600);
  } catch {
    /* ignore */
  }
  return { secretKey: kp.secretKey, pubkey: kp.publicKey, pubkeyB64: toBase64Url(kp.publicKey) };
}
