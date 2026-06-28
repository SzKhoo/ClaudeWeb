/**
 * Pairing / enrollment protocol — Phase 1, decision D1 (ISSUES #11).
 *
 * Flow:
 *   1. User runs `daemon pair` → daemon generates a pairing code (code.ts), shows it on the trusted
 *      machine, stores `{ codeHash, ttl, label, consumed:false }`.
 *   2. Browser obtains the code from the user, builds an `enroll_request`:
 *        - browserPubKey  : the Ed25519 pubkey the browser will sign commands with
 *        - hkdfSalt       : per-request random salt
 *        - tag = HMAC-SHA256(HKDF(code, salt, "wcc-pairing-v1"), canonical(req-without-tag))
 *      Sends it as a bare frame over the relay (untrusted; no transport sig).
 *   3. Daemon receives the request, derives the SAME HMAC key from its stored code + the salt, and
 *      verifies the tag. A relay that swaps `browserPubKey` (or any other tagged field) breaks the
 *      tag and the daemon rejects with "tampered". A relay that never had the code cannot forge a
 *      valid tag at all.
 *   4. Daemon enrolls the browserPubKey, marks the code consumed, replies with `enroll_ack`:
 *        - devicePubKey   : the daemon's long-term identity pubkey
 *        - deviceSig      : Ed25519 over canonical(ack-without-deviceSig), using device secret key
 *      The browser already learned the expected devicePubKey from the trusted server directory
 *      (Supabase, not the relay), so a relay impostor pretending to be the daemon cannot complete the
 *      handshake: its ack will fail the devicePubKey-match check OR the Ed25519 signature check.
 *
 * Future-proof: Phase 2 swaps the code-HMAC step for SPAKE2 + WebAuthn passkeys without changing the
 * shape of EnrollRequest/EnrollAck (just the tag-derivation algorithm and a stronger device identity).
 */

import * as ed from "@noble/ed25519";
import { canonicalize } from "../protocol/canonical.js";
import { fromBase64Url, toBase64Url } from "../protocol/sign.js";
import { hkdfHmacKey, hmac, hmacVerify } from "./hkdf.js";
import { normalizeCode } from "./code.js";

export const HKDF_INFO = "wcc-pairing-v1";
/** Freshness window for an enroll_request timestamp. Independent of the code's TTL. */
export const PAIRING_FRESHNESS_MS = 5 * 60_000;

const ENC = new TextEncoder();

// ───────────────────────────── wire types ─────────────────────────────

export interface EnrollRequest {
  type: "enroll_request";
  /** Routing key — also bound into the HMAC tag so a relay can't replay across devices. */
  deviceId: string;
  /** base64url Ed25519 pubkey the browser will sign future commands with. */
  browserPubKey: string;
  /** base64url 16-byte salt for HKDF. */
  hkdfSalt: string;
  /** base64url HMAC-SHA256 tag, computed AFTER all other fields are fixed. */
  tag: string;
  /** Optional human-readable label saved alongside the enrolled key. */
  label?: string;
  /** epoch ms — freshness gate. */
  timestamp: number;
}

export type EnrollFailReason =
  | "bad_code" // wrong code, or HMAC mismatch (key-independent of which one — pick "bad_code" by default)
  | "expired" // code TTL elapsed at the daemon
  | "consumed" // code was one-shot and already used (by a different browser key)
  | "tampered" // structurally inconsistent (wrong deviceId, malformed base64, etc.)
  | "stale" // timestamp outside freshness window
  | "unknown";

export interface EnrollAck {
  type: "enroll_ack";
  ok: boolean;
  /** Echoed so each browser can filter "is this ack for me?" pre-session. */
  browserPubKey: string;
  /** Server-assigned id for the new enrolled key (when ok). */
  keyId?: string;
  /** base64url Ed25519 pubkey of the daemon's long-term device identity. */
  devicePubKey?: string;
  /** base64url Ed25519 signature over canonical(ack without deviceSig). */
  deviceSig?: string;
  /** epoch ms when the daemon recorded the enrollment. */
  enrolledAt?: number;
  /** epoch ms. */
  timestamp: number;
  reason?: EnrollFailReason;
}

