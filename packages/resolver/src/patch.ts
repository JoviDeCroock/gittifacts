/**
 * The resolution patch: built with @app/evidence's diff writer and checked by applying it to the
 * merge-attempt contents in memory before anything is handed to `git apply`. Pure.
 */
import { type FileChange, splitLines, unifiedFileDiff } from "@app/evidence";
import type { ResolvedFileChange } from "./apply.js";

export class PatchError extends Error {
  override readonly name = "PatchError";
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Apply one file's `diff --git` text (as `unifiedFileDiff` writes it) to `before`. */
export function applyFileDiff(before: string | null, diff: string): string | null {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const deleted = lines.some((l) => l.startsWith("deleted file mode "));
  const added = lines.some((l) => l.startsWith("new file mode "));
  if (added && before !== null) throw new PatchError("adds a file that already exists");
  if (!added && before === null) throw new PatchError("modifies a file that does not exist");
  const src = splitLines(before ?? "");
  const out: string[] = [];
  let at = 0;
  let i = lines.findIndex((l) => l.startsWith("@@ "));
  if (i === -1) {
    if (deleted) {
      if (src.length > 0) throw new PatchError("deletes a non-empty file without hunks");
      return null;
    }
    return before ?? "";
  }
  while (i < lines.length) {
    const m = HUNK.exec(lines[i]!);
    if (!m) throw new PatchError(`malformed hunk header: ${lines[i]}`);
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const from = oldCount === 0 ? oldStart : oldStart - 1;
    if (from < at) throw new PatchError("overlapping hunks");
    while (at < from) {
      const l = src[at++];
      if (l === undefined) throw new PatchError("hunk starts past the end of the file");
      out.push(l);
    }
    i++;
    while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
      const l = lines[i]!;
      const noEol = lines[i + 1]?.startsWith("\\ ") ?? false;
      const text = l.slice(1) + (noEol ? "" : "\n");
      if (l.startsWith(" ") || l.startsWith("-")) {
        if (src[at] !== text) throw new PatchError(`context mismatch at line ${at + 1}`);
        if (l.startsWith(" ")) out.push(text);
        at++;
      } else if (l.startsWith("+")) out.push(text);
      else throw new PatchError(`unexpected line in hunk: ${l.slice(0, 40)}`);
      i += noEol ? 2 : 1;
    }
  }
  while (at < src.length) out.push(src[at++]!);
  if (deleted) {
    if (out.length > 0) throw new PatchError("a deletion leaves content behind");
    return null;
  }
  return out.join("");
}

/**
 * The patch for `files` (a `git apply`-able unified diff against the merge-attempt commit),
 * verified file by file: applying it to `before` must give exactly `after`.
 */
export function buildPatch(files: readonly ResolvedFileChange[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const change: FileChange = { path: f.path, before: f.before, after: f.after, mode: f.mode };
    const diff = unifiedFileDiff(change);
    if (diff === "") continue;
    let applied: string | null;
    try {
      applied = applyFileDiff(f.before, diff);
    } catch (e) {
      throw new PatchError(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (applied !== f.after)
      throw new PatchError(`${f.path}: the patch does not reproduce the resolution`);
    parts.push(diff);
  }
  return parts.join("");
}
