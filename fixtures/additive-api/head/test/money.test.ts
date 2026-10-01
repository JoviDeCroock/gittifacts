import { describe, expect, it } from "vitest";
import { type CurrencyCode, add, money, multiply, subtract } from "../src/index.js";

describe("money", () => {
  it("stores integer minor units and the currency", () => {
    expect(money(1999, "EUR")).toEqual({ amount: 1999, currency: "EUR" });
  });

  it("accepts zero and negative amounts", () => {
    expect(money(0, "USD").amount).toBe(0);
    expect(money(-250, "GBP").amount).toBe(-250);
  });

  it("rejects fractional amounts", () => {
    expect(() => money(19.99, "EUR")).toThrow(RangeError);
    expect(() => money(19.99, "EUR")).toThrow(/integer number of minor units/);
  });

  it("rejects amounts outside the safe integer range", () => {
    expect(() => money(2 ** 53, "USD")).toThrow(RangeError);
    expect(() => money(Number.NaN, "USD")).toThrow(RangeError);
  });

  it("rejects unsupported currencies", () => {
    expect(() => money(100, "XYZ" as CurrencyCode)).toThrow('unsupported currency "XYZ"');
  });

  it("does not mistake inherited object keys for currencies", () => {
    expect(() => money(1, "toString" as CurrencyCode)).toThrow(RangeError);
  });
});

describe("add", () => {
  it("adds amounts in the same currency", () => {
    expect(add(money(150, "EUR"), money(275, "EUR"))).toEqual(money(425, "EUR"));
  });

  it("refuses to mix currencies", () => {
    expect(() => add(money(1, "EUR"), money(1, "USD"))).toThrow(TypeError);
    expect(() => add(money(1, "EUR"), money(1, "USD"))).toThrow(
      "add: currency mismatch (EUR vs USD)",
    );
  });
});

describe("subtract", () => {
  it("subtracts amounts in the same currency", () => {
    expect(subtract(money(1000, "JPY"), money(1, "JPY"))).toEqual(money(999, "JPY"));
  });

  it("may produce a negative amount", () => {
    expect(subtract(money(100, "EUR"), money(250, "EUR"))).toEqual(money(-150, "EUR"));
  });

  it("refuses to mix currencies", () => {
    expect(() => subtract(money(5, "GBP"), money(5, "JPY"))).toThrow(
      "subtract: currency mismatch (GBP vs JPY)",
    );
  });
});

describe("multiply", () => {
  it("scales by a whole factor", () => {
    expect(multiply(money(1250, "EUR"), 3)).toEqual(money(3750, "EUR"));
  });

  it("rounds a fractional result to the nearest minor unit", () => {
    expect(multiply(money(1999, "USD"), 1.21)).toEqual(money(2419, "USD"));
    expect(multiply(money(1000, "USD"), 0.333)).toEqual(money(333, "USD"));
  });

  it("rounds halves away from zero", () => {
    expect(multiply(money(5, "EUR"), 0.5)).toEqual(money(3, "EUR"));
    expect(multiply(money(-5, "EUR"), 0.5)).toEqual(money(-3, "EUR"));
    expect(multiply(money(333, "JPY"), 1.5)).toEqual(money(500, "JPY"));
  });

  it("returns a positive zero rather than negative zero", () => {
    expect(Object.is(multiply(money(-1, "GBP"), 0.25).amount, 0)).toBe(true);
    expect(Object.is(multiply(money(-4, "GBP"), 0).amount, 0)).toBe(true);
  });

  it("keeps the currency", () => {
    expect(multiply(money(100, "GBP"), 2).currency).toBe("GBP");
  });

  it("rejects non-finite factors", () => {
    expect(() => multiply(money(100, "EUR"), Number.NaN)).toThrow(RangeError);
    expect(() => multiply(money(100, "EUR"), Number.POSITIVE_INFINITY)).toThrow(
      "factor must be a finite number",
    );
  });
});
