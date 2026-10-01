/**
 * Pairwise conflict between two AffectedSets (merge queue §4.1): they conflict when either is
 * incomplete, either touched config, or they share files, modules or test targets. Public API
 * and deploy targets are not conflict criteria (deploy trains coordinate Workers separately).
 */
import { type AffectedSet, ALL_TESTS, CONFIG_SENTINEL } from "./types.js";

export type ConflictReason = "incomplete" | "config" | "files" | "modules" | "tests";

export interface Conflict {
  reasons: ConflictReason[];
  shared: { files: string[]; modules: string[]; tests: string[] };
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

/** Shared test targets; `*` (all tests) meets any non-empty set. */
function sharedTests(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  if (a.includes(ALL_TESTS)) return b.includes(ALL_TESTS) ? [ALL_TESTS] : [...b];
  if (b.includes(ALL_TESTS)) return [...a];
  return intersect(a, b);
}

/** Why two changes conflict, or null when they are independent. */
export function conflictBetween(a: AffectedSet, b: AffectedSet): Conflict | null {
  const reasons: ConflictReason[] = [];
  if (!a.complete || !b.complete) reasons.push("incomplete");
  if (a.modules.includes(CONFIG_SENTINEL) || b.modules.includes(CONFIG_SENTINEL))
    reasons.push("config");
  const files = intersect(a.files, b.files);
  if (files.length > 0) reasons.push("files");
  const modules = intersect(
    a.modules.filter((m) => m !== CONFIG_SENTINEL),
    b.modules.filter((m) => m !== CONFIG_SENTINEL),
  );
  if (modules.length > 0) reasons.push("modules");
  const tests = sharedTests(a.testTargets, b.testTargets);
  if (tests.length > 0) reasons.push("tests");
  return reasons.length === 0 ? null : { reasons, shared: { files, modules, tests } };
}

/** Connected components of the conflict graph over `sets` (ids in input order). */
export function conflictComponents(sets: ReadonlyMap<string, AffectedSet>): string[][] {
  const ids = [...sets.keys()];
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    parent.set(x, r);
    return r;
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = sets.get(ids[i] ?? "");
      const b = sets.get(ids[j] ?? "");
      if (a !== undefined && b !== undefined && conflictBetween(a, b) !== null)
        parent.set(find(ids[i] ?? ""), find(ids[j] ?? ""));
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const g = groups.get(r) ?? [];
    g.push(id);
    groups.set(r, g);
  }
  return [...groups.values()];
}
