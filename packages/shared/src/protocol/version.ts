/**
 * Protocol versioning + capability negotiation.
 *
 * Invariant #6: the connection handshake exchanges versions and a capability list so the two ends
 * can negotiate behaviour without a lock-step deploy.
 *
 * CORRECTION #1 (from plan review): semver is compared NUMERICALLY. String comparison is wrong —
 * `"1.10.0" >= "1.9.0"` is `false` lexically. We parse and compare the numeric triple.
 */

/** Current wire protocol version produced by this build. */
export const PROTOCOL_VERSION = "1.0.0";

/** Oldest protocol version this build can still talk to (same major line). */
export const MIN_PROTOCOL_VERSION = "1.0.0";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse `"X.Y.Z"` (an optional `-prerelease`/`+build` suffix is ignored for comparison).
 * Throws on anything that is not three numeric, dot-separated parts.
 */
export function parseSemVer(version: string): SemVer {
  const core = version.split("+")[0]!.split("-")[0]!;
  const parts = core.split(".");
  if (parts.length !== 3) {
    throw new Error(`Invalid semver: ${JSON.stringify(version)}`);
  }
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) {
      throw new Error(`Invalid semver component ${JSON.stringify(p)} in ${JSON.stringify(version)}`);
    }
    return Number(p);
  });
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]! };
}

/** Numeric semver comparison. Returns -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemVer(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] < pb[k]) return -1;
    if (pa[k] > pb[k]) return 1;
  }
  return 0;
}

/**
 * Is a remote peer's protocol version compatible with this build?
 *
 * Compatible iff: same MAJOR line, and the remote version is not older than our minimum supported
 * version. (Newer-than-ours within the same major is allowed; we degrade to our known features via
 * the negotiated capability list.)
 */
export function isCompatible(
  remoteVersion: string,
  localMin: string = MIN_PROTOCOL_VERSION,
  localMax: string = PROTOCOL_VERSION,
): boolean {
  let remote: SemVer;
  try {
    remote = parseSemVer(remoteVersion);
  } catch {
    return false;
  }
  const maxMajor = parseSemVer(localMax).major;
  if (remote.major !== maxMajor) return false;
  return compareSemVer(remoteVersion, localMin) >= 0;
}

/**
 * Capabilities a peer may advertise. Forward-compatible: unknown strings are tolerated, so a newer
 * peer can advertise capabilities this build does not yet know about.
 */
export type Capability =
  | "stream" // incremental assistant_delta events
  | "tool-approval" // permission_request / permission_response round-trip
  | "diff-preview" // permission_request carries a diff for file edits
  | "interrupt" // interrupt command stops an in-flight turn
  | "resume" // transport stream resume (sinceSeq + tool stream offsets)
  | "conversation-resume" // engine native session/conversation resume
  | "multi-client"; // multiple clientInstanceIds attached to one session

export type Role = "daemon" | "browser";

/** First frame each side sends on (re)connect, before any application traffic. */
export interface ConnHello {
  type: "conn_hello";
  role: Role;
  /** Highest protocol version this peer speaks. */
  protocolVersion: string;
  /** Oldest protocol version this peer still accepts. */
  minProtocolVersion: string;
  /** Human-facing build version (e.g. daemon app version). */
  buildVersion?: string;
  capabilities: (Capability | string)[];
  deviceId: string;
  /** Present for browser peers; identifies this specific browser instance. */
  clientInstanceId?: string;
}

/** Reply to a ConnHello. */
export interface ConnAck {
  type: "conn_ack";
  ok: boolean;
  /** Version the connection will operate at (the negotiated min of the two maxes). */
  protocolVersion: string;
  /** Capabilities both ends agreed to use (intersection of advertised sets we understand). */
  capabilities: (Capability | string)[];
  /** Populated when ok=false. */
  reason?: string;
}

/** Negotiate the operating version: the lower of the two peers' maxima, if compatible. */
export function negotiateVersion(localMax: string, remoteMax: string): string {
  return compareSemVer(localMax, remoteMax) <= 0 ? localMax : remoteMax;
}

/** Intersection of advertised capabilities with the set this build understands. */
export function negotiateCapabilities(
  remote: (Capability | string)[],
  understood: readonly Capability[],
): Capability[] {
  const set = new Set(remote);
  return understood.filter((c) => set.has(c));
}
