/** Clamp integer cents into [min, max]. */
export function clampCents(cents: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`empty range [${min}, ${max}]`);
  return Math.min(max, Math.max(min, cents));
}
