/**
 * Conflict graph (§4.1/4.2), with exactly the semantics of `@app/affected`'s `conflictBetween`:
 * two Changes conflict when either set is incomplete, either touched config (`*config*` in
 * modules), or they share a file, a module, or a test target — where `*` (all tests) meets any
 * non-empty test set. An unknown set (null: not computed) conflicts with everything. Never default
 * to parallel.
 */
import { ALL_TESTS, type AffectedSet, CONFIG_SENTINEL } from "./schema.js";

/** True when the set must be treated as conflicting with every other set. */
export function conflictsWithEverything(a: AffectedSet | null): boolean {
  return a === null || !a.complete || a.modules.includes(CONFIG_SENTINEL);
}

/** True when a revalidation of this Change must run every test. */
export function needsAllTests(a: AffectedSet | null): boolean {
  return a === null || conflictsWithEverything(a) || a.testTargets.includes(ALL_TESTS);
}

function hasTests(a: AffectedSet): boolean {
  return a.testTargets.length > 0;
}

function allTests(a: AffectedSet): boolean {
  return a.testTargets.includes(ALL_TESTS);
}

/** Index keys of a set that doesn't conflict with everything (sentinels excluded). */
export function conflictKeys(a: AffectedSet): string[] {
  const keys: string[] = [];
  for (const f of a.files) keys.push(`f:${f}`);
  for (const m of a.modules) if (m !== CONFIG_SENTINEL) keys.push(`m:${m}`);
  for (const t of a.testTargets) if (t !== ALL_TESTS) keys.push(`t:${t}`);
  return keys;
}

export function conflicts(a: AffectedSet | null, b: AffectedSet | null): boolean {
  if (a === null || b === null || conflictsWithEverything(a) || conflictsWithEverything(b)) return true;
  if ((allTests(a) && hasTests(b)) || (allTests(b) && hasTests(a))) return true;
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
    analyzers: [],
  };
}

/**
 * Labelled groups (tracks, blocked units) indexed by affected-set keys, answering "which groups
 * does this set conflict with?" in time proportional to its keys.
 */
export class ConflictIndex {
  private readonly byKey = new Map<string, Set<string>>();
  private readonly wild = new Set<string>();
  private readonly withTests = new Set<string>();
  private readonly withAllTests = new Set<string>();
  private readonly labels = new Set<string>();

  add(label: string, a: AffectedSet | null): void {
    this.labels.add(label);
    if (a === null || conflictsWithEverything(a)) {
      this.wild.add(label);
      return;
    }
    if (hasTests(a)) this.withTests.add(label);
    if (allTests(a)) this.withAllTests.add(label);
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

  /** Labels conflicting with `a`. */
  query(a: AffectedSet | null): Set<string> {
    if (a === null || conflictsWithEverything(a)) return new Set(this.labels);
    const out = new Set(this.wild);
    if (hasTests(a)) for (const l of this.withAllTests) out.add(l);
    if (allTests(a)) for (const l of this.withTests) out.add(l);
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
  const wild: number[] = [];
  const testers: number[] = [];
  const allers: number[] = [];
  items.forEach((item, i) => {
    const a = affected(item);
    if (a === null || conflictsWithEverything(a)) {
      wild.push(i);
      return;
    }
    if (hasTests(a)) testers.push(i);
    if (allTests(a)) allers.push(i);
    for (const k of conflictKeys(a)) {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, i);
      else union(o, i);
    }
  });
  for (const w of wild) for (let i = 0; i < items.length; i++) union(w, i);
  for (const a of allers) for (const t of testers) union(a, t);
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(item);
    groups.set(r, g);
  });
  return [...groups.values()];
}
