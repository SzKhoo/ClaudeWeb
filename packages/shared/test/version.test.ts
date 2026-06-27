import { describe, it, expect } from "vitest";
import {
  compareSemVer,
  isCompatible,
  negotiateVersion,
  negotiateCapabilities,
  parseSemVer,
} from "../src/protocol/version.js";

describe("semver (correction #1: numeric, not string, comparison)", () => {
  it("compares numerically, not lexically", () => {
    // The bug: "1.10.0" >= "1.9.0" is FALSE as strings. Numerically it's true.
    expect(compareSemVer("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemVer("1.9.0", "1.10.0")).toBe(-1);
    expect(compareSemVer("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemVer("1.2.3", "1.2.3")).toBe(0);
  });

  it("parses and ignores prerelease/build suffixes for comparison", () => {
    expect(parseSemVer("1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer("1.2.3+build9")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("throws on malformed versions", () => {
    expect(() => parseSemVer("1.2")).toThrow();
    expect(() => parseSemVer("x.y.z")).toThrow();
  });

  it("isCompatible: same major and not older than local min", () => {
    expect(isCompatible("1.10.0", "1.0.0", "1.5.0")).toBe(true); // newer minor, same major, >= min
    expect(isCompatible("1.0.0", "1.0.0", "1.5.0")).toBe(true);
    expect(isCompatible("0.9.0", "1.0.0", "1.5.0")).toBe(false); // older than min
    expect(isCompatible("2.0.0", "1.0.0", "1.5.0")).toBe(false); // different major
    expect(isCompatible("garbage", "1.0.0", "1.5.0")).toBe(false);
  });
});

describe("negotiation", () => {
  it("negotiates the lower of the two maxima", () => {
    expect(negotiateVersion("1.5.0", "1.3.0")).toBe("1.3.0");
    expect(negotiateVersion("1.3.0", "1.5.0")).toBe("1.3.0");
    expect(negotiateVersion("1.5.0", "1.5.0")).toBe("1.5.0");
  });

  it("intersects capabilities with the understood set, tolerating unknown remote caps", () => {
    const understood = ["stream", "tool-approval", "interrupt"] as const;
    const remote = ["stream", "interrupt", "some-future-cap"];
    expect(negotiateCapabilities(remote, understood)).toEqual(["stream", "interrupt"]);
  });
});
