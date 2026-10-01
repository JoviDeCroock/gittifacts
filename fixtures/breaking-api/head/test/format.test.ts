import { describe, expect, it } from "vitest";
import { type FormatOptions, formatMoney, money, parseMoney } from "../src/index.js";

const CODE: FormatOptions = { style: "code" };
const SYMBOL: FormatOptions = { style: "symbol" };

describe("formatMoney", () => {
  it("formats two-decimal currencies", () => {
    expect(formatMoney(money(123456, "EUR"), CODE)).toBe("1234.56 EUR");
  });

  it("pads the minor units", () => {
    expect(formatMoney(money(5, "USD"), CODE)).toBe("0.05 USD");
    expect(formatMoney(money(1230, "USD"), CODE)).toBe("12.30 USD");
  });

  it("puts a minus sign in front of negative amounts", () => {
    expect(formatMoney(money(-1230, "GBP"), CODE)).toBe("-12.30 GBP");
  });

  it("formats zero-decimal currencies without a decimal point", () => {
    expect(formatMoney(money(980, "JPY"), CODE)).toBe("980 JPY");
    expect(formatMoney(money(-7, "JPY"), CODE)).toBe("-7 JPY");
  });
});

describe("formatMoney with style: symbol", () => {
  it("puts the currency symbol in front of the amount", () => {
    expect(formatMoney(money(123456, "EUR"), SYMBOL)).toBe("€1234.56");
    expect(formatMoney(money(5, "USD"), SYMBOL)).toBe("$0.05");
    expect(formatMoney(money(980, "JPY"), SYMBOL)).toBe("¥980");
  });

  it("puts the minus sign before the symbol", () => {
    expect(formatMoney(money(-1230, "GBP"), SYMBOL)).toBe("-£12.30");
  });
});

describe("parseMoney", () => {
  it("parses what formatMoney produces", () => {
    for (const value of [money(123456, "EUR"), money(-5, "USD"), money(0, "GBP"), money(980, "JPY")]) {
      expect(parseMoney(formatMoney(value, CODE))).toEqual(value);
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
