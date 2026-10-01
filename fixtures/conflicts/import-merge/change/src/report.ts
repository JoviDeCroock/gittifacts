import { max, sum } from "./math.js";

export function total(values: number[]): number {
  return sum(values);
}

export function peak(values: number[]): number {
  return max(values);
}
