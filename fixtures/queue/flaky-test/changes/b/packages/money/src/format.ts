import { roundCents } from "./round.js";

/** Format integer cents as "12.30 EUR" (the currency code is upper-cased). */
export function formatCents(cents: number, currency = "EUR"): string {
  const whole = roundCents(cents / 100);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${major}.${minor} ${currency.toUpperCase()}`;
}
