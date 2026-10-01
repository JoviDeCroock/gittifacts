import { describe, expect, it } from "vitest";
import { formatMoney, money, parseMoney } from "../src/index.js";

describe("formatMoney", () => {
  it("formats two-decimal currencies", () => {
    expect(formatMoney(money(123456, "EUR"))).toBe("1234.56 EUR");
  });

  it("pads the minor units", () => {
    expect(formatMoney(money(5, "USD"))).toBe("0.05 USD");
    expect(formatMoney(money(1230, "USD"))).toBe("12.30 USD");
  });

  it("puts a minus sign in front of negative amounts", () => {
    expect(formatMoney(money(-1230, "GBP"))).toBe("-12.30 GBP");
  });

  it("formats zero-decimal currencies without a decimal point", () => {
    expect(formatMoney(money(980, "JPY"))).toBe("980 JPY");
    expect(formatMoney(money(-7, "JPY"))).toBe("-7 JPY");
  });
});

describe("parseMoney", () => {
  it("parses what formatMoney produces", () => {
    for (const value of [money(123456, "EUR"), money(-5, "USD"), money(0, "GBP"), money(980, "JPY")]) {
      expect(parseMoney(formatMoney(value))).toEqual(value);
    }
  });

  it("accepts fewer decimals than the currency allows", () => {
    expect(parseMoney("12.5 EUR")).toEqual(money(1250, "EUR"));
    expect(parseMoney("7 USD")).toEqual(money(700, "USD"));
  });

  it("trims surrounding whitespace", () => {
    expect(parseMoney("  1.00 EUR \n")).toEqual(money(100, "EUR"));
  });

  it("rejects malformed input", () => {
    for (const input of ["", "EUR 12.00", "12,00 EUR", "1.2.3 EUR", "12.00EUR", "12.00 eur"]) {
      expect(() => parseMoney(input)).toThrow(SyntaxError);
    }
  });

  it("rejects more decimals than the currency has", () => {
    expect(() => parseMoney("1.005 EUR")).toThrow("EUR has 2 decimal places");
    expect(() => parseMoney("5.5 JPY")).toThrow("JPY has 0 decimal places");
  });

  it("rejects unsupported currencies", () => {
    expect(() => parseMoney("1.00 XYZ")).toThrow('unsupported currency "XYZ"');
  });
});
