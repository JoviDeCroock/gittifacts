/** The base..head diff, parsed once per invocation with the pure producer parser. */
import { type DiffFile, type ParsedDiff, parseUnifiedDiff, touchedPaths } from "@app/evidence";
import type { Context } from "./context.js";
import { unifiedDiff } from "./git.js";

export interface Changes {
  diff: ParsedDiff;
  /** Every path touched on either side (renames contribute both), sorted. */
  touched: string[];
  /** Files that exist at head (added/modified/renamed/copied), by head path. */
  headFiles: DiffFile[];
}

export async function loadChanges(ctx: Context): Promise<Changes> {
  const diff = parseUnifiedDiff(await unifiedDiff(ctx.repo, ctx.base, ctx.head, 0));
  return {
    diff,
    touched: touchedPaths(diff),
    headFiles: diff.files.filter((f) => f.newPath !== null),
  };
}

/**
 * Head lines that a file's diff touches: added lines, plus the head lines on either side of a
 * pure deletion (so deleting an assertion still marks the test it was in).
 */
export function touchedHeadLines(file: DiffFile): number[] {
  const lines = new Set<number>(file.addedLines);
  for (const h of file.hunks) {
    if (h.newLines === 0 && h.oldLines > 0) {
      if (h.newStart > 0) lines.add(h.newStart);
      lines.add(h.newStart + 1);
    }
  }
  return [...lines].sort((a, b) => a - b);
}
