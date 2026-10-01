import { describe, expect, it } from "vitest";
import { roundCents } from "../src/round.js";

describe("roundCents", () => {
  it("rounds ties to the even cent", () => {
    expect(roundCents(12.345)).toBe(1234);
    expect(roundCents(12.355)).toBe(1236);
    expect(roundCents(-12.345)).toBe(-1234);
    expect(roundCents(12.346)).toBe(1235);
    expect(roundCents(0.004)).toBe(0);
  });

  it("rejects non-finite amounts", () => {
    expect(() => roundCents(Number.NaN)).toThrow(RangeError);
  });
});
