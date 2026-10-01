/**
 * A small line diff: Myers' O(ND) algorithm on the lines between the common prefix and suffix,
 * and unified-diff hunks with context. Pure.
 *
 * Very different inputs (edit distance above `maxEditDistance`) fall back to "replace the middle
 * block", which over-reports changed lines: conservative for size gates, and bounded in memory
 * (the Myers trace is O(D²)).
 */
import type { DiffHunk, DiffLine } from "@app/domain";

export interface Edit {
  kind: "eq" | "del" | "add";
  /** 0-based index into the old lines (null for additions). */
  oldIndex: number | null;
  /** 0-based index into the new lines (null for deletions). */
  newIndex: number | null;
}

export const DEFAULT_MAX_EDIT_DISTANCE = 1000;

const eq = (o: number, n: number): Edit => ({ kind: "eq", oldIndex: o, newIndex: n });
const del = (o: number): Edit => ({ kind: "del", oldIndex: o, newIndex: null });
const add = (n: number): Edit => ({ kind: "add", oldIndex: null, newIndex: n });

/** Edit script turning `a` into `b`, in order. */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  opts: { maxEditDistance?: number } = {},
): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: Edit[] = [];
  for (let i = 0; i < start; i++) out.push(eq(i, i));
  const middle = myers(a, b, start, endA, start, endB, opts.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE);
  if (middle === null) {
    for (let i = start; i < endA; i++) out.push(del(i));
    for (let j = start; j < endB; j++) out.push(add(j));
  } else {
    out.push(...middle);
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) out.push(eq(i, j));
  return out;
}

/** Myers on a[aLo, aHi) × b[bLo, bHi); null when the edit distance exceeds `maxD`. */
function myers(
  a: readonly string[],
  b: readonly string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  maxD: number,
): Edit[] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0 && m === 0) return [];
  const limit = Math.min(n + m, maxD);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  /** trace[d][k + d] = furthest x on diagonal k before round d. */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    const snapshot = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k++) snapshot[k + d] = v[offset + k] ?? 0;
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, aLo, bLo);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number, aLo: number, bLo: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    if (v === undefined) break;
    const at = (k: number) => v[k + d] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push(eq(aLo + x - 1, bLo + y - 1));
      x--;
      y--;
    }
    if (down) {
      edits.push(add(bLo + y - 1));
      y--;
    } else {
      edits.push(del(aLo + x - 1));
      x--;
    }
  }
  while (x > 0 && y > 0) {
    edits.push(eq(aLo + x - 1, bLo + y - 1));
    x--;
    y--;
  }
  return edits.reverse();
}

// ---------------------------------------------------------------- text → lines

/** Marks a last line without a trailing newline so "a" vs "a\n" compares as a change. */
const NO_EOL = "\u0000\\ No newline at end of file";

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] = `${lines[lines.length - 1]}${NO_EOL}`;
  return lines;
}

function display(line: string): string {
  return line.endsWith(NO_EOL) ? line.slice(0, -NO_EOL.length) : line;
}

// ---------------------------------------------------------------- hunks

export interface LineDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Unified-diff hunks (git style headers) with `context` lines around each change. */
export function toHunks(
  oldLines: readonly string[],
  newLines: readonly string[],
  edits: readonly Edit[],
  context = 3,
): LineDiff {
  let additions = 0;
  let deletions = 0;
  const changeIdx: number[] = [];
  edits.forEach((e, i) => {
    if (e.kind === "add") additions++;
    else if (e.kind === "del") deletions++;
    if (e.kind !== "eq") changeIdx.push(i);
  });
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < changeIdx.length) {
    const first = changeIdx[i] ?? 0;
    let last = first;
    // Merge changes separated by at most 2 * context unchanged lines.
    while (i + 1 < changeIdx.length && (changeIdx[i + 1] ?? 0) - last - 1 <= 2 * context) {
      i++;
      last = changeIdx[i] ?? last;
    }
    i++;
    const from = Math.max(0, first - context);
    const to = Math.min(edits.length - 1, last + context);
    const lines: DiffLine[] = [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    // Line numbers before the hunk's first line (for empty sides, git uses the line before).
    let oldBefore = 0;
    let newBefore = 0;
    for (let j = 0; j < from; j++) {
      const e = edits[j];
      if (e?.oldIndex !== null && e?.oldIndex !== undefined) oldBefore = e.oldIndex + 1;
      if (e?.newIndex !== null && e?.newIndex !== undefined) newBefore = e.newIndex + 1;
    }
    for (let j = from; j <= to; j++) {
      const e = edits[j];
      if (e === undefined) continue;
      if (e.kind === "eq" || e.kind === "del") {
        const o = e.oldIndex ?? 0;
        if (oldCount === 0) oldStart = o + 1;
        oldCount++;
        lines.push({
          kind: e.kind === "eq" ? "ctx" : "del",
          oldNo: o + 1,
          newNo: e.kind === "eq" ? (e.newIndex ?? 0) + 1 : null,
          text: display(oldLines[o] ?? ""),
        });
      } else {
        lines.push({ kind: "add", oldNo: null, newNo: (e.newIndex ?? 0) + 1, text: display(newLines[e.newIndex ?? 0] ?? "") });
      }
      if (e.kind === "eq" || e.kind === "add") {
        const nIdx = e.newIndex ?? 0;
        if (newCount === 0) newStart = nIdx + 1;
        newCount++;
      }
    }
    if (oldCount === 0) oldStart = oldBefore;
    if (newCount === 0) newStart = newBefore;
    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      lines,
    });
  }
  return { hunks, additions, deletions };
}

/** Diff two texts into hunks. */
export function diffText(oldText: string, newText: string, opts: { context?: number; maxEditDistance?: number } = {}): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const edits = diffLines(a, b, opts.maxEditDistance === undefined ? {} : { maxEditDistance: opts.maxEditDistance });
  return toHunks(a, b, edits, opts.context ?? 3);
}

/** Apply an edit script (for tests): rebuild `b` from `a`, `b` and the script. */
export function applyEdits(a: readonly string[], b: readonly string[], edits: readonly Edit[]): string[] {
  const out: string[] = [];
  for (const e of edits) {
    if (e.kind === "eq") out.push(a[e.oldIndex ?? 0] ?? "");
    else if (e.kind === "add") out.push(b[e.newIndex ?? 0] ?? "");
  }
  return out;
}
