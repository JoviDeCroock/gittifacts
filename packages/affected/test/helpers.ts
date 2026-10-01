import type { ChangeStatus, ComputeInput, FileChange, RepoTree } from "../src/index.js";
import { computeAffectedSet } from "../src/index.js";

export type Files = Record<string, string>;

export function tree(files: Files): RepoTree {
  return {
    files: Object.keys(files).sort(),
    read: (p) => (Object.hasOwn(files, p) ? (files[p] ?? null) : null),
  };
}

/** Changes between two in-memory trees (no rename detection unless given). */
export function diff(base: Files, head: Files, renames: Record<string, string> = {}): FileChange[] {
  const out: FileChange[] = [];
  const renamedFrom = new Set(Object.values(renames));
  for (const [to, from] of Object.entries(renames))
    out.push({ status: "renamed" as ChangeStatus, path: to, oldPath: from });
  for (const p of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (Object.hasOwn(renames, p) || renamedFrom.has(p)) continue;
    if (!Object.hasOwn(base, p)) out.push({ status: "added", path: p });
    else if (!Object.hasOwn(head, p)) out.push({ status: "deleted", path: p });
    else if (base[p] !== head[p]) out.push({ status: "modified", path: p });
  }
  return out;
}

/** Affected set of applying `edits` (null deletes) on top of `base`. */
export function affected(
  base: Files,
  edits: Record<string, string | null>,
  extra: Partial<ComputeInput> = {},
) {
  const head: Files = { ...base };
  for (const [p, c] of Object.entries(edits)) {
    if (c === null) delete head[p];
    else head[p] = c;
  }
  return computeAffectedSet({
    head: tree(head),
    base: tree(base),
    changes: diff(base, head),
    ...extra,
  });
}
