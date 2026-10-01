import { describe, expect, it } from "vitest";
import { clampCents } from "../src/clamp.js";

describe("clampCents", () => {
  it("clamps into the range", () => {
    expect(clampCents(-5, 0, 100)).toBe(0);
    expect(clampCents(50, 0, 100)).toBe(50);
    expect(clampCents(500, 0, 100)).toBe(100);
  });

  it("rejects an empty range", () => {
    expect(() => clampCents(1, 2, 1)).toThrow(RangeError);
  });
});
