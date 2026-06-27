import { describe, it, expect, beforeAll } from "vitest";
import { newEnvelope, type TransportEnvelope, type NewEnvelopeArgs } from "../src/protocol/envelope.js";
import type { CmdUserMessage } from "../src/protocol/messages.js";
import {
  generateKeyPair,
  signed,
  verifyEnvelope,
  ReplayGuard,
  MAX_CLOCK_SKEW_MS,
  type KeyPair,
} from "../src/protocol/sign.js";

const FIXED_TS = 1_700_000_000_000;

function makeCmd(over: Partial<NewEnvelopeArgs<CmdUserMessage>> = {}): TransportEnvelope<CmdUserMessage> {
  return newEnvelope<CmdUserMessage>({
    protocolVersion: "1.0.0",
    deviceId: "dev-1",
    sessionId: "sess-1",
    clientInstanceId: "client-A",
    seq: 1,
    timestamp: FIXED_TS,
    payload: { type: "user_message", text: "create hello.txt" },
    ...over,
  });
}

describe("signEnvelope / verifyEnvelope", () => {
  let kp: KeyPair;
  let rogue: KeyPair;
  beforeAll(async () => {
    kp = await generateKeyPair();
    rogue = await generateKeyPair();
  });

  it("accepts a valid signed command (round-trip)", async () => {
    const env = await signed(makeCmd(), kp.secretKey);
    const res = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS });
    expect(res).toEqual({ ok: true });
  });

  it("rejects an UNSIGNED command", async () => {
    const env = makeCmd(); // no sig
    const res = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS });
    expect(res).toEqual({ ok: false, reason: "unsigned" });
  });

  it("rejects a FORGED payload (tampered after signing)", async () => {
    const env = await signed(makeCmd(), kp.secretKey);
    const tampered = { ...env, payload: { type: "user_message", text: "rm -rf /" } as CmdUserMessage };
    const res = await verifyEnvelope(tampered, kp.publicKey, { now: FIXED_TS });
    expect(res).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a RETARGETED message (relay changes clientInstanceId) — correction #2", async () => {
    const env = await signed(makeCmd(), kp.secretKey);
    const retargetedClient = { ...env, clientInstanceId: "client-EVIL" };
    const retargetedDevice = { ...env, deviceId: "dev-EVIL" };
    expect(await verifyEnvelope(retargetedClient, kp.publicKey, { now: FIXED_TS })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyEnvelope(retargetedDevice, kp.publicKey, { now: FIXED_TS })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a message signed by a ROGUE key", async () => {
    const env = await signed(makeCmd(), rogue.secretKey);
    const res = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS });
    expect(res).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a STALE message (timestamp too old)", async () => {
    const env = await signed(makeCmd({ timestamp: FIXED_TS }), kp.secretKey);
    const res = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS + MAX_CLOCK_SKEW_MS + 1 });
    expect(res).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects a FAR-FUTURE message (clock skew beyond window)", async () => {
    const env = await signed(makeCmd({ timestamp: FIXED_TS }), kp.secretKey);
    const res = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS - MAX_CLOCK_SKEW_MS - 1 });
    expect(res).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts at the exact window boundary", async () => {
    const env = await signed(makeCmd({ timestamp: FIXED_TS }), kp.secretKey);
    const res = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS + MAX_CLOCK_SKEW_MS });
    expect(res).toEqual({ ok: true });
  });
});

describe("ReplayGuard (correction #4: per-(session,client) monotonic seq)", () => {
  let kp: KeyPair;
  beforeAll(async () => {
    kp = await generateKeyPair();
  });

  it("rejects a REPLAYED message (same seq twice)", async () => {
    const guard = new ReplayGuard();
    const env = await signed(makeCmd({ seq: 5 }), kp.secretKey);
    const first = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS, replayGuard: guard });
    const second = await verifyEnvelope(env, kp.publicKey, { now: FIXED_TS, replayGuard: guard });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects an out-of-order older seq but accepts a newer one", async () => {
    const guard = new ReplayGuard();
    const e5 = await signed(makeCmd({ seq: 5 }), kp.secretKey);
    const e4 = await signed(makeCmd({ seq: 4 }), kp.secretKey);
    const e6 = await signed(makeCmd({ seq: 6 }), kp.secretKey);
    expect(await verifyEnvelope(e5, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({ ok: true });
    expect(await verifyEnvelope(e4, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(await verifyEnvelope(e6, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({ ok: true });
  });

  it("tracks seq independently per (session, client)", async () => {
    const guard = new ReplayGuard();
    const aSeq5 = await signed(makeCmd({ seq: 5, clientInstanceId: "A" }), kp.secretKey);
    const bSeq1 = await signed(makeCmd({ seq: 1, clientInstanceId: "B" }), kp.secretKey);
    // client B's low seq must NOT be blocked by client A's high seq.
    expect(await verifyEnvelope(aSeq5, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({ ok: true });
    expect(await verifyEnvelope(bSeq1, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({ ok: true });
  });

  it("is NOT poisoned by a forged high-seq message (guard advances only after valid signature)", async () => {
    const guard = new ReplayGuard();
    const rogue = await generateKeyPair();
    // Attacker forges seq=100 with a bad signature.
    const forged = await signed(makeCmd({ seq: 100 }), rogue.secretKey);
    expect(await verifyEnvelope(forged, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    // A legitimate seq=10 must still be accepted (the forged 100 never advanced the guard).
    const legit = await signed(makeCmd({ seq: 10 }), kp.secretKey);
    expect(await verifyEnvelope(legit, kp.publicKey, { now: FIXED_TS, replayGuard: guard })).toEqual({ ok: true });
  });
});
