// Internal helpers shared by the money modules. Not part of the public API:
// nothing here is re-exported from src/index.ts.
import type { CurrencyCode, Money } from "../money.js";

/** Minor-unit digits per currency (the ISO 4217 exponent). */
const MINOR_DIGITS: Readonly<Record<CurrencyCode, number>> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
};

/** Narrows an untrusted string to a supported currency code, or throws. */
export function requireCurrency(code: string): CurrencyCode {
  if (!Object.hasOwn(MINOR_DIGITS, code)) {
    throw new RangeError(`unsupported currency "${code}"`);
  }
  return code as CurrencyCode;
}

/** Digits after the decimal point for a currency: 2 for EUR, 0 for JPY. */
export function minorDigits(currency: CurrencyCode): number {
  return MINOR_DIGITS[currency];
}

/** Throws when two amounts are in different currencies. */
export function assertSameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`${operation}: currency mismatch (${a.currency} vs ${b.currency})`);
  }
}
