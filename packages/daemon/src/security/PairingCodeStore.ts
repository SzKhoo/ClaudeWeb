/**
 * Pairing-code lifecycle (Phase 1, decision D1). In-memory by default — codes are short-lived (5 min
 * TTL) and consumed once. The daemon's pair-CLI mints a code; the EnrollmentManager looks it up.
 *
 * Idempotency rule: a code that's already been consumed by the SAME browser pubkey returns the
 * SAME outcome (so a lost enroll_ack the browser can retry). A code consumed by a DIFFERENT pubkey
 * → "consumed".
 */

import { generateCode } from "@wcc/shared";

export const DEFAULT_CODE_TTL_MS = 5 * 60_000;

export interface PairingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
  label?: string;
  consumedBy?: string; // base64url browser pubkey, set when consumed
  consumedAt?: number;
}

export interface PairingCodeStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export class PairingCodeStore {
  private readonly codes = new Map<string, PairingCode>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: PairingCodeStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_CODE_TTL_MS;
  }

  /** Mint a fresh code and store it. The CLI shows `code` on the trusted machine. */
  mint(label?: string): PairingCode {
    this.prune();
    const code = generateCode();
    const createdAt = this.now();
    const rec: PairingCode = {
      code,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      ...(label ? { label } : {}),
    };
    this.codes.set(code, rec);
    return rec;
  }

  /** Look up a code (does NOT consume). Returns undefined if unknown OR expired. */
  lookup(code: string): PairingCode | undefined {
    const rec = this.codes.get(code);
    if (!rec) return undefined;
    if (this.now() > rec.expiresAt) {
      this.codes.delete(code);
      return undefined;
    }
    return rec;
  }

  /**
   * Mark a code consumed by a specific browser pubkey. Returns:
   *   "ok"        — first consumption (success), or repeat by the SAME pubkey (idempotent)
   *   "consumed"  — already consumed by a DIFFERENT pubkey
   */
  consume(code: string, browserPubKey: string): "ok" | "consumed" {
    const rec = this.codes.get(code);
    if (!rec) return "consumed"; // treat unknown as consumed-by-someone; lookup() is the freshness check
    if (rec.consumedBy && rec.consumedBy !== browserPubKey) return "consumed";
    rec.consumedBy = browserPubKey;
    rec.consumedAt = this.now();
    return "ok";
  }

  /** Drop expired codes (called opportunistically — cheap). */
  prune(): void {
    const now = this.now();
    for (const [k, v] of this.codes) {
      if (now > v.expiresAt) this.codes.delete(k);
    }
  }

  size(): number {
    return this.codes.size;
  }

  /** Iterate active (non-expired) codes. Expired codes are pruned. */
  entries(): PairingCode[] {
    this.prune();
    return [...this.codes.values()];
  }
}
