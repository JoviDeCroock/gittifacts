/**
 * `diff`: the base..head diff as `ChangeDiff` (packages/domain) — per-file stats plus hunks with
 * line text — for local testing and for callers that want the sandbox's view of the diff.
 */
import {
  ChangeDiff,
  type ChangeDiffFile,
  type DiffHunk,
  type DiffLine,
  type FileDiffStat,
} from "@app/domain";
import { type DiffFile, parseUnifiedDiff } from "@app/evidence";
import type { Context } from "../lib/context.js";
import { gitText } from "../lib/git.js";

const MAX_LINES_PER_FILE = 3000;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Hunks (with line text) of each `diff --git` block, in order. */
function hunkBodies(text: string): DiffHunk[][] {
  const blocks: DiffHunk[][] = [];
  const lines = text.split("\n");
  let current: DiffHunk[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      current = [];
      blocks.push(current);
      continue;
    }
    if (current === null || !line.startsWith("@@ ")) continue;
    const m = HUNK_RE.exec(line);
    if (m === null) continue;
    const oldStart = Number(m[1]);
    const oldLines = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newLines = m[4] === undefined ? 1 : Number(m[4]);
    const hunk: DiffHunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
    let oldRem = oldLines;
    let newRem = newLines;
    let oldNo = oldStart;
    let newNo = newStart;
    while ((oldRem > 0 || newRem > 0) && i + 1 < lines.length) {
      const body = lines[++i] ?? "";
      if (body.startsWith("\\")) continue;
      const c = body[0];
      let entry: DiffLine;
      if (c === "+") {
        entry = { kind: "add", oldNo: null, newNo: newNo++, text: body.slice(1) };
        newRem--;
      } else if (c === "-") {
        entry = { kind: "del", oldNo: oldNo++, newNo: null, text: body.slice(1) };
        oldRem--;
      } else {
        entry = { kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: body.slice(1) };
        oldRem--;
        newRem--;
      }
      hunk.lines.push(entry);
    }
    current.push(hunk);
  }
  return blocks;
}

function statOf(f: DiffFile): FileDiffStat {
  return {
    path: f.path,
    previousPath: f.status === "renamed" || f.status === "copied" ? f.oldPath : null,
    status: f.status,
    additions: f.addedLines.length,
    deletions: f.removedLines.length,
    binary: f.binary,
  };
}

export async function changeDiff(ctx: Context): Promise<ChangeDiff> {
  const text = await gitText(ctx.repo, [
    "diff",
    "--unified=3",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ctx.base,
    ctx.head,
    "--",
  ]);
  const parsed = parseUnifiedDiff(text);
  const bodies = hunkBodies(text);
  const files: ChangeDiffFile[] = parsed.files.map((f, i) => {
    const hunks = f.binary ? [] : (bodies[i] ?? []);
    let budget = MAX_LINES_PER_FILE;
    const kept: DiffHunk[] = [];
    let truncated = false;
    for (const h of hunks) {
      if (budget - h.lines.length < 0) {
        truncated = true;
        break;
      }
      budget -= h.lines.length;
      kept.push(h);
    }
    return { ...statOf(f), transformVerified: false, hunks: kept, truncated };
  });
  return ChangeDiff.parse({
    baseSha: ctx.base,
    headSha: ctx.head,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  });
}
