/**
 * Relay-LOCAL control frames (browser/daemon <-> relay). These are consumed by the relay and NEVER
 * forwarded. They are deliberately separate from the end-to-end protocol (ConnHello/TransportEnvelope
 * in @wcc/shared), which the relay forwards opaquely and never parses (invariant #1, #5).
 *
 * Two handshakes exist:
 *   1. THIS relay handshake: authenticate to the relay + register routing (token, role, deviceId).
 *   2. The E2E protocol handshake (ConnHello/ConnAck) flows browser<->daemon THROUGH the relay,
 *      opaque to it.
 */

export type RelayRole = "daemon" | "browser";

/** First frame a peer sends to the relay. Authenticates + registers it in the routing table. */
export interface RelayRegister {
  type: "relay_register";
  /** Shared bearer token (Phase 0). Phase 1 replaces with Supabase JWT (browser) / device token (daemon). */
  token: string;
  role: RelayRole;
  /** Routing key. The ONLY identifier the relay uses to bucket connections. */
  deviceId: string;
  /** Browser instance id (opaque to routing; carried only so logs/presence can distinguish clients). */
  clientInstanceId?: string;
}

/** Relay -> peer: registration accepted; the connection is now in opaque-forward mode. */
export interface RelayRegistered {
  type: "relay_registered";
  ok: true;
  role: RelayRole;
  deviceId: string;
  /** Whether the counterpart (for a browser: the device's daemon) is currently connected. */
  peerOnline: boolean;
}

/** Relay -> peer: a relay-level error (bad token, malformed register, no daemon online, etc.). */
export interface RelayError {
  type: "relay_error";
  ok: false;
  code:
    | "bad_token"
    | "bad_register"
    | "register_timeout"
    | "device_offline"
    | "not_registered"
    | "internal";
  message: string;
}

/** Relay -> browser(s): presence change for the device's daemon (connect/disconnect). */
export interface RelayPeer {
  type: "relay_peer";
  role: "daemon";
  online: boolean;
}

export type RelayControlFrame = RelayRegister | RelayRegistered | RelayError | RelayPeer;

const ROLES: ReadonlySet<string> = new Set<RelayRole>(["daemon", "browser"]);

/** Validate a parsed value as a RelayRegister (the only frame the relay accepts inbound). */
export function isRelayRegister(value: unknown): value is RelayRegister {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["type"] === "relay_register" &&
    typeof v["token"] === "string" &&
    typeof v["role"] === "string" &&
    ROLES.has(v["role"] as string) &&
    typeof v["deviceId"] === "string" &&
    (v["deviceId"] as string).length > 0 &&
    (v["clientInstanceId"] === undefined || typeof v["clientInstanceId"] === "string")
  );
}
