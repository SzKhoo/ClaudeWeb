import { describe, it, expect } from "vitest";
import { ulid } from "ulid";

describe("ulid dep", () => {
  it("produces 26-char strings that sort by time", async () => {
    const a = ulid();
    await new Promise((r) => setTimeout(r, 2));
    const b = ulid();
    expect(a.length).toBe(26);
    expect(a < b).toBe(true);
  });
});
