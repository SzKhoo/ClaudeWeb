/**
 * Relay authorization — Phase 1, decision D2.
 *
 * The relay stays an UNTRUSTED dumb pipe — it never reads payloads, holds no session content, routes
 * by deviceId only (invariants #1 / #5). What changes in Phase 1: a peer can't connect anonymously.
 *
 * - Browser: presents a Supabase HS256 JWT in `relay_register.token`. JWT.sub = userId. The relay
 *   checks the Directory: does this user OWN the deviceId they want to attach to? If not → forbidden.
 * - Daemon : presents a long-lived device token. The relay's DaemonTokenStore maps token → {userId,
 *   deviceId}. The deviceId in the token must match the one in the register (so a stolen token for
 *   device-A can't be used to attach as device-B). Tokens are stored as SHA-256 hashes server-side.
 *
 * Phase 0's shared-token mode is preserved (used when no AuthVerifier is injected) so local dev /
 * tests / preview keep working.
 */

import type { RelayRegister } from "./messages.js";
import { verifyJwtHs256 } from "@wcc/shared";

export type AuthFailReason = "bad_token" | "forbidden";
export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; reason: AuthFailReason };

/** Pluggable verifier. The relay calls this on every relay_register. */
export interface AuthVerifier {
  authorize(register: RelayRegister): Promise<AuthResult>;
}

/** Owns the "which user owns which device" mapping. Phase 1 impl: Supabase Postgres + RLS. */
export interface Directory {
  /** True iff `userId` owns `deviceId`. */
  userOwnsDevice(userId: string, deviceId: string): Promise<boolean>;
}

/** Owns the "which long-lived daemon token maps to which user+device" mapping. */
export interface DaemonTokenStore {
  /** Look up the bearer of a daemon token (returns undefined if unknown / hash-miss). */
  lookup(token: string): Promise<{ userId: string; deviceId: string } | undefined>;
}

// ───────────────────────────── concrete impls ─────────────────────────────

export interface JwtAuthVerifierOptions {
  /** HS256 secret used to verify browser JWTs (Supabase project JWT secret). */
  jwtSecret: Uint8Array;
  directory: Directory;
  daemonTokens: DaemonTokenStore;
  now?: () => number;
  clockSkewMs?: number;
}

/** AuthVerifier that handles BOTH browser (JWT) and daemon (device-token) registers. */
export class JwtAuthVerifier implements AuthVerifier {
  constructor(private readonly opts: JwtAuthVerifierOptions) {}

  async authorize(register: RelayRegister): Promise<AuthResult> {
    if (register.role === "browser") {
      const r = await verifyJwtHs256(register.token, this.opts.jwtSecret, {
        ...(this.opts.now ? { now: this.opts.now() } : {}),
        ...(this.opts.clockSkewMs !== undefined ? { clockSkewMs: this.opts.clockSkewMs } : {}),
      });
      if (!r.ok) return { ok: false, reason: "bad_token" };
      const userId = typeof r.claims.sub === "string" ? r.claims.sub : "";
      if (!userId) return { ok: false, reason: "bad_token" };
      const owns = await this.opts.directory.userOwnsDevice(userId, register.deviceId);
      if (!owns) return { ok: false, reason: "forbidden" };
      return { ok: true, userId };
    }
    // daemon
    const bearer = await this.opts.daemonTokens.lookup(register.token);
    if (!bearer) return { ok: false, reason: "bad_token" };
    if (bearer.deviceId !== register.deviceId) return { ok: false, reason: "forbidden" };
    return { ok: true, userId: bearer.userId };
  }
}

// In-memory impls — used for tests and the Phase-0 preview path. Supabase impl lands at S1.6 (gate).

export class InMemoryDirectory implements Directory {
  /** userId → set of owned deviceIds */
  private readonly map = new Map<string, Set<string>>();

  add(userId: string, deviceId: string): void {
    let s = this.map.get(userId);
    if (!s) {
      s = new Set();
      this.map.set(userId, s);
    }
    s.add(deviceId);
  }

  remove(userId: string, deviceId: string): void {
    this.map.get(userId)?.delete(deviceId);
  }

  async userOwnsDevice(userId: string, deviceId: string): Promise<boolean> {
    return !!this.map.get(userId)?.has(deviceId);
  }
}

export class InMemoryDaemonTokenStore implements DaemonTokenStore {
  /** sha256(token, hex) → bearer */
  private readonly hashed = new Map<string, { userId: string; deviceId: string }>();

  async issue(token: string, bearer: { userId: string; deviceId: string }): Promise<void> {
    this.hashed.set(await sha256Hex(token), bearer);
  }

  async revoke(token: string): Promise<void> {
    this.hashed.delete(await sha256Hex(token));
  }

  async lookup(token: string): Promise<{ userId: string; deviceId: string } | undefined> {
    return this.hashed.get(await sha256Hex(token));
  }
}

async function sha256Hex(s: string): Promise<string> {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto subtle is required");
  const bytes = new TextEncoder().encode(s);
  const buf = await c.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const u = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < u.length; i++) out += u[i]!.toString(16).padStart(2, "0");
  return out;
}
