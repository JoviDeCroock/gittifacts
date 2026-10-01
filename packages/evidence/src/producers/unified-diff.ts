/**
 * Parser for `git diff` output (any `--unified=N`, including 0).
 *
 * Recommended invocation for producers:
 *   git diff --unified=0 --no-color --no-ext-diff -M --src-prefix=a/ --dst-prefix=b/ <base> <head>
 *
 * Handles renames/copies (incl. 100% similarity with no hunks), additions, deletions,
 * mode changes, binary files (with or without `--binary`), C-quoted paths, paths with
 * spaces, `\ No newline at end of file`, and content lines that look like headers
 * (a removed line "-- x" prints as "--- x"): hunk bodies are consumed by their counts.
 * Combined (merge) diffs are rejected.
 */
import { utf8Encode } from "../encoding.js";

export interface DiffHunk {
  /** Head path (base path for deleted files). */
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export interface DiffFile {
  /** Head path, or the base path when the file was deleted. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  /** Rename/copy similarity, 0..100. */
  similarity?: number;
  hunks: DiffHunk[];
  /** Head-side line numbers of added/changed lines, ascending. */
  addedLines: number[];
  /** Base-side line numbers of removed lines, ascending. */
  removedLines: number[];
}

export interface ParsedDiff {
  files: DiffFile[];
  hunks: DiffHunk[];
  /** Head path → changed head line numbers (text files that exist in head, with ≥1 added line). */
  changedLines: Record<string, number[]>;
}

export class DiffParseError extends Error {
  override readonly name = "DiffParseError";
  /** 1-based line number in the diff text. */
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (diff line ${line})`);
    this.line = line;
  }
}

// --------------------------------------------------------------------------- paths

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Read a C-quoted string starting at `s[start] === '"'`. Returns the value and end index (exclusive). */
function readQuoted(s: string, start: number): { value: string; end: number } | null {
  const bytes: number[] = [];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') {
      return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    }
    if (c === "\\") {
      const n = s[i + 1];
      if (n === undefined) return null;
      if (n >= "0" && n <= "7") {
        let j = i + 1;
        let v = 0;
        while (j < s.length && j < i + 4 && s[j]! >= "0" && s[j]! <= "7")
          v = v * 8 + Number(s[j++]);
        bytes.push(v & 0xff);
        i = j;
        continue;
      }
      const e = C_ESCAPES[n];
      bytes.push(e ?? n.charCodeAt(0));
      i += 2;
      continue;
    }
    // Unescaped (possibly non-ASCII when core.quotePath=false): add its UTF-8 bytes.
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    for (const b of utf8Encode(ch)) bytes.push(b);
    i += ch.length;
  }
  return null;
}

/** Git C-style unquoting of a whole token; unquoted input is returned unchanged. */
export function unquoteGitPath(token: string): string {
  if (!token.startsWith('"')) return token;
  const q = readQuoted(token, 0);
  return q && q.end === token.length ? q.value : token;
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Path from a `---`/`+++` line value; null for /dev/null. */
function fileLinePath(value: string, prefix: string): string | null {
  let p: string;
  if (value.startsWith('"')) {
    const q = readQuoted(value, 0);
    p = q ? q.value : value;
  } else {
    // git appends a TAB after names containing spaces; GNU diff appends "\t<timestamp>".
    const tab = value.indexOf("\t");
    p = tab >= 0 ? value.slice(0, tab) : value;
  }
  if (p === "/dev/null") return null;
  return stripPrefix(p, prefix);
}

/** Best-effort split of the `diff --git` header into [old, new] paths. */
function headerPaths(rest: string): [string, string] | null {
  let a: string | null = null;
  let b: string | null = null;
  if (rest.startsWith('"')) {
    const q = readQuoted(rest, 0);
    if (!q) return null;
    a = q.value;
    const tail = rest.slice(q.end + 1);
    b = tail.startsWith('"') ? unquoteGitPath(tail) : tail;
  } else if (rest.endsWith('"')) {
    const idx = rest.lastIndexOf(' "');
    if (idx < 0) return null;
    a = rest.slice(0, idx);
    b = unquoteGitPath(rest.slice(idx + 1));
  } else {
    // Unquoted: same path on both sides is the common case and is unambiguous by length.
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest[half] === " ") {
      const left = rest.slice(0, half);
      const right = rest.slice(half + 1);
      if (stripPrefix(left, "a/") === stripPrefix(right, "b/")) {
        a = left;
        b = right;
      }
    }
    if (a === null) {
      const idx = rest.indexOf(" b/");
      if (idx < 0) return null;
      a = rest.slice(0, idx);
      b = rest.slice(idx + 1);
    }
  }
  return [stripPrefix(a, "a/"), stripPrefix(b ?? "", "b/")];
}

// --------------------------------------------------------------------------- parse

interface Building {
  header: [string, string] | null;
  fromOld: string | null | undefined; // from "--- " (null = /dev/null)
  fromNew: string | null | undefined; // from "+++ "
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: Omit<DiffHunk, "file">[];
  added: number[];
  removed: number[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function finish(b: Building): DiffFile {
  const oldFromHeader = b.header?.[0] ?? null;
  const newFromHeader = b.header?.[1] ?? null;
  const isNew = b.isNew || b.fromOld === null;
  const isDeleted = b.isDeleted || b.fromNew === null;
  let status: DiffFileStatus = "modified";
  if (b.renameFrom !== undefined || b.renameTo !== undefined) status = "renamed";
  else if (b.copyFrom !== undefined || b.copyTo !== undefined) status = "copied";
  else if (isNew) status = "added";
  else if (isDeleted) status = "deleted";

  const oldPath =
    status === "added" ? null : (b.renameFrom ?? b.copyFrom ?? b.fromOld ?? oldFromHeader);
  const newPath =
    status === "deleted" ? null : (b.renameTo ?? b.copyTo ?? b.fromNew ?? newFromHeader);
  const path = newPath ?? oldPath ?? "";
  const file: DiffFile = {
    path,
    oldPath,
    newPath,
    status,
    binary: b.binary,
    hunks: b.hunks.map((h) => ({ file: path, ...h })),
    addedLines: b.added,
    removedLines: b.removed,
  };
  if (b.oldMode !== undefined) file.oldMode = b.oldMode;
  if (b.newMode !== undefined) file.newMode = b.newMode;
  if (b.similarity !== undefined) file.similarity = b.similarity;
  return file;
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const files: DiffFile[] = [];
  let cur: Building | null = null;
  let oldRem = 0;
  let newRem = 0;
  let oldLine = 0;
  let newLine = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNo = idx + 1;

    if (cur && (oldRem > 0 || newRem > 0)) {
      const c = raw[0];
      if (c === "\\") continue; // "\ No newline at end of file"
      if (c === " " || raw === "" || raw === "\r") {
        // Context. (An empty line is a context line whose leading space was stripped.)
        oldRem--;
        newRem--;
        oldLine++;
        newLine++;
      } else if (c === "-") {
        cur.removed.push(oldLine++);
        oldRem--;
      } else if (c === "+") {
        cur.added.push(newLine++);
        newRem--;
      } else {
        throw new DiffParseError(
          `unexpected line inside hunk: ${JSON.stringify(raw.slice(0, 40))}`,
          lineNo,
        );
      }
      if (oldRem < 0 || newRem < 0)
        throw new DiffParseError("hunk body longer than its header says", lineNo);
      continue;
    }

    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("diff --git ")) {
      if (cur) files.push(finish(cur));
      cur = {
        header: headerPaths(line.slice("diff --git ".length)),
        fromOld: undefined,
        fromNew: undefined,
        isNew: false,
        isDeleted: false,
        binary: false,
        hunks: [],
        added: [],
        removed: [],
      };
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      throw new DiffParseError(
        "combined (merge) diffs are not supported; diff two trees instead",
        lineNo,
      );
    }
    if (!cur) continue; // preamble (commit header, email headers, ...)

    if (line.startsWith("@@ ")) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new DiffParseError(`malformed hunk header: ${line}`, lineNo);
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      cur.hunks.push({ oldStart, oldLines, newStart, newLines });
      oldRem = oldLines;
      newRem = newLines;
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("--- ")) cur.fromOld = fileLinePath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) cur.fromNew = fileLinePath(line.slice(4), "b/");
    else if (line.startsWith("new file mode ")) {
      cur.isNew = true;
      cur.newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) {
      cur.isDeleted = true;
      cur.oldMode = line.slice("deleted file mode ".length);
    } else if (line.startsWith("old mode ")) cur.oldMode = line.slice("old mode ".length);
    else if (line.startsWith("new mode ")) cur.newMode = line.slice("new mode ".length);
    else if (line.startsWith("similarity index "))
      cur.similarity = Number.parseInt(line.slice(17), 10);
    else if (line.startsWith("rename from ")) cur.renameFrom = unquoteGitPath(line.slice(12));
    else if (line.startsWith("rename to ")) cur.renameTo = unquoteGitPath(line.slice(10));
    else if (line.startsWith("copy from ")) cur.copyFrom = unquoteGitPath(line.slice(10));
    else if (line.startsWith("copy to ")) cur.copyTo = unquoteGitPath(line.slice(8));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    // Anything else (index lines, binary patch payload, dissimilarity) is ignored.
  }
  if (cur && (oldRem > 0 || newRem > 0)) {
    throw new DiffParseError("diff ended inside a hunk (truncated input?)", lines.length);
  }
  if (cur) files.push(finish(cur));

  const changedLines: Record<string, number[]> = {};
  for (const f of files) {
    if (f.newPath !== null && !f.binary && f.addedLines.length > 0)
      changedLines[f.newPath] = f.addedLines;
  }
  return { files, hunks: files.flatMap((f) => f.hunks), changedLines };
}

/** Every path a diff touches, on either side (renames contribute both), sorted and unique. */
export function touchedPaths(diff: ParsedDiff): string[] {
  const set = new Set<string>();
  for (const f of diff.files) {
    if (f.oldPath !== null) set.add(f.oldPath);
    if (f.newPath !== null) set.add(f.newPath);
  }
  return [...set].sort();
}
