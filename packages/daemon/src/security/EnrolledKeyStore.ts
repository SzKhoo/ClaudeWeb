/**
 * Persistent registry of enrolled browser signing keys (Phase 1, decision D3).
 *
 * Each enrollment records `{ keyId, pubkey (b64u), label?, enrolledAt, revoked? }`. Revocation is a
 * mark, not a delete — keeps audit trail intact. Implements `PairingKeyStore` so the existing
 * `CommandVerifier` swaps from the static env-list to this dynamic registry with no behaviour change.
 *
 * Storage: simple JSON file ("load all, write all"). Few keys per device (handfuls), so a more clever
 * format isn't justified yet. Atomic writes via tmp-file + rename — survives crashes.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fromBase64Url, toBase64Url } from "@wcc/shared";
import type { PairingKeyStore } from "./CommandVerifier.js";

export interface EnrolledKey {
  keyId: string;
  /** base64url Ed25519 public key. */
  pubkey: string;
  label?: string;
  enrolledAt: number;
  revoked?: boolean;
  revokedAt?: number;
  /**
   * Phase 2b: base64url 32-byte symmetric channel key (X25519 ECDH → HKDF), derived at enrollment
   * from the browser's X25519 pubkey and our ephemeral X25519 private key. Absent for Phase-1
   * enrollments that pre-date payload encryption. Stage 2 will feed this into an AEAD wrapper.
   */
  channelKey?: string;
}

export interface EnrolledKeyStoreFile {
  version: 1;
  keys: EnrolledKey[];
}

export class EnrolledKeyStore implements PairingKeyStore {
  private records: EnrolledKey[] = [];
  /** Decoded raw pubkeys for the active records — cached so CommandVerifier doesn't decode every call. */
  private active: Uint8Array[] = [];

  private constructor(private readonly path: string) {}

  /** Open (and load if it exists) a file-backed key store. Missing file → empty store. */
  static async open(path: string): Promise<EnrolledKeyStore> {
    const s = new EnrolledKeyStore(path);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as EnrolledKeyStoreFile;
      if (parsed?.version === 1 && Array.isArray(parsed.keys)) {
        s.records = parsed.keys.map((k) => ({ ...k }));
        s.rebuildActive();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupt file? Re-throw so the operator notices instead of silently losing pairings.
        throw err;
      }
    }
    return s;
  }

  /** Active (non-revoked) browser public keys — what CommandVerifier consumes. */
  keys(): readonly Uint8Array[] {
    return this.active;
  }

  get size(): number {
    return this.active.length;
  }

  /** Full record list, including revoked entries (for UIs / audit). */
  all(): readonly EnrolledKey[] {
    return this.records;
  }

  findActiveByPubkey(pubkey: string): EnrolledKey | undefined {
    return this.records.find((r) => !r.revoked && r.pubkey === pubkey);
  }

  /**
   * Enroll a new (or duplicate) pubkey. Idempotent: if the SAME pubkey is already active, returns
   * that existing record (Phase-1 retry-friendly). Persists before returning.
   */
  async enroll(args: {
    pubkey: Uint8Array;
    label?: string;
    enrolledAt: number;
    keyId: string;
    /** Phase 2b: optional derived channel key (base64url). */
    channelKey?: string;
  }): Promise<EnrolledKey> {
    const pubB64 = toBase64Url(args.pubkey);
    const existing = this.findActiveByPubkey(pubB64);
    if (existing) return existing;
    const rec: EnrolledKey = {
      keyId: args.keyId,
      pubkey: pubB64,
      enrolledAt: args.enrolledAt,
      ...(args.label ? { label: args.label } : {}),
      ...(args.channelKey ? { channelKey: args.channelKey } : {}),
    };
    this.records.push(rec);
    this.rebuildActive();
    await this.persist();
    return rec;
  }

  /** Mark a key revoked. Future verifications by that key fail with "unauthorized". */
  async revoke(keyId: string, at: number): Promise<boolean> {
    const rec = this.records.find((r) => r.keyId === keyId);
    if (!rec || rec.revoked) return false;
    rec.revoked = true;
    rec.revokedAt = at;
    this.rebuildActive();
    await this.persist();
    return true;
  }

  private rebuildActive(): void {
    this.active = this.records.filter((r) => !r.revoked).map((r) => fromBase64Url(r.pubkey));
  }

  private async persist(): Promise<void> {
    const payload: EnrolledKeyStoreFile = { version: 1, keys: this.records };
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
