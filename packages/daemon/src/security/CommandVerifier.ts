/**
 * CommandVerifier — the gate every inbound command passes through before the daemon acts on it
 * (invariants #1, #2, #4). It enforces: structurally-valid envelope, payload IS a command, signed by
 * an AUTHORIZED (paired) browser key, fresh (within the clock window), and not a replay.
 *
 * PairingStore holds the authorized browser public keys. Phase 0 provisions them locally (env/file or
 * direct injection in tests); Phase 1 binds them to accounts via Supabase + passkey enrollment.
 */

import {
  isCommand,
  isTransportEnvelope,
  ReplayGuard,
  verifyEnvelope,
  type ApplicationCommand,
  type TransportEnvelope,
} from "@wcc/shared";

export class PairingStore {
  private readonly pubkeys: Uint8Array[] = [];

  addPublicKey(pk: Uint8Array): void {
    if (!this.pubkeys.some((k) => equalBytes(k, pk))) this.pubkeys.push(pk);
  }

  keys(): readonly Uint8Array[] {
    return this.pubkeys;
  }

  get size(): number {
    return this.pubkeys.length;
  }
}

export type VerifyReason =
  | "malformed"
  | "not_command"
  | "unsigned"
  | "bad-timestamp"
  | "stale"
  | "bad-signature"
  | "replayed"
  | "unauthorized";

export type VerifyOutcome =
  | { ok: true; command: ApplicationCommand; clientInstanceId: string; sessionId: string; seq: number }
  | { ok: false; reason: VerifyReason };

export interface CommandVerifierOptions {
  maxSkewMs?: number;
  now?: () => number;
}

export class CommandVerifier {
  private readonly replay: ReplayGuard;
  constructor(
    private readonly pairing: PairingStore,
    replay?: ReplayGuard,
    private readonly opts: CommandVerifierOptions = {},
  ) {
    this.replay = replay ?? new ReplayGuard();
  }

  async verify(value: unknown): Promise<VerifyOutcome> {
    if (!isTransportEnvelope(value)) return { ok: false, reason: "malformed" };
    const env = value as TransportEnvelope;
    if (!isCommand(env.payload)) return { ok: false, reason: "not_command" };

    if (this.pairing.size === 0) return { ok: false, reason: "unauthorized" };

    const now = this.opts.now ? this.opts.now() : undefined;
    let lastReason: VerifyReason = "unauthorized";
    let matched = false;
    for (const key of this.pairing.keys()) {
      // No replay guard here — we advance replay only once, AFTER a key matches.
      const r = await verifyEnvelope(env, key, {
        ...(now !== undefined ? { now } : {}),
        ...(this.opts.maxSkewMs !== undefined ? { maxSkewMs: this.opts.maxSkewMs } : {}),
      });
      if (r.ok) {
        matched = true;
        break;
      }
      lastReason = r.reason;
      // unsigned/stale are key-independent — no point trying other keys.
      if (r.reason === "unsigned" || r.reason === "stale") break;
    }
    if (!matched) return { ok: false, reason: lastReason };

    if (!this.replay.accept(env)) return { ok: false, reason: "replayed" };

    return {
      ok: true,
      command: env.payload,
      clientInstanceId: env.clientInstanceId,
      sessionId: env.sessionId,
      seq: env.seq,
    };
  }

  /** Drop replay state for a finished session. */
  forgetSession(sessionId: string): void {
    this.replay.forgetSession(sessionId);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
