export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}
