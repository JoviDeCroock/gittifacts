/**
 * Diff rendering model. Pure functions: no DOM, no clocks.
 *
 * - `hunkFromText` builds an API-shaped hunk from unified-diff body text (used by fixtures/tests).
 * - `excerptForRef` cuts the lines a tour stop cites out of a ChangeDiff, with a little context.
 * - `tokenize` is a deliberately light highlighter: comments, strings, numbers, keywords.
 */
import type { HunkRef } from "@app/domain";
import type { ChangeDiff, DiffFile, DiffHunk, DiffLine } from "../api/types.js";

export function hunkFromText(oldStart: number, newStart: number, body: string): DiffHunk {
  const raw = body.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n");
  let oldNo = oldStart;
  let newNo = newStart;
  const lines: DiffLine[] = raw.map((row) => {
    const sign = row.charAt(0);
    const text = row.slice(1);
    if (sign === "+") return { kind: "add", oldNo: null, newNo: newNo++, text };
    if (sign === "-") return { kind: "del", oldNo: oldNo++, newNo: null, text };
    return { kind: "ctx", oldNo: oldNo++, newNo: newNo++, text };
  });
  const oldLines = lines.filter((l) => l.kind !== "add").length;
  const newLines = lines.filter((l) => l.kind !== "del").length;
  return { header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, oldStart, oldLines, newStart, newLines, lines };
}

export function fileStats(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  return { additions, deletions };
}

export interface Excerpt {
  file: DiffFile;
  ref: HunkRef;
  /** Lines to render, in order. `gap` rows mark skipped lines between hunks. */
  rows: ExcerptRow[];
  /** True when the ref pointed at lines the diff does not contain. */
  missing: boolean;
}

export type ExcerptRow =
  | { type: "line"; line: DiffLine; cited: boolean }
  | { type: "gap"; skipped: number };

function lineNo(line: DiffLine, side: "head" | "base"): number | null {
  return side === "head" ? line.newNo : line.oldNo;
}

/**
 * Lines of `diff` that a tour stop's HunkRef cites, plus `context` lines around them.
 * Deleted lines are shown inline when they sit inside the cited head range, so a reader
 * sees what was replaced. Never throws: a ref outside the diff yields `missing: true`.
 */
export function excerptForRef(diff: ChangeDiff, ref: HunkRef, context = 2): Excerpt | null {
  const file = diff.files.find((f) => f.path === ref.file || f.previousPath === ref.file);
  if (!file) return null;
  const side = ref.side ?? "head";
  const rows: ExcerptRow[] = [];
  let cursorEnd: number | null = null;

  for (const hunk of file.hunks) {
    const lines = hunk.lines;
    // Index range of cited lines within this hunk.
    let first = -1;
    let last = -1;
    lines.forEach((line, i) => {
      const n = lineNo(line, side);
      const inRange = n !== null && n >= ref.startLine && n <= ref.endLine;
      if (inRange) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) continue;
    // Pull in deletions directly adjacent to the cited block (they explain the additions).
    while (first > 0 && lines[first - 1]?.kind === "del") first--;
    while (last < lines.length - 1 && lines[last + 1]?.kind === "del") last++;

    const from = Math.max(0, first - context);
    const to = Math.min(lines.length - 1, last + context);
    let startNo: number | null = null;
    for (let i = from; i <= to && startNo === null; i++) startNo = lineNo(lines[i]!, side);
    if (cursorEnd !== null && startNo !== null && startNo > cursorEnd + 1) {
      rows.push({ type: "gap", skipped: startNo - cursorEnd - 1 });
    }
    for (let i = from; i <= to; i++) {
      const line = lines[i]!;
      const n = lineNo(line, side);
      const cited = i >= first && i <= last && (line.kind !== "ctx" || (n !== null && n >= ref.startLine && n <= ref.endLine));
      rows.push({ type: "line", line, cited });
    }
    for (let i = to; i >= from; i--) {
      const n = lineNo(lines[i]!, side);
      if (n !== null) {
        cursorEnd = n;
        break;
      }
    }
  }

  return { file, ref, rows, missing: rows.length === 0 };
}

// ---------------------------------------------------------------- syntax-light tokens

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";
export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete",
  "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "of", "private", "protected", "public",
  "readonly", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "var", "void", "while", "yield",
]);

const TOKEN_RE =
  /(\/\/.*$|\/\*.*?(?:\*\/|$)|^\s*\*.*$|#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)/g;

/**
 * Tokenize one line of TS/JS-like source. Line-local: a block comment that spans lines is only
 * recognised by its leading `*`, which is good enough for excerpts and never mangles text.
 * `hashComments` enables `#` comments (YAML, TOML, shell).
 */
export function tokenize(text: string, opts: { hashComments?: boolean } = {}): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m !== null; m = TOKEN_RE.exec(text)) {
    const [whole, comment, str, num, word] = m;
    if (m.index > last) tokens.push({ kind: "plain", text: text.slice(last, m.index) });
    if (comment !== undefined) {
      if (comment.startsWith("#") && !opts.hashComments) {
        tokens.push({ kind: "plain", text: whole });
      } else {
        tokens.push({ kind: "comment", text: whole });
      }
    } else if (str !== undefined) tokens.push({ kind: "string", text: whole });
    else if (num !== undefined) tokens.push({ kind: "number", text: whole });
    else if (word !== undefined) tokens.push({ kind: KEYWORDS.has(word) ? "keyword" : "plain", text: whole });
    last = m.index + whole.length;
    if (whole.length === 0) TOKEN_RE.lastIndex++;
  }
  if (last < text.length) tokens.push({ kind: "plain", text: text.slice(last) });
  return mergePlain(tokens);
}

function mergePlain(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === t.kind && t.kind === "plain") prev.text += t.text;
    else out.push({ ...t });
  }
  return out;
}

export function usesHashComments(path: string): boolean {
  return /\.(ya?ml|toml|sh|py|rb)$|(^|\/)(Dockerfile|\.env[^/]*)$/.test(path);
}

/** "src/billing/invoice.ts" → { dir: "src/billing/", name: "invoice.ts" } */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function rangeLabel(ref: HunkRef): string {
  return ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}–${ref.endLine}`;
}

/** Compress sorted line numbers into ranges: [3,4,5,9] → ["3–5", "9"]. */
export function compressLines(lines: number[]): string[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const n of sorted) {
    if (start === null) {
      start = n;
    } else if (prev !== null && n !== prev + 1) {
      out.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null && prev !== null) out.push(start === prev ? `${start}` : `${start}–${prev}`);
  return out;
}
