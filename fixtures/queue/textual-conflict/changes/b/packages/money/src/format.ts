import { roundCents } from "./round.js";

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** Format integer cents as "€12.30" (a known currency's symbol) or "12.30 CHF". */
export function formatCents(cents: number, currency = "EUR"): string {
  const whole = roundCents(cents / 100);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const symbol = SYMBOLS[currency];
  return symbol === undefined ? `${sign}${major}.${minor} ${currency}` : `${sign}${symbol}${major}.${minor}`;
}
