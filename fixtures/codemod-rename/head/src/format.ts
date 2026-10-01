import { minorDigits, toCurrencyCode } from "./internal/currency.js";
import { type Money, money } from "./money.js";

/**
 * Formats money as a plain decimal followed by its ISO code: `-1234.50 EUR`, `980 JPY`.
 * Deterministic and locale-independent, so it is safe for logs, CSV exports and tests.
 */
export function formatMoney(value: Money): string {
  const digits = minorDigits(value.currency);
  const sign = value.amount < 0 ? "-" : "";
  const absolute = Math.abs(value.amount);
  if (digits === 0) {
    return `${sign}${absolute} ${value.currency}`;
  }
  const scale = 10 ** digits;
  const whole = Math.floor(absolute / scale);
  const fraction = String(absolute % scale).padStart(digits, "0");
  return `${sign}${whole}.${fraction} ${value.currency}`;
}

const MONEY_PATTERN = /^(-?)(\d+)(?:\.(\d+))? ([A-Z]{3})$/;

/** Parses the output of {@link formatMoney} back into Money. Throws on anything else. */
export function parseMoney(input: string): Money {
  const match = MONEY_PATTERN.exec(input.trim());
  if (match === null) {
    throw new SyntaxError(`parseMoney: expected "<amount> <CODE>", got "${input}"`);
  }
  const [, minus = "", whole = "", fraction = "", code = ""] = match;
  const currency = toCurrencyCode(code);
  const digits = minorDigits(currency);
  if (fraction.length > digits) {
    throw new RangeError(`parseMoney: ${currency} has ${digits} decimal places, got "${fraction}"`);
  }
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  return money(minus === "-" ? -minor : minor, currency);
}
