import { describe, it, expect } from "vitest";
import { canonicalize, signableView, toCanonicalBytes } from "../src/protocol/canonical.js";
import { newEnvelope } from "../src/protocol/envelope.js";
import type { CmdUserMessage } from "../src/protocol/messages.js";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("canonicalize", () => {
  it("is independent of object key insertion order", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts integer-like keys by code unit, NOT numerically (the JSON.stringify trap)", () => {
    // V8 would iterate these as 1,2,10; canonicalize must sort by string code unit: "1","10","2".
    const a = { "10": "x", "2": "y", "1": "z" };
    const b = { "1": "z", "2": "y", "10": "x" };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"1":"z","10":"x","2":"y"}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined object values but keeps null", () => {
    expect(canonicalize({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it("escapes strings deterministically", () => {
    expect(canonicalize('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
  });

  it("normalizes -0 to 0 and rejects non-finite numbers", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("handles deep nesting deterministically", () => {
    const a = { z: { b: [1, { y: 2, x: 3 }], a: 1 } };
    const b = { z: { a: 1, b: [1, { x: 3, y: 2 }] } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

describe("signableView / toCanonicalBytes", () => {
  const base = () =>
    newEnvelope<CmdUserMessage>({
      protocolVersion: "1.0.0",
      deviceId: "dev-1",
      sessionId: "sess-1",
      clientInstanceId: "client-A",
      seq: 7,
      timestamp: 1_700_000_000_000,
      payload: { type: "user_message", text: "hi" },
    });

  it("excludes the sig field so signed/unsigned envelopes share canonical bytes", () => {
    const unsigned = base();
    const withSig = { ...base(), sig: "ZZZZ" };
    expect(decode(toCanonicalBytes(unsigned))).toBe(decode(toCanonicalBytes(withSig)));
  });

  it("includes deviceId and clientInstanceId (routing-security fields)", () => {
    const s = canonicalize(signableView(base()));
    expect(s).toContain('"d":"dev-1"');
    expect(s).toContain('"c":"client-A"');
    expect(s).toContain('"s":"sess-1"');
    expect(s).toContain('"n":7'); // seq = nonce
    expect(s).toContain('"t":1700000000000'); // timestamp = freshness
  });

  it("changes bytes when any covered field changes", () => {
    const ref = decode(toCanonicalBytes(base()));
    const diffClient = decode(toCanonicalBytes({ ...base(), clientInstanceId: "client-B" }));
    const diffDevice = decode(toCanonicalBytes({ ...base(), deviceId: "dev-2" }));
    const diffSeq = decode(toCanonicalBytes({ ...base(), seq: 8 }));
    expect(diffClient).not.toBe(ref);
    expect(diffDevice).not.toBe(ref);
    expect(diffSeq).not.toBe(ref);
  });
});
