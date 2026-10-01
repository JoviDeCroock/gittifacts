export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function div(a: number, b: number): number {
  if (b === 0) throw new RangeError("division by zero");
  return a / b;
}
