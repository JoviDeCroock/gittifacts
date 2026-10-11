/**
 * "Fix PRs touching the same lines within 14 days" (spec §3.7, research §8), on the Artifacts
 * mirror: no GitHub API (no GraphQL blame fan-out). For a merged PR P and a later PR Q merged
 * within the window that shares a file:
 *   1. P's lines: the lines P added, in the file as P left it (`diff(P^, P)`, new side);
 *   2. carried to Q's base through everything that landed in between (`diff(P, Q^)`, line by
 *      line: context moves, deleted lines drop), so direct pushes count too;
 *   3. Q patches P when Q deletes or rewrites one of those lines (`diff(Q^, Q)`, old side).
 * Unknown stays unknown: a diff that fails or is truncated makes P's outcome unknown, never clean.
 */
import type { ChangeDiff, DiffHunk } from "@app/domain";
import type { MergedPr } from "./listing.js";

export interface MirrorDiffs {
  diff(baseSha: string, headSha: string): Promise<ChangeDiff>;
  /** First parent of a commit (null when unknown to the mirror). */
  parent(sha: string): Promise<string | null>;
}

export type PatchOutcome = { by: number; at: string } | "none" | "unknown";

const DAY = 86_400_000;

/** A line of the old side of `hunks` carried to the new side (null: deleted or rewritten). */
export function carryLine(n: number, hunks: readonly DiffHunk[]): number | null {
  let delta = 0;
  for (const h of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    const end = h.oldStart + h.oldLines - 1;
    if (h.oldLines === 0) {
      if (n > h.oldStart) delta += h.newLines; // pure insertion after oldStart
      continue;
    }
    if (n > end) {
      delta += h.newLines - h.oldLines;
      continue;
    }
    if (n < h.oldStart) break;
    const line = h.lines.find((l) => l.oldNo === n);
    return line?.kind === "ctx" ? (line.newNo ?? null) : null;
  }
  return n + delta;
}

/** Old-side lines a diff rewrites or deletes, and insertions strictly between two old lines. */
function touched(hunks: readonly DiffHunk[]): { dels: Set<number>; insertsAfter: Set<number> } {
  const dels = new Set<number>();
  const insertsAfter = new Set<number>();
  for (const h of hunks) {
    let lastOld = h.oldStart - 1;
    for (const l of h.lines) {
      if (l.kind === "del" && l.oldNo !== null) dels.add(l.oldNo);
      if (l.kind === "add") insertsAfter.add(lastOld);
      if (l.oldNo !== null) lastOld = l.oldNo;
    }
  }
  return { dels, insertsAfter };
}

const added = (diff: ChangeDiff, path: string): Set<number> | "truncated" | null => {
  const f = diff.files.find((x) => x.path === path);
  if (f === undefined) return null;
  if (f.truncated) return "truncated";
  return new Set(
    f.hunks.flatMap((h) =>
      h.lines.filter((l) => l.kind === "add" && l.newNo !== null).map((l) => l.newNo as number),
    ),
  );
};

export async function findPatches(
  prs: readonly MergedPr[],
  mirror: MirrorDiffs,
  opts: { days?: number; maxPairs?: number; now?: Date } = {},
): Promise<Map<number, PatchOutcome>> {
  const windowMs = (opts.days ?? 14) * DAY;
  const ordered = [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const own = new Map<string, Promise<ChangeDiff | null>>();
  const diffOf = (key: string, base: string, head: string) => {
    let d = own.get(key);
    if (d === undefined) {
      d = mirror.diff(base, head).catch(() => null);
      own.set(key, d);
    }
    return d;
  };
  const selfDiff = async (p: MergedPr) => {
    const parent = await mirror.parent(p.mergeSha);
    return parent === null ? null : diffOf(`self:${p.number}`, parent, p.mergeSha);
  };
  let pairs = 0;
  const out = new Map<number, PatchOutcome>();
  for (const [i, p] of ordered.entries()) {
    const mine = await selfDiff(p);
    if (mine === null) {
      out.set(p.number, "unknown");
      continue;
    }
    const until = Date.parse(p.mergedAt) + windowMs;
    let outcome: PatchOutcome = (opts.now?.getTime() ?? Date.now()) < until ? "unknown" : "none";
    const paths = new Set(p.files.map((f) => f.path));
    for (const q of ordered.slice(i + 1)) {
      if (Date.parse(q.mergedAt) > until) break;
      const shared = q.files.map((f) => f.path).filter((x) => paths.has(x));
      if (shared.length === 0) continue;
      if (++pairs > (opts.maxPairs ?? 400)) {
        outcome = "unknown";
        break;
      }
      const qBase = await mirror.parent(q.mergeSha);
      const [between, theirs] = await Promise.all([
        qBase === null ? null : diffOf(`b:${p.number}:${q.number}`, p.mergeSha, qBase),
        selfDiff(q),
      ]);
      if (between === null || theirs === null) {
        outcome = "unknown";
        break;
      }
      let hit = false;
      for (const path of shared) {
        const lines = added(mine, path);
        if (lines === "truncated") {
          outcome = "unknown";
          continue;
        }
        if (lines === null) continue;
        const moved = between.files.find((f) => f.path === path)?.hunks ?? [];
        const atBase = new Set(
          [...lines].map((n) => carryLine(n, moved)).filter((n): n is number => n !== null),
        );
        const qFile = theirs.files.find((f) => f.path === path);
        if (qFile === undefined || atBase.size === 0) continue;
        const { dels, insertsAfter } = touched(qFile.hunks);
        if (
          [...dels].some((n) => atBase.has(n)) ||
          [...insertsAfter].some((n) => atBase.has(n) && atBase.has(n + 1))
        )
          hit = true;
      }
      if (hit) {
        outcome = { by: q.number, at: q.mergedAt };
        break;
      }
    }
    out.set(p.number, outcome);
  }
  return out;
}
