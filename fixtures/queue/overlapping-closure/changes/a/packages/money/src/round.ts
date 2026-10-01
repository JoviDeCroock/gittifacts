/**
 * Round an amount in major units (e.g. 12.345 EUR) to integer cents. Ties go to the even cent
 * (banker's rounding), so rounding many amounts does not drift upwards.
 */
export function roundCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new RangeError(`not a finite amount: ${amount}`);
  const cents = Math.abs(amount) * 100;
  const floor = Math.floor(cents + 1e-9);
  const fraction = cents - floor;
  let rounded = floor;
  if (fraction > 0.5 + 1e-9) rounded = floor + 1;
  else if (Math.abs(fraction - 0.5) <= 1e-9) rounded = floor % 2 === 0 ? floor : floor + 1;
  return amount < 0 ? -rounded : rounded;
}
