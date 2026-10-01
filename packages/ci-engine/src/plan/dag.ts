/**
 * Graph helpers over pipeline steps. Pure; callers validate the spec first (see `graphIssues`),
 * so unknown references and cycles are programming errors here.
 */
import { stepDependencies } from "./spec.js";

export interface DagNode {
  name: string;
  parent: string | null;
  after: readonly string[];
}

function indexByName<T extends DagNode>(steps: readonly T[]): Map<string, T> {
  return new Map(steps.map((s) => [s.name, s] as const));
}

/**
 * Groups steps into levels: level 0 has no dependencies, level n depends only on levels < n
 * (and on at least one step at level n-1). Order inside a level follows declaration order.
 */
export function levelize<T extends DagNode>(steps: readonly T[]): string[][] {
  const byName = indexByName(steps);
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (name: string): number => {
    const known = level.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) throw new Error(`dependency cycle through "${name}"`);
    const step = byName.get(name);
    if (step === undefined) throw new Error(`unknown step "${name}"`);
    visiting.add(name);
    let d = 0;
    for (const dep of stepDependencies(step)) d = Math.max(d, depth(dep) + 1);
    visiting.delete(name);
    level.set(name, d);
    return d;
  };
  const levels: string[][] = [];
  for (const step of steps) {
    const d = depth(step.name);
    const bucket = levels[d] ?? [];
    bucket.push(step.name);
    levels[d] = bucket;
  }
  return levels;
}

/** Declaration-stable topological order. */
export function topologicalOrder<T extends DagNode>(steps: readonly T[]): string[] {
  return levelize(steps).flat();
}

/** Every step reachable from `name` through dependency edges (not including `name`). */
export function ancestors<T extends DagNode>(steps: readonly T[], name: string): Set<string> {
  const byName = indexByName(steps);
  const out = new Set<string>();
  const stack = [name];
  while (stack.length > 0) {
    const step = byName.get(stack.pop()!);
    if (step === undefined) continue;
    for (const dep of stepDependencies(step)) {
      if (!out.has(dep)) {
        out.add(dep);
        stack.push(dep);
      }
    }
  }
  return out;
}

/** Every step that (transitively) depends on `name` (not including `name`). */
export function dependents<T extends DagNode>(steps: readonly T[], name: string): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of stepDependencies(step)) {
      const list = reverse.get(dep) ?? [];
      list.push(step.name);
      reverse.set(dep, list);
    }
  }
  const out = new Set<string>();
  const stack = [name];
  while (stack.length > 0) {
    for (const child of reverse.get(stack.pop()!) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

/** The snapshot lineage of a step, root first: `[root, ..., parent]`. */
export function parentChain<T extends DagNode>(steps: readonly T[], name: string): T[] {
  const byName = indexByName(steps);
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byName.get(name)?.parent ?? null;
  while (current !== null) {
    if (seen.has(current)) throw new Error(`parent cycle through "${current}"`);
    seen.add(current);
    const step = byName.get(current);
    if (step === undefined) throw new Error(`unknown parent "${current}"`);
    chain.unshift(step);
    current = step.parent;
  }
  return chain;
}

/** Steps whose snapshot some other step starts from. */
export function snapshotSources<T extends DagNode>(steps: readonly T[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps) if (s.parent !== null) out.add(s.parent);
  return out;
}

/**
 * Transitive reduction of each step's `after` list: drops entries already implied by the parent or
 * by another `after` entry, and the parent itself. Keeps declaration order of the survivors.
 */
export function reduceAfter<T extends DagNode>(steps: readonly T[]): Map<string, string[]> {
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const byName = indexByName(steps);
  const closure = (name: string): Set<string> => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) throw new Error(`dependency cycle through "${name}"`);
    visiting.add(name);
    const out = new Set<string>();
    const step = byName.get(name);
    if (step !== undefined) {
      for (const dep of stepDependencies(step)) {
        out.add(dep);
        for (const a of closure(dep)) out.add(a);
      }
    }
    visiting.delete(name);
    memo.set(name, out);
    return out;
  };
  const result = new Map<string, string[]>();
  for (const step of steps) {
    const implied = new Set<string>();
    if (step.parent !== null) {
      implied.add(step.parent);
      for (const a of closure(step.parent)) implied.add(a);
    }
    for (const dep of step.after) for (const a of closure(dep)) implied.add(a);
    result.set(
      step.name,
      step.after.filter((dep, i) => !implied.has(dep) && step.after.indexOf(dep) === i),
    );
  }
  return result;
}
