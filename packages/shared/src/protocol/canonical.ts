/**
 * Canonical serialization — deterministic bytes that both ends compute identically, so a signature
 * made in the browser verifies in the daemon.
 *
 * CORRECTION #3: we do NOT trust `JSON.stringify(obj)`. V8 emits integer-like object keys first in
 * numeric order regardless of insertion, and number formatting can vary — so two structurally-equal
 * objects can stringify differently. Instead we walk the value ourselves and emit keys in an explicit
 * code-unit-sorted order, building the string by hand. We never rely on the engine's own object key
 * iteration order.
 *
 * CORRECTION #2: the signable view includes `deviceId` and `clientInstanceId` (the routing-security
 * fields) plus `sessionId`, `seq` (nonce) and `timestamp` (freshness) — so a relay cannot retarget or
 * replay a validly-signed message. `sig` itself is deliberately excluded.
 */

import type { TransportEnvelope } from "./envelope.js";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

/** Serialize a JSON-like value to a single canonical string. Deterministic for equal inputs. */
export function canonicalize(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error(`canonicalize: non-finite number ${String(n)}`);
    }
    // Integers (our only signed numeric fields: seq, timestamp, offsets) serialize exactly.
    if (Number.isInteger(n)) return Object.is(n, -0) ? "0" : String(n);
    // Non-integers are not used in signed fields today; use a stable representation if they appear.
    return JSON.stringify(n);
  }

  if (t === "string") return JSON.stringify(value);

  if (t === "bigint") {
    throw new Error("canonicalize: bigint is not supported in signed payloads");
  }

  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += write(value[i]);
    }
    return out + "]";
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Collect own enumerable keys, drop `undefined` values, sort by UTF-16 code unit (ASCII-safe).
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (i > 0) out += ",";
      out += JSON.stringify(k) + ":" + write(obj[k]);
    }
    return out + "}";
  }

  throw new Error(`canonicalize: unsupported type ${t}`);
}

/**
 * The exact view of an envelope that gets signed. Field names are short, fixed keys; the full
 * application `payload` (including its `type`) is included verbatim.
 */
export function signableView(env: TransportEnvelope): CanonicalValue {
  return {
    v: env.protocolVersion,
    d: env.deviceId,
    c: env.clientInstanceId,
    s: env.sessionId,
    n: env.seq, // nonce
    t: env.timestamp, // freshness
    p: env.payload as unknown as CanonicalValue,
  };
}

const ENCODER = new TextEncoder();

/** Canonical bytes over the signable view of an envelope (what sign()/verify() operate on). */
export function toCanonicalBytes(env: TransportEnvelope): Uint8Array {
  return ENCODER.encode(canonicalize(signableView(env)));
}
