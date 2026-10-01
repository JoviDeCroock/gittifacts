import { max, mean, sum } from "./math.js";

export function total(values: number[]): number {
  return sum(values);
}

export function average(values: number[]): number {
  return mean(values);
}

export function peak(values: number[]): number {
  return max(values);
}
