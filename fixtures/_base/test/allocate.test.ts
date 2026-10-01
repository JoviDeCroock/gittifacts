import { describe, expect, it } from "vitest";
import { type Money, allocate, money } from "../src/index.js";

const amounts = (shares: Money[]) => shares.map((share) => share.amount);

describe("allocate", () => {
  it("splits an evenly divisible amount into equal shares", () => {
    expect(allocate(money(100, "EUR"), [1, 1])).toEqual([money(50, "EUR"), money(50, "EUR")]);
  });

  it("splits proportionally to the ratios", () => {
    expect(amounts(allocate(money(1000, "USD"), [70, 20, 10]))).toEqual([700, 200, 100]);
  });

  it("keeps the currency of the total", () => {
    for (const share of allocate(money(600, "GBP"), [1, 2])) {
      expect(share.currency).toBe("GBP");
    }
  });

  it("supports zero-decimal currencies", () => {
    expect(amounts(allocate(money(9, "JPY"), [1, 2]))).toEqual([3, 6]);
  });

  it("gives nothing to a zero ratio", () => {
    expect(amounts(allocate(money(500, "EUR"), [0, 1]))).toEqual([0, 500]);
  });

  it("returns the whole amount for a single ratio", () => {
    expect(allocate(money(1234, "USD"), [3])).toEqual([money(1234, "USD")]);
  });

  it("rejects an empty ratio list", () => {
    expect(() => allocate(money(100, "EUR"), [])).toThrow("at least one ratio is required");
  });

  it("rejects negative or non-finite ratios", () => {
    expect(() => allocate(money(100, "EUR"), [1, -1])).toThrow(RangeError);
    expect(() => allocate(money(100, "EUR"), [1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => allocate(money(100, "EUR"), [Number.NaN])).toThrow(RangeError);
  });

  it("rejects ratios that are all zero", () => {
    expect(() => allocate(money(100, "EUR"), [0, 0])).toThrow("at least one ratio must be positive");
  });
});
