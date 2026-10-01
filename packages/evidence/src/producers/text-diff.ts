/**
 * Line diffs and a unified-diff writer whose output `git apply` accepts.
 *
 * Pure and Workers-safe. Lines keep their terminators, so "a" (no newline at end of file) and
 * "a\n" are different lines and the writer emits `\ No newline at end of file` exactly where git
 * would. Myers' O(ND) algorithm after trimming the common prefix and suffix; past `maxEditDistance`
 * the diff degrades to "replace everything in between" (still a correct, applicable diff).
 */

/** Split text into lines, each keeping its "\n" (the last one may lack it). "" has no lines. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** A line without its terminator ("\n" or "\r\n"). */
export function lineBody(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n")) return line.slice(0, -1);
  return line;
}

export type DiffOp =
  | { op: "eq"; a: number; b: number }
  | { op: "del"; a: number }
  | { op: "ins"; b: number };

export interface LineDiffOptions {
  /** Give up on a minimal diff beyond this many edits (default 4000). */
  maxEditDistance?: number;
}

/** Shortest edit script turning `a` into `b`, in order. Indexes are 0-based. */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  opts: LineDiffOptions = {},
): DiffOp[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ op: "eq", a: i, b: i });
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  for (const o of myers(midA, midB, opts.maxEditDistance ?? 4000)) {
    if (o.op === "eq") ops.push({ op: "eq", a: o.a + pre, b: o.b + pre });
    else if (o.op === "del") ops.push({ op: "del", a: o.a + pre });
    else ops.push({ op: "ins", b: o.b + pre });
  }
  for (let i = 0; i < suf; i++)
    ops.push({ op: "eq", a: a.length - suf + i, b: b.length - suf + i });
  return ops;
}

function replaceAll(n: number, m: number): DiffOp[] {
  const ops: DiffOp[] = [];
  for (let i = 0; i < n; i++) ops.push({ op: "del", a: i });
  for (let j = 0; j < m; j++) ops.push({ op: "ins", b: j });
  return ops;
}

function myers(a: readonly string[], b: readonly string[], maxD: number): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return replaceAll(n, m);
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // trace[d] holds v[-d..d] (as a copy) before step d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found !== -1) break;
  }
  if (found === -1) return replaceAll(n, m);

  // Backtrack.
  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!; // v[-d..d] before step d, i.e. after step d-1 (indexes shifted by d)
    const at = (k: number) => prev[k + d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rev.push({ op: "eq", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) rev.push({ op: "ins", b: y - 1 });
    else rev.push({ op: "del", a: x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    rev.push({ op: "eq", a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return rev.reverse();
}

// ---------------------------------------------------------------- unified diff writer

export interface FileChange {
  path: string;
  /** null = the file does not exist before (added). */
  before: string | null;
  /** null = the file does not exist after (deleted). */
  after: string | null;
  /** Git mode for added/deleted files (default 100644). */
  mode?: string;
}

const UNQUOTED_SAFE = /^[\x20-\x7e]*$/;

/** Git-style C quoting for paths with `"`, `\`, control or non-ASCII characters. */
export function quoteGitPath(path: string): string {
  if (UNQUOTED_SAFE.test(path) && !path.includes('"') && !path.includes("\\")) return path;
  let out = '"';
  for (const byte of new TextEncoder().encode(path)) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x09) out += "\\t";
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

function prefixed(prefix: "a/" | "b/", path: string): string {
  const q = quoteGitPath(path);
  return q.startsWith('"') ? `"${prefix}${q.slice(1)}` : `${prefix}${q}`;
}

function emitLine(out: string[], mark: " " | "-" | "+", line: string): void {
  if (line.endsWith("\n")) out.push(`${mark}${line}`);
  else out.push(`${mark}${line}\n`, "\\ No newline at end of file\n");
}

/** Unified diff of one file (`diff --git` format); "" when nothing changed. */
export function unifiedFileDiff(change: FileChange, context = 3): string {
  const { path, before, after } = change;
  if (before === after || (before === null && after === null)) return "";
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const mode = change.mode ?? "100644";
  const out: string[] = [`diff --git ${prefixed("a/", path)} ${prefixed("b/", path)}\n`];
  if (before === null) out.push(`new file mode ${mode}\n`);
  if (after === null) out.push(`deleted file mode ${mode}\n`);
  if (a.length === 0 && b.length === 0) return out.join(""); // empty file added or deleted
  out.push(before === null ? "--- /dev/null\n" : `--- ${prefixed("a/", path)}\n`);
  out.push(after === null ? "+++ /dev/null\n" : `+++ ${prefixed("b/", path)}\n`);

  const ops = diffLines(a, b);
  // Group changes into hunks with `context` lines around them.
  const changed = ops.map((o) => o.op !== "eq");
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend while the next change is within 2*context equal lines.
    for (;;) {
      while (end < ops.length && changed[end]) end++;
      let next = end;
      while (next < ops.length && !changed[next]) next++;
      if (next < ops.length && next - end <= 2 * context) {
        end = next;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    // Line numbers: the first a/b index covered by the hunk.
    let aStart = 0;
    let bStart = 0;
    for (let j = 0; j < start; j++) {
      const o = ops[j]!;
      if (o.op !== "ins") aStart++;
      if (o.op !== "del") bStart++;
    }
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let j = start; j < stop; j++) {
      const o = ops[j]!;
      if (o.op === "eq") {
        aCount++;
        bCount++;
        emitLine(body, " ", a[o.a]!);
      } else if (o.op === "del") {
        aCount++;
        emitLine(body, "-", a[o.a]!);
      } else {
        bCount++;
        emitLine(body, "+", b[o.b]!);
      }
    }
    const aShown = aCount === 0 ? aStart : aStart + 1;
    const bShown = bCount === 0 ? bStart : bStart + 1;
    out.push(`@@ -${aShown},${aCount} +${bShown},${bCount} @@\n`, ...body);
    i = stop;
  }
  return out.join("");
}

/** Unified diff over several files, in the given order. */
export function unifiedDiffOf(changes: readonly FileChange[], context = 3): string {
  return changes.map((c) => unifiedFileDiff(c, context)).join("");
}
