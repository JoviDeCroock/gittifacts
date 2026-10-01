import { describe, expect, it } from "vitest";
import { type CurrencyCode, add, money, subtract } from "../src/index.js";

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
