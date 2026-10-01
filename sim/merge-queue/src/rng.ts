/**
 * Deterministic randomness. Two kinds:
 * - `Rng`: a seeded sequential generator (sfc32) for workload generation.
 * - `draw(seed, ...key)`: a keyed hash in [0,1) for outcomes in the world (CI duration of run X,
 *   flake of test T in run X, ...). Keyed draws don't depend on the order the queue asks, so two
 *   configurations of the queue face the same world as far as possible.
 */

export function h32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function draw(seed: number, ...key: (string | number)[]): number {
  return h32(`${seed}\u0000${key.join("\u0000")}`) / 4294967296;
}

/** Normal(0,1) from two uniforms (Box–Muller). */
export function normalFrom(u1: number, u2: number): number {
  const a = Math.max(u1, 1e-12);
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u2);
}

export function lognormal(median: number, sigma: number, u1: number, u2: number): number {
  return median * Math.exp(sigma * normalFrom(u1, u2));
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const s = String(seed);
    this.a = h32(`a${s}`);
    this.b = h32(`b${s}`);
    this.c = h32(`c${s}`);
    this.d = h32(`d${s}`);
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Uniform [0,1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  bool(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    const x = xs[this.int(xs.length)];
    if (x === undefined) throw new Error("pick from empty array");
    return x;
  }

  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }

  lognormal(median: number, sigma: number): number {
    return lognormal(median, sigma, this.next(), this.next());
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
}

/** 40-hex "sha" from a string (deterministic, not cryptographic). */
export function fakeSha(s: string): string {
  let out = "";
  for (let i = 0; i < 5; i++) out += h32(`${i}|${s}`).toString(16).padStart(8, "0");
  return out;
}
