export type RoundingMode = "half-away" | "down";

/**
 * Round an amount in major units (e.g. 12.345 EUR) to integer cents: half away from zero by
 * default, or towards zero with `"down"`.
 */
export function roundCents(amount: number, mode: RoundingMode = "half-away"): number {
  if (!Number.isFinite(amount)) throw new RangeError(`not a finite amount: ${amount}`);
  const cents = Math.abs(amount) * 100;
  const rounded = mode === "down" ? Math.floor(cents + 1e-9) : Math.floor(cents + 0.5 + 1e-9);
  return amount < 0 ? -rounded : rounded;
}
