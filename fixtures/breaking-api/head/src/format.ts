import { minorDigits, requireCurrency } from "./internal/currency.js";
import { type CurrencyCode, type Money, money } from "./money.js";

export interface FormatOptions {
  /**
   * `"code"`: plain decimal followed by the ISO code, `-1234.50 EUR` (parseable).
   * `"symbol"`: currency symbol in front, `-€1234.50`, for display.
   */
  readonly style: "code" | "symbol";
}

const SYMBOLS: Readonly<Record<CurrencyCode, string>> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  JPY: "¥",
};

/**
 * Formats money in the requested style. Both styles are deterministic and
 * locale-independent, so they are safe for logs, CSV exports and tests.
 */
export function formatMoney(value: Money, options: FormatOptions): string {
  const digits = minorDigits(value.currency);
  const sign = value.amount < 0 ? "-" : "";
  const absolute = Math.abs(value.amount);
  const scale = 10 ** digits;
  const number =
    digits === 0
      ? String(absolute)
      : `${Math.floor(absolute / scale)}.${String(absolute % scale).padStart(digits, "0")}`;
  return options.style === "symbol"
    ? `${sign}${SYMBOLS[value.currency]}${number}`
    : `${sign}${number} ${value.currency}`;
}

const MONEY_PATTERN = /^(-?)(\d+)(?:\.(\d+))? ([A-Z]{3})$/;

/** Parses the `"code"` style of {@link formatMoney} back into Money. Throws on anything else. */
export function parseMoney(input: string): Money {
  const match = MONEY_PATTERN.exec(input.trim());
  if (match === null) {
    throw new SyntaxError(`parseMoney: expected "<amount> <CODE>", got "${input}"`);
  }
  const [, minus = "", whole = "", fraction = "", code = ""] = match;
  const currency = requireCurrency(code);
  const digits = minorDigits(currency);
  if (fraction.length > digits) {
    throw new RangeError(`parseMoney: ${currency} has ${digits} decimal places, got "${fraction}"`);
  }
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  return money(minus === "-" ? -minor : minor, currency);
}
