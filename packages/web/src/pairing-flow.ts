/**
 * Browser side of the pairing protocol (Phase 1, S1.5). Drives the pre-session enroll_request/ack
 * cycle over a STRUCTURAL transport interface so it's testable without WebSockets and reusable across
 * the App / pairing screen / tests.
 *
 * Inputs:
 *   transport.send(frame)  — write a raw JSON frame (bare enroll_request) onto the wire
 *   transport.onFrame(h)   — register a handler for inbound JSON frames; returns unsubscribe
 *   directory.devicePubKey(deviceId) — async lookup of the daemon's expected pubkey (Supabase in prod)
 *
 * Output:
 *   `start(code)` returns a promise that resolves with `{ keyId }` on success, or rejects with a
 *   typed error. Stores `{deviceId, keyId, devicePubKey}` in localStorage so future sessions skip
 *   pairing for this device.
 */

import {
  buildEnrollRequest,
  fromBase64Url,
  isEnrollAck,
  toBase64Url,
  verifyEnrollAck,
  type EnrollAck,
  type EnrollFailReason,
} from "@wcc/shared";

export interface PairingTransport {
  send(frame: unknown): void;
  onFrame(handler: (frame: unknown) => void): () => void;
}

export interface PairingDirectory {
  /** Look up the daemon's expected long-term Ed25519 device pubkey. */
  devicePubKey(deviceId: string): Promise<Uint8Array | undefined>;
}

export interface PairingResult {
  keyId: string;
  enrolledAt: number;
  devicePubKey: string; // base64url
}

export type PairingErrorReason =
  | EnrollFailReason
  | "directory_miss" // we don't know this daemon's pubkey
  | "device_pubkey_mismatch" // the relay impersonated the daemon (or directory is wrong)
  | "signature_invalid"
  | "timeout"
  | "transport_lost";

export class PairingError extends Error {
  constructor(
    readonly reason: PairingErrorReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "PairingError";
  }
}

export interface StartPairingArgs {
  deviceId: string;
  code: string;
  browserPubKey: Uint8Array;
  browserSecretKey?: Uint8Array; // not used here; kept for future BPK-derived flows
  label?: string;
  transport: PairingTransport;
  directory: PairingDirectory;
  /** Ms before giving up waiting for an enroll_ack. Default 30s. */
  timeoutMs?: number;
  /** Override clock (tests). */
  now?: () => number;
  /** Persist the pairing result. Default: localStorage. Pass null to skip. */
  storage?: PairingStorage | null;
}

const PAIRINGS_KEY = "wcc.pairings.v1";

export interface PairingStorage {
  load(): Record<string, PairingResult>;
  save(map: Record<string, PairingResult>): void;
}

export const localStoragePairingStorage: PairingStorage = {
  load(): Record<string, PairingResult> {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem(PAIRINGS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, PairingResult>) : {};
    } catch {
      return {};
    }
  },
  save(map): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(PAIRINGS_KEY, JSON.stringify(map));
    } catch {
      /* ignore */
    }
  },
};

/** True iff this browser already enrolled with `deviceId`. */
export function isAlreadyPaired(deviceId: string, storage: PairingStorage = localStoragePairingStorage): boolean {
  return Boolean(storage.load()[deviceId]);
}

export function getPairing(deviceId: string, storage: PairingStorage = localStoragePairingStorage): PairingResult | undefined {
  return storage.load()[deviceId];
}

export function forgetPairing(deviceId: string, storage: PairingStorage = localStoragePairingStorage): void {
  const map = storage.load();
  delete map[deviceId];
  storage.save(map);
}

/**
 * Send an enroll_request and await an enroll_ack addressed to this browser. Verifies the ack against
 * the daemon's expected pubkey from the directory; rejects on any mismatch / forgery / timeout.
 */
export async function startPairing(args: StartPairingArgs): Promise<PairingResult> {
  const expectedDevicePubKey = await args.directory.devicePubKey(args.deviceId);
  if (!expectedDevicePubKey) {
    throw new PairingError("directory_miss", `no pubkey for device ${args.deviceId}`);
  }

  const browserPubB64 = toBase64Url(args.browserPubKey);
  const timeoutMs = args.timeoutMs ?? 30_000;
  const storage = args.storage === undefined ? localStoragePairingStorage : args.storage;

  let off: (() => void) | undefined;
  return new Promise<PairingResult>(async (resolve, reject) => {
    const timer = setTimeout(() => {
      off?.();
      reject(new PairingError("timeout"));
    }, timeoutMs);
    off = args.transport.onFrame(async (frame) => {
      if (!isEnrollAck(frame)) return;
      const ack = frame as EnrollAck;
      if (ack.browserPubKey !== browserPubB64) return; // not for us
      clearTimeout(timer);
      off?.();
      if (!ack.ok) {
        return reject(new PairingError(ack.reason ?? "unknown"));
      }
      if (!ack.devicePubKey || toBase64Url(expectedDevicePubKey) !== ack.devicePubKey) {
        return reject(new PairingError("device_pubkey_mismatch"));
      }
      const valid = await verifyEnrollAck({
        ack,
        expectedBrowserPubKey: browserPubB64,
        expectedDevicePubKey,
      });
      if (!valid) return reject(new PairingError("signature_invalid"));
      if (!ack.keyId) return reject(new PairingError("unknown", "ack missing keyId"));
      const result: PairingResult = {
        keyId: ack.keyId,
        enrolledAt: ack.enrolledAt ?? (args.now ?? Date.now)(),
        devicePubKey: ack.devicePubKey,
      };
      if (storage) {
        const map = storage.load();
        map[args.deviceId] = result;
        storage.save(map);
      }
      resolve(result);
    });
    try {
      const req = await buildEnrollRequest({
        deviceId: args.deviceId,
        browserPubKey: args.browserPubKey,
        pairingCode: args.code,
        ...(args.label ? { label: args.label } : {}),
        ...(args.now ? { timestamp: args.now() } : {}),
      });
      args.transport.send(req);
    } catch (err) {
      clearTimeout(timer);
      off?.();
      reject(new PairingError("unknown", String(err)));
    }
  });
}

// Re-export so tests/UI can resolve a daemon's pubkey from a fake directory.
export { fromBase64Url };
