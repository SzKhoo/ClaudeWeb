import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  newEnvelope,
  signed,
  type ApplicationCommand,
  type ApplicationEvent,
  type TransportEnvelope,
} from "@wcc/shared";
import { CommandVerifier, PairingStore } from "../src/security/CommandVerifier.js";

const FIXED_NOW = 1_700_000_000_000;

function baseEnvelope(
  payload: ApplicationCommand | ApplicationEvent,
  over: Partial<TransportEnvelope> = {},
): TransportEnvelope {
  return newEnvelope({
    protocolVersion: "1.0.0",
    deviceId: "dev-device",
    sessionId: "s1",
    clientInstanceId: "browser-1",
    seq: over.seq ?? 1,
    payload,
    timestamp: over.timestamp ?? FIXED_NOW,
  });
}

const userCmd: ApplicationCommand = { type: "user_message", text: "hi" };

describe("CommandVerifier", () => {
  it("accepts a fresh, signed command from a paired key", async () => {
    const keys = await generateKeyPair();
    const pairing = new PairingStore();
    pairing.addPublicKey(keys.publicKey);
    const verifier = new CommandVerifier(pairing, undefined, { now: () => FIXED_NOW });

    const env = await signed(baseEnvelope(userCmd), keys.secretKey);
    const result = await verifier.verify(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.type).toBe("user_message");
      expect(result.clientInstanceId).toBe("browser-1");
      expect(result.seq).toBe(1);
    }
  });

  it("rejects a replayed command (same monotonic seq twice)", async () => {
    const keys = await generateKeyPair();
    const pairing = new PairingStore();
    pairing.addPublicKey(keys.publicKey);
    const verifier = new CommandVerifier(pairing, undefined, { now: () => FIXED_NOW });

    const env = await signed(baseEnvelope(userCmd), keys.secretKey);
    expect((await verifier.verify(env)).ok).toBe(true);
    const replay = await verifier.verify(env);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("replayed");
  });

  it("rejects an unsigned command", async () => {
    const keys = await generateKeyPair();
    const pairing = new PairingStore();
    pairing.addPublicKey(keys.publicKey);
    const verifier = new CommandVerifier(pairing, undefined, { now: () => FIXED_NOW });

    const env = baseEnvelope(userCmd); // never signed
    const result = await verifier.verify(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsigned");
  });

  it("rejects a stale command (timestamp outside the freshness window)", async () => {
    const keys = await generateKeyPair();
    const pairing = new PairingStore();
    pairing.addPublicKey(keys.publicKey);
    const verifier = new CommandVerifier(pairing, undefined, { now: () => FIXED_NOW });

    const env = await signed(baseEnvelope(userCmd, { timestamp: FIXED_NOW - 120_000 }), keys.secretKey);
    const result = await verifier.verify(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");
  });

  it("rejects a command signed by an unpaired key", async () => {
    const paired = await generateKeyPair();
    const attacker = await generateKeyPair();
    const pairing = new PairingStore();
    pairing.addPublicKey(paired.publicKey);
    const verifier = new CommandVerifier(pairing, undefined, { now: () => FIXED_NOW });

    const env = await signed(baseEnvelope(userCmd), attacker.secretKey);
    const result = await verifier.verify(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects everything when no browser key is paired (default-deny)", async () => {
    const keys = await generateKeyPair();
    const verifier = new CommandVerifier(new PairingStore(), undefined, { now: () => FIXED_NOW });
    const env = await signed(baseEnvelope(userCmd), keys.secretKey);
    const result = await verifier.verify(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("rejects a payload that is an event, not a command", async () => {
    const keys = await generateKeyPair();
    const pairing = new PairingStore();
    pairing.addPublicKey(keys.publicKey);
    const verifier = new CommandVerifier(pairing, undefined, { now: () => FIXED_NOW });

    const evt: ApplicationEvent = { type: "assistant_message", text: "nope" };
    const env = await signed(baseEnvelope(evt), keys.secretKey);
    const result = await verifier.verify(env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_command");
  });

  it("rejects a structurally malformed frame", async () => {
    const verifier = new CommandVerifier(new PairingStore());
    const result = await verifier.verify({ not: "an envelope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});
