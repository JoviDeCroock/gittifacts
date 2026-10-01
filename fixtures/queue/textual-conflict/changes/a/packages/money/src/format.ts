import { roundCents } from "./round.js";

/** Format integer cents as "1,234.50 EUR" (thousands grouped with commas). */
export function formatCents(cents: number, currency = "EUR"): string {
  const whole = roundCents(cents / 100);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${minor} ${currency}`;
}
