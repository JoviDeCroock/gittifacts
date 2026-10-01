/**
 * Conflict graph (§4.1/4.2). Two Changes conflict when their affected sets share a file, a module
 * of the reverse-dependency closure, or a test target. An incomplete (unknown) affected set, or
 * one whose tests fell back to "all tests", conflicts with everything: never default to parallel.
 */
import { ALL_TESTS, type AffectedSet } from "./schema.js";

/** True when the set must be treated as conflicting with every other set. */
export function isWildcard(a: AffectedSet | null): boolean {
  return a === null || !a.complete || a.testTargets.includes(ALL_TESTS);
}

/** Index keys of a (non-wildcard) affected set. */
export function conflictKeys(a: AffectedSet): string[] {
  const keys: string[] = [];
  for (const f of a.files) keys.push(`f:${f}`);
  for (const m of a.modules) keys.push(`m:${m}`);
  for (const t of a.testTargets) keys.push(`t:${t}`);
  return keys;
}

export function conflicts(a: AffectedSet | null, b: AffectedSet | null): boolean {
  if (isWildcard(a) || isWildcard(b)) return true;
  if (a === null || b === null) return true;
  const keys = new Set(conflictKeys(a));
  for (const k of conflictKeys(b)) if (keys.has(k)) return true;
  return false;
}

/** Union of affected sets (incomplete if any member is). */
export function unionAffected(sets: (AffectedSet | null)[]): AffectedSet {
  const files = new Set<string>();
  const modules = new Set<string>();
  const tests = new Set<string>();
  const deploys = new Set<string>();
  let complete = true;
  let publicApi = false;
  for (const s of sets) {
    if (s === null) {
      complete = false;
      tests.add(ALL_TESTS);
      continue;
    }
    for (const f of s.files) files.add(f);
    for (const m of s.modules) modules.add(m);
    for (const t of s.testTargets) tests.add(t);
    for (const d of s.deploysTo) deploys.add(d);
    complete &&= s.complete;
    publicApi ||= s.publicApi;
  }
  return {
    files: [...files],
    modules: [...modules],
    testTargets: [...tests],
    publicApi,
    deploysTo: [...deploys],
    complete,
  };
}

/**
 * A set of labelled groups (tracks, blocked units) indexed by affected-set keys, answering "which
 * groups does this affected set conflict with?" in time proportional to its keys.
 */
export class ConflictIndex {
  private readonly byKey = new Map<string, Set<string>>();
  private readonly wild = new Set<string>();
  private readonly labels = new Set<string>();

  add(label: string, a: AffectedSet | null): void {
    this.labels.add(label);
    if (isWildcard(a) || a === null) {
      this.wild.add(label);
      return;
    }
    for (const k of conflictKeys(a)) {
      let set = this.byKey.get(k);
      if (set === undefined) {
        set = new Set();
        this.byKey.set(k, set);
      }
      set.add(label);
    }
  }

  has(label: string): boolean {
    return this.labels.has(label);
  }

  /** Labels conflicting with `a`. A wildcard conflicts with every label. */
  query(a: AffectedSet | null): Set<string> {
    if (isWildcard(a) || a === null) return new Set(this.labels);
    const out = new Set(this.wild);
    for (const k of conflictKeys(a)) {
      const set = this.byKey.get(k);
      if (set !== undefined) for (const l of set) out.add(l);
    }
    return out;
  }

  get size(): number {
    return this.labels.size;
  }
}

/** Connected components of the conflict graph over `items` (union-find over shared keys). */
export function components<T>(items: T[], affected: (t: T) => AffectedSet | null): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    let x = i;
    while (parent[x] !== r) {
      const next = parent[x] ?? r;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const owner = new Map<string, number>();
  let wildcard: number | null = null;
  items.forEach((item, i) => {
    const a = affected(item);
    if (isWildcard(a) || a === null) {
      if (wildcard === null) wildcard = i;
      else union(wildcard, i);
      return;
    }
    for (const k of conflictKeys(a)) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, i);
      else union(o, i);
    }
  });
  if (wildcard !== null) for (let i = 0; i < items.length; i++) union(wildcard, i);
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(item);
    groups.set(r, g);
  });
  return [...groups.values()];
}