export type PairingMessage = EnrollRequest | EnrollAck;

// ───────────────────────────── type guards ─────────────────────────────

export function isEnrollRequest(v: unknown): v is EnrollRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o["type"] === "enroll_request" &&
    typeof o["deviceId"] === "string" &&
    typeof o["browserPubKey"] === "string" &&
    typeof o["hkdfSalt"] === "string" &&
    typeof o["tag"] === "string" &&
    typeof o["timestamp"] === "number" &&
    Number.isFinite(o["timestamp"]) &&
    (o["label"] === undefined || typeof o["label"] === "string")
  );
}

export function isEnrollAck(v: unknown): v is EnrollAck {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o["type"] === "enroll_ack" &&
    typeof o["browserPubKey"] === "string" &&
    typeof o["ok"] === "boolean" &&
    typeof o["timestamp"] === "number" &&
    Number.isFinite(o["timestamp"])
  );
}

// ───────────────────────────── canonical signable views ─────────────────────────────

function reqTaggedView(r: Omit<EnrollRequest, "tag">): unknown {
  return {
    type: r.type,
    deviceId: r.deviceId,
    browserPubKey: r.browserPubKey,
    hkdfSalt: r.hkdfSalt,
    label: r.label,
    timestamp: r.timestamp,
  };
}

function ackSignableView(a: Omit<EnrollAck, "deviceSig">): unknown {
  return {
    type: a.type,
    ok: a.ok,
    browserPubKey: a.browserPubKey,
    keyId: a.keyId,
    devicePubKey: a.devicePubKey,
    enrolledAt: a.enrolledAt,
    timestamp: a.timestamp,
    reason: a.reason,
  };
}

// ───────────────────────────── build / verify request ─────────────────────────────

export interface BuildEnrollRequestArgs {
  deviceId: string;
  browserPubKey: Uint8Array;
  pairingCode: string;
  label?: string;
  /** Override clock (deterministic tests). */
  timestamp?: number;
  /** Inject a salt (deterministic tests). Defaults to 16 fresh random bytes. */
  hkdfSalt?: Uint8Array;
}

export async function buildEnrollRequest(args: BuildEnrollRequestArgs): Promise<EnrollRequest> {
  const code = normalizeCode(args.pairingCode);
  if (!code) throw new Error("buildEnrollRequest: invalid pairing code");
  const salt = args.hkdfSalt ?? randomBytes(16);
  const partial: Omit<EnrollRequest, "tag"> = {
    type: "enroll_request",
    deviceId: args.deviceId,
    browserPubKey: toBase64Url(args.browserPubKey),
    hkdfSalt: toBase64Url(salt),
    timestamp: args.timestamp ?? Date.now(),
    ...(args.label ? { label: args.label } : {}),
  };
  const key = await hkdfHmacKey(code, salt, HKDF_INFO);
  const bytes = ENC.encode(canonicalize(reqTaggedView(partial)));
  const tag = await hmac(key, bytes);
  return { ...partial, tag: toBase64Url(tag) };
}

export interface VerifyEnrollRequestArgs {
  request: EnrollRequest;
  /** The daemon's own deviceId — must match request.deviceId. */
  expectedDeviceId: string;
  /** The pairing code the daemon previously generated and showed to the user. */
  pairingCode: string;
  now?: number;
  maxAgeMs?: number;
}

export type VerifyEnrollResult = { ok: true } | { ok: false; reason: EnrollFailReason };

