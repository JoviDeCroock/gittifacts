/**
 * What the resolver works on: the conflicted files (parsed into clean segments and conflict
 * regions) and, for semantic conflicts, the merged-tree files it may read and edit. Pure.
 */
import {
  type ConflictMarkers,
  type ConflictRegion,
  type ConflictSegment,
  parseConflicts,
  splitLines,
} from "@app/evidence";
import type { ConflictFileDoc, ConflictKind, MergeAttempt } from "./merge-doc.js";

export type Eol = "\n" | "\r\n";

/** Files longer than this are shown abbreviated and can only be resolved region by region. */
export const ABBREVIATE_ABOVE_LINES = 1200;

export interface ConflictedFile {
  path: string;
  kind: ConflictKind;
  mode: string;
  /** Content of the merge-attempt commit (markers included); null = absent there. */
  merged: string | null;
  /** Segments of `merged` when it has conflict regions; null for whole-file conflicts. */
  segments: ConflictSegment[] | null;
  regions: ConflictRegion[];
  /** The whole file is one region (modify/delete, add/add without common lines, other). */
  wholeFile: boolean;
  sides: { ours: string | null; base: string | null; theirs: string | null };
  eol: Eol;
  /** Shown abbreviated to the model: no whole-file replacement allowed. */
  abbreviated: boolean;
}

export interface ContextFile {
  path: string;
  content: string;
  mode: string;
  eol: Eol;
  abbreviated: boolean;
}

function longText(text: string | null): boolean {
  return text !== null && splitLines(text).length > ABBREVIATE_ABOVE_LINES;
}

export interface Workspace {
  mode: "textual" | "semantic";
  markers: ConflictMarkers;
  /** The commit the resolution patch applies to (conflictSha, or newSha for semantic). */
  applyOnto: string;
  ontoSha: string;
  conflicted: ConflictedFile[];
  /** Non-conflicted files the resolver was shown (semantic: merged-tree files). */
  context: ContextFile[];
}

export function eolOf(text: string | null): Eol {
  if (text === null) return "\n";
  const lines = splitLines(text);
  const crlf = lines.filter((l) => l.endsWith("\r\n")).length;
  return crlf > 0 && crlf >= lines.length / 2 ? "\r\n" : "\n";
}

export type WorkspaceResult =
  | { ok: true; ws: Workspace }
  | { ok: false; cause: "invalid-input" | "unsupported-conflict"; message: string };

function conflictedFile(f: ConflictFileDoc, markers: ConflictMarkers): ConflictedFile | string {
  if (f.binary) return `${f.path} is binary`;
  if (f.tooLarge) return `${f.path} is too large to resolve automatically`;
  const sides = { ours: f.ours, base: f.base, theirs: f.theirs };
  const eol = eolOf(f.merged_with_markers ?? f.theirs ?? f.ours);
  const whole = (): ConflictedFile => ({
    path: f.path,
    kind: f.kind,
    mode: f.mode,
    merged: f.merged_with_markers,
    segments: null,
    regions: [],
    wholeFile: true,
    sides,
    eol,
    abbreviated: false,
  });
  if (f.merged_with_markers === null || (f.kind !== "content" && f.kind !== "add-add"))
    return whole();
  const parsed = parseConflicts(f.merged_with_markers, markers);
  if (!parsed.ok) return `${f.path}: conflict markers could not be parsed (${parsed.reason})`;
  if (parsed.regions.length === 0) return whole();
  return {
    path: f.path,
    kind: f.kind,
    mode: f.mode,
    merged: f.merged_with_markers,
    segments: parsed.segments,
    regions: parsed.regions,
    wholeFile: false,
    sides,
    eol,
    abbreviated: longText(f.merged_with_markers),
  };
}

export function buildWorkspace(
  merge: MergeAttempt,
  files: readonly { path: string; content: string; mode?: string }[],
  semantic: boolean,
): WorkspaceResult {
  if (merge.status === "error")
    return { ok: false, cause: "invalid-input", message: `merge attempt failed: ${merge.note}` };
  if (merge.status === "clean" && !semantic)
    return {
      ok: false,
      cause: "invalid-input",
      message: "the merge was clean and no semantic conflict was given: nothing to resolve",
    };
  const conflicted: ConflictedFile[] = [];
  const problems: string[] = [];
  for (const f of merge.files) {
    const c = conflictedFile(f, merge.markers);
    if (typeof c === "string") problems.push(c);
    else conflicted.push(c);
  }
  if (problems.length > 0)
    return { ok: false, cause: "unsupported-conflict", message: problems.slice(0, 10).join("; ") };
  const seen = new Set(conflicted.map((c) => c.path));
  const context: ContextFile[] = [];
  for (const f of files) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    context.push({
      path: f.path,
      content: f.content,
      mode: f.mode ?? "100644",
      eol: eolOf(f.content),
      abbreviated: longText(f.content),
    });
  }
  return {
    ok: true,
    ws: {
      mode: semantic ? "semantic" : "textual",
      markers: merge.markers,
      applyOnto: merge.status === "conflict" ? merge.conflictSha : merge.newSha,
      ontoSha: merge.onto,
      conflicted,
      context,
    },
  };
}
