/**
 * Transport envelope — the outermost frame on the wire.
 *
 * Layering (invariant #1): the envelope carries routing + integrity metadata; `payload` carries the
 * application message. The relay reads ONLY `deviceId` for routing (invariant #5); `sessionId` and
 * `clientInstanceId` are end-to-end and opaque to it.
 *
 * CORRECTION #2: `deviceId` and `clientInstanceId` are part of the signed canonical bytes (see
 * canonical.ts) so a relay cannot retarget a validly-signed message to another device/client/cursor.
 * CORRECTION #4: `seq` is a per-(sessionId, clientInstanceId) MONOTONIC counter; it doubles as the
 * replay nonce (reject seq <= lastSeen) instead of an unbounded nonce set.
 * CORRECTION #6: `timestamp` freshness assumes loosely-synced clocks (NTP); window = MAX_CLOCK_SKEW_MS.
 */

import type { ApplicationMessage } from "./messages.js";

export interface TransportEnvelope<P = ApplicationMessage> {
  /** Operating protocol version for this connection. */
  protocolVersion: string;
  /** Routing key — the ONLY field the relay inspects. */
  deviceId: string;
  /** End-to-end session id. Empty string for pre-session control frames. Opaque to the relay. */
  sessionId: string;
  /** End-to-end instance id of the sender (a specific browser or the daemon). Opaque to the relay. */
  clientInstanceId: string;
  /** Per-(sessionId, clientInstanceId) monotonic counter; doubles as the replay nonce. */
  seq: number;
  /** Sender clock, epoch ms. Used for the freshness window. */
  timestamp: number;
  /** Optional cumulative ack of the peer's highest seq (piggybacked transport bookkeeping). */
  ack?: number;
  /** base64url Ed25519 signature over the canonical bytes. Required on commands; absent on events. */
  sig?: string;
  /** The application message. */
  payload: P;
}

export interface NewEnvelopeArgs<P extends ApplicationMessage = ApplicationMessage> {
  protocolVersion: string;
  deviceId: string;
  sessionId: string;
  clientInstanceId: string;
  seq: number;
  payload: P;
  timestamp?: number;
  ack?: number;
}

/** Construct an unsigned envelope (call signEnvelope() afterwards to populate `sig`). */
export function newEnvelope<P extends ApplicationMessage = ApplicationMessage>(
  args: NewEnvelopeArgs<P>,
): TransportEnvelope<P> {
  const env: TransportEnvelope<P> = {
    protocolVersion: args.protocolVersion,
    deviceId: args.deviceId,
    sessionId: args.sessionId,
    clientInstanceId: args.clientInstanceId,
    seq: args.seq,
    timestamp: args.timestamp ?? Date.now(),
    payload: args.payload,
  };
  if (args.ack !== undefined) env.ack = args.ack;
  return env;
}

/** Structural validation of an inbound value before trusting any field. */
export function isTransportEnvelope(value: unknown): value is TransportEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["protocolVersion"] === "string" &&
    typeof e["deviceId"] === "string" &&
    typeof e["sessionId"] === "string" &&
    typeof e["clientInstanceId"] === "string" &&
    typeof e["seq"] === "number" &&
    Number.isFinite(e["seq"] as number) &&
    typeof e["timestamp"] === "number" &&
    Number.isFinite(e["timestamp"] as number) &&
    typeof e["payload"] === "object" &&
    e["payload"] !== null &&
    typeof (e["payload"] as Record<string, unknown>)["type"] === "string" &&
    (e["sig"] === undefined || typeof e["sig"] === "string") &&
    (e["ack"] === undefined || typeof e["ack"] === "number")
  );
}
