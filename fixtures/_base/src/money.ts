import { assertSameCurrency, requireCurrency } from "./internal/currency.js";

/** ISO 4217 codes this library knows how to format and allocate. */
export type CurrencyCode = "EUR" | "USD" | "GBP" | "JPY";

/**
 * An amount of money in integer minor units (cents for EUR/USD/GBP, yen for JPY).
 * All arithmetic stays in integers, so there are no floating-point rounding surprises.
 */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** Creates a Money value. `amount` is in minor units and must be a safe integer. */
export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`money: amount must be an integer number of minor units, got ${amount}`);
  }
  return { amount, currency: requireCurrency(currency) };
}

/** Adds two amounts of the same currency. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "add");
  return money(a.amount + b.amount, a.currency);
}

/** Subtracts `b` from `a`. Both must be in the same currency; the result may be negative. */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtract");
  return money(a.amount - b.amount, a.currency);
}
