import { roundCents } from "./round.js";

/** Format integer cents as "12.30 EUR"; negative amounts in accounting style, "(2.50) EUR". */
export function formatCents(cents: number, currency = "EUR"): string {
  const whole = roundCents(cents / 100);
  const abs = Math.abs(whole);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const amount = `${major}.${minor}`;
  return whole < 0 ? `(${amount}) ${currency}` : `${amount} ${currency}`;
}
