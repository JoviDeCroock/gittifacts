import { type Money, money } from "./money.js";

/**
 * Splits `total` into shares proportional to `ratios` without creating or losing a
 * single minor unit: the shares always add up to exactly `total`.
 *
 * Every share is first rounded down; the minor units left over are then handed out
 * one at a time, starting with the first share.
 *
 * @example allocate(money(100, "EUR"), [1, 1, 1]) // 34, 33 and 33 cents
 */
export function allocate(total: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) {
    throw new RangeError("allocate: at least one ratio is required");
  }
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio < 0)) {
    throw new RangeError("allocate: ratios must be finite and non-negative");
  }
  const ratioSum = ratios.reduce((sum, ratio) => sum + ratio, 0);
  if (ratioSum === 0) {
    throw new RangeError("allocate: at least one ratio must be positive");
  }
  const shares = ratios.map((ratio) => Math.floor((total.amount * ratio) / ratioSum));
  const leftover = total.amount - shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share, index) =>
    money(share + (index < leftover ? 1 : 0), total.currency),
  );
}
