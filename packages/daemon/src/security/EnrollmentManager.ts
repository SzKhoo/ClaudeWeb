/**
 * EnrollmentManager — Phase 1 / decision D1. Receives `enroll_request` pairing frames (pre-session,
 * relay-forwarded), verifies them against an active pairing code, enrolls the browser pubkey, and
 * returns a device-signed `enroll_ack`.
 *
 * Failure replies (ok=false) are NEVER device-signed — there's nothing for the browser to verify yet,
 * and the browser only treats `enroll_ack` as authoritative if BOTH ok=true AND signature verifies.
 *
 * On idempotent retry (same code, same browserPubKey within TTL): returns the SAME ack (success), so a
 * lost ack the browser can retry without burning the code.
 */

import {
  buildEnrollAck,
  deriveChannelKeyFromRaw,
  fromBase64Url,
  generateX25519KeyPair,
  isEnrollRequest,
  toBase64Url,
  verifyEnrollRequest,
  type EnrollAck,
  type EnrollFailReason,
  type EnrollRequest,
} from "@wcc/shared";
import { EnrolledKeyStore, type EnrolledKey } from "./EnrolledKeyStore.js";
import { PairingCodeStore } from "./PairingCodeStore.js";

export interface EnrollmentManagerOptions {
  /** Daemon's deviceId. Populated by Daemon at construction time. */
  deviceId?: string;
  /** Persistent enrolled-key registry. */
  enrolledKeys: EnrolledKeyStore;
  /** Pairing-code lifecycle. */
  codes: PairingCodeStore;
  /** Device identity for signing the ack. */
  deviceSecretKey: Uint8Array;
  devicePubKey: Uint8Array;
  now?: () => number;
  /** Optional id generator (test injection). Default: random UUID. */
  newKeyId?: () => string;
  logger?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
}

export class EnrollmentManager {
  private readonly deviceId: string;
  private readonly enrolledKeys: EnrolledKeyStore;
  private readonly codes: PairingCodeStore;
  private readonly deviceSecretKey: Uint8Array;
  private readonly devicePubKey: Uint8Array;
  private readonly now: () => number;
  private readonly newKeyId: () => string;
  private readonly log: NonNullable<EnrollmentManagerOptions["logger"]>;

  constructor(opts: EnrollmentManagerOptions) {
    if (!opts.deviceId) throw new Error("EnrollmentManager: deviceId required");
    this.deviceId = opts.deviceId;
    this.enrolledKeys = opts.enrolledKeys;
    this.codes = opts.codes;
    this.deviceSecretKey = opts.deviceSecretKey;
    this.devicePubKey = opts.devicePubKey;
    this.now = opts.now ?? Date.now;
    this.newKeyId = opts.newKeyId ?? defaultKeyId;
    this.log = opts.logger ?? (() => {});
  }

  /** Mint a code (the daemon CLI calls this; the user reads it off the trusted machine). */
  mintCode(label?: string): string {
    return this.codes.mint(label).code;
  }

  /** Pubkey the browser uses to verify an ack (so the UI can show it for sanity-check). */
  devicePublicKeyBytes(): Uint8Array {
    return this.devicePubKey;
  }

  /** Process an inbound enroll_request frame and produce an enroll_ack. */
  async handle(request: unknown): Promise<EnrollAck> {
    if (!isEnrollRequest(request)) {
      return this.fail("", "tampered");
    }
    const req = request as EnrollRequest;
    if (req.deviceId !== this.deviceId) {
      return this.fail(req.browserPubKey, "tampered");
    }

    // Find an active pairing code that, when used as the verifier's pairingCode, matches the tag.
    // Codes are short-lived and few; iterating is fine.
    let matchedCode: { code: string; consumedBy?: string } | undefined;
    for (const code of this.codes.entries()) {
      const v = await verifyEnrollRequest({
        request: req,
        expectedDeviceId: this.deviceId,
        pairingCode: code.code,
        now: this.now(),
      });
      if (v.ok) {
        matchedCode = { code: code.code, ...(code.consumedBy ? { consumedBy: code.consumedBy } : {}) };
        break;
      }
      // "stale" is code-independent — short-circuit
      if (v.reason === "stale") {
        return this.fail(req.browserPubKey, "stale");
      }
    }

    if (!matchedCode) {
      this.log("warn", "enroll_request: no matching active code");
      return this.fail(req.browserPubKey, "bad_code");
    }

    // Idempotency: same code already consumed by THIS pubkey → return the existing enrolled record.
    const consume = this.codes.consume(matchedCode.code, req.browserPubKey);
    if (consume === "consumed") {
      // Code was burned by a DIFFERENT pubkey already.
      return this.fail(req.browserPubKey, "consumed");
    }

    // Phase 2b: if the browser included an X25519 pubkey, generate our own X25519 keypair, derive
    // the channel key, and persist it on the enrolled record. The browser derives the same key
    // when it verifies the ack. If the browser omitted its X25519 pubkey we fall back to the
    // Phase-1 shape (no encryption yet) so migration is smooth — Stage 2 wires the AEAD layer.
    let ourX25519PubKey: Uint8Array | undefined;
    let channelKey: Uint8Array | undefined;
    if (req.browserX25519PubKey) {
      try {
        const ours = await generateX25519KeyPair();
        ourX25519PubKey = ours.publicKey;
        const peerX = fromBase64Url(req.browserX25519PubKey);
        // Contextual salt = the browser's Ed25519 signing pubkey — a value both sides agree on and
        // that's already integrity-protected by the enroll_request tag.
        channelKey = await deriveChannelKeyFromRaw(
          ours.privateKey,
          peerX,
          fromBase64Url(req.browserPubKey),
        );
      } catch (err) {
        this.log("warn", "x25519 derivation failed; enrolling without channel key", {
          err: String(err),
        });
        ourX25519PubKey = undefined;
        channelKey = undefined;
      }
    }

    const enrolled: EnrolledKey = await this.enrolledKeys.enroll({
      pubkey: fromBase64Url(req.browserPubKey),
      ...(req.label ? { label: req.label } : {}),
      enrolledAt: this.now(),
      keyId: this.newKeyId(),
      ...(channelKey ? { channelKey: toBase64Url(channelKey) } : {}),
    });
    this.log("info", "enrolled browser key", {
      keyId: enrolled.keyId,
      label: enrolled.label,
      channelKey: channelKey ? "derived" : "none",
    });

    return buildEnrollAck({
      ok: true,
      browserPubKey: req.browserPubKey,
      deviceSecretKey: this.deviceSecretKey,
      devicePubKey: this.devicePubKey,
      keyId: enrolled.keyId,
      enrolledAt: enrolled.enrolledAt,
      timestamp: this.now(),
      ...(ourX25519PubKey ? { deviceX25519PubKey: ourX25519PubKey } : {}),
    });
  }

  /** Revoke a previously enrolled key. */
  async revoke(keyId: string): Promise<boolean> {
    return this.enrolledKeys.revoke(keyId, this.now());
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async fail(browserPubKey: string, reason: EnrollFailReason): Promise<EnrollAck> {
    return buildEnrollAck({
      ok: false,
      browserPubKey,
      reason,
      timestamp: this.now(),
    });
  }

}

function defaultKeyId(): string {
  // node 20+ ships crypto.randomUUID on globalThis.crypto
  const c = (globalThis as unknown as { crypto?: Crypto & { randomUUID?(): string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: 16 random hex bytes.
  const u = new Uint8Array(16);
  c?.getRandomValues?.(u);
  let out = "";
  for (let i = 0; i < u.length; i++) out += u[i]!.toString(16).padStart(2, "0");
  return out;
}
