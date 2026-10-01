/** The merged module graph: `from` depends on `to`. */
import type { Edge } from "./types.js";

export class ModuleGraph {
  private readonly deps = new Map<string, Set<string>>();
  private readonly rdeps = new Map<string, Set<string>>();
  private count = 0;

  constructor(edges: Iterable<Edge> = []) {
    for (const e of edges) this.add(e.from, e.to);
  }

  add(from: string, to: string): void {
    if (from === to) return;
    let out = this.deps.get(from);
    if (out === undefined) {
      out = new Set();
      this.deps.set(from, out);
    }
    if (out.has(to)) return;
    out.add(to);
    let inc = this.rdeps.get(to);
    if (inc === undefined) {
      inc = new Set();
      this.rdeps.set(to, inc);
    }
    inc.add(from);
    this.count++;
  }

  get edgeCount(): number {
    return this.count;
  }

  dependenciesOf(path: string): ReadonlySet<string> {
    return this.deps.get(path) ?? EMPTY;
  }

  dependentsOf(path: string): ReadonlySet<string> {
    return this.rdeps.get(path) ?? EMPTY;
  }

  /** Every file that transitively depends on a seed, plus the seeds. */
  reverseClosure(seeds: Iterable<string>): Set<string> {
    return walk(seeds, (p) => this.rdeps.get(p));
  }

  /** Every file a seed transitively depends on, plus the seeds. */
  forwardClosure(seeds: Iterable<string>): Set<string> {
    return walk(seeds, (p) => this.deps.get(p));
  }
}

const EMPTY: ReadonlySet<string> = new Set();

function walk(
  seeds: Iterable<string>,
  next: (path: string) => ReadonlySet<string> | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const s of seeds) {
    if (!seen.has(s)) {
      seen.add(s);
      stack.push(s);
    }
  }
  while (stack.length > 0) {
    const p = stack.pop() as string;
    const out = next(p);
    if (out === undefined) continue;
    for (const q of out) {
      if (!seen.has(q)) {
        seen.add(q);
        stack.push(q);
      }
    }
  }
  return seen;
}