export async function verifyEnrollRequest(
  args: VerifyEnrollRequestArgs,
): Promise<VerifyEnrollResult> {
  if (args.request.deviceId !== args.expectedDeviceId) {
    return { ok: false, reason: "tampered" };
  }
  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? PAIRING_FRESHNESS_MS;
  if (typeof args.request.timestamp !== "number" || !Number.isFinite(args.request.timestamp)) {
    return { ok: false, reason: "stale" };
  }
  if (Math.abs(now - args.request.timestamp) > maxAge) {
    return { ok: false, reason: "stale" };
  }
  const code = normalizeCode(args.pairingCode);
  if (!code) return { ok: false, reason: "bad_code" };
  let salt: Uint8Array;
  let tag: Uint8Array;
  try {
    salt = fromBase64Url(args.request.hkdfSalt);
    tag = fromBase64Url(args.request.tag);
  } catch {
    return { ok: false, reason: "tampered" };
  }
  const key = await hkdfHmacKey(code, salt, HKDF_INFO);
  const partial: Omit<EnrollRequest, "tag"> = {
    type: args.request.type,
    deviceId: args.request.deviceId,
    browserPubKey: args.request.browserPubKey,
    hkdfSalt: args.request.hkdfSalt,
    timestamp: args.request.timestamp,
    ...(args.request.label !== undefined ? { label: args.request.label } : {}),
  };
  const bytes = ENC.encode(canonicalize(reqTaggedView(partial)));
  const valid = await hmacVerify(key, bytes, tag);
  return valid ? { ok: true } : { ok: false, reason: "bad_code" };
}

// ───────────────────────────── build / verify ack ─────────────────────────────

export interface BuildEnrollAckArgs {
  ok: boolean;
  /** The pubkey we're acknowledging — echoed so each browser can filter the ack. */
  browserPubKey: string;
  /** Required when ok=true. */
  deviceSecretKey?: Uint8Array;
  devicePubKey?: Uint8Array;
  keyId?: string;
  enrolledAt?: number;
  timestamp?: number;
  reason?: EnrollFailReason;
}

export async function buildEnrollAck(args: BuildEnrollAckArgs): Promise<EnrollAck> {
  const ack: Omit<EnrollAck, "deviceSig"> = {
    type: "enroll_ack",
    ok: args.ok,
    browserPubKey: args.browserPubKey,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.keyId !== undefined ? { keyId: args.keyId } : {}),
    ...(args.devicePubKey ? { devicePubKey: toBase64Url(args.devicePubKey) } : {}),
    ...(args.enrolledAt !== undefined ? { enrolledAt: args.enrolledAt } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  };
  if (args.ok && args.deviceSecretKey) {
    const bytes = ENC.encode(canonicalize(ackSignableView(ack)));
    const sig = await ed.signAsync(bytes, args.deviceSecretKey);
    return { ...ack, deviceSig: toBase64Url(sig) };
  }
  return ack as EnrollAck;
}

export interface VerifyEnrollAckArgs {
  ack: EnrollAck;
  /** The browser's own pubkey (base64url) — the ack must echo it. */
  expectedBrowserPubKey: string;
  /** The daemon's expected device pubkey, learned out-of-band (trusted directory). */
  expectedDevicePubKey: Uint8Array;
}

/** True iff the ack passes EVERY check: echo match, ok=true, devicePubKey match, Ed25519 valid. */
export async function verifyEnrollAck(args: VerifyEnrollAckArgs): Promise<boolean> {
  if (args.ack.browserPubKey !== args.expectedBrowserPubKey) return false;
  if (!args.ack.ok) return false;
  if (!args.ack.devicePubKey || !args.ack.deviceSig) return false;
  if (toBase64Url(args.expectedDevicePubKey) !== args.ack.devicePubKey) return false;
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(args.ack.deviceSig);
  } catch {
    return false;
  }
  const partial: Omit<EnrollAck, "deviceSig"> = {
    type: args.ack.type,
    ok: args.ack.ok,
    browserPubKey: args.ack.browserPubKey,
    timestamp: args.ack.timestamp,
    ...(args.ack.keyId !== undefined ? { keyId: args.ack.keyId } : {}),
    ...(args.ack.devicePubKey !== undefined ? { devicePubKey: args.ack.devicePubKey } : {}),
    ...(args.ack.enrolledAt !== undefined ? { enrolledAt: args.ack.enrolledAt } : {}),
    ...(args.ack.reason !== undefined ? { reason: args.ack.reason } : {}),
  };
  const bytes = ENC.encode(canonicalize(ackSignableView(partial)));
  try {
    return await ed.verifyAsync(sig, bytes, args.expectedDevicePubKey);
  } catch {
    return false;
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function randomBytes(n: number): Uint8Array {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new Error("WebCrypto getRandomValues is required");
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}
