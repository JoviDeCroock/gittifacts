/**
 * Turn the model's answer into resolved file contents, or into a list of problems the model gets
 * back for its one regeneration. Pure. Nothing here decides what the resolution touched: that is
 * `resolutionScope` (in @app/evidence), run on the result.
 */
import {
  type ConflictRegion,
  GIT_DEFAULT_MARKERS,
  hasConflictMarkers,
  lineBody,
  splitLines,
} from "@app/evidence";
import type { ModelResolution } from "./schema.js";
import type { ConflictedFile, Eol, Workspace } from "./workspace.js";

export interface ResolvedFileChange {
  path: string;
  /** Content in the merge-attempt commit; null = absent there. */
  before: string | null;
  /** Content after the resolution; null = deleted. */
  after: string | null;
  mode: string;
  conflicted: boolean;
  wholeFile: boolean;
  sides?: { ours: string | null; base: string | null; theirs: string | null };
}

export type ApplyResult =
  | { ok: true; files: ResolvedFileChange[] }
  | { ok: false; problems: string[] };

/** Line endings as the file uses them; a non-empty replacement always ends with a newline. */
export function normalizeText(text: string, eol: Eol, endWithNewline: boolean): string {
  let t = text.replace(/\r\n/g, "\n");
  if (endWithNewline && t !== "" && !t.endsWith("\n")) t += "\n";
  return eol === "\r\n" ? t.replace(/\n/g, "\r\n") : t;
}

function endsWithNewline(text: string | null): boolean {
  return text === null || text === "" || text.endsWith("\n");
}

function key(line: string): string {
  return lineBody(line).trim();
}

/**
 * A replacement that starts (or ends) with the clean line right before (after) its region, when
 * no side of the region has that line, duplicated its neighbour: the model copied context.
 */
function duplicatedNeighbour(
  before: readonly string[],
  replacement: readonly string[],
  after: readonly string[],
  region: ConflictRegion,
): string | null {
  const sides = new Set([...region.ours, ...(region.base ?? []), ...region.theirs].map(key));
  const prev = before[before.length - 1];
  const first = replacement[0];
  if (prev !== undefined && first !== undefined) {
    const k = key(prev);
    if (k.length > 3 && k === key(first) && !sides.has(k)) return lineBody(prev).trim();
  }
  const next = after[0];
  const last = replacement[replacement.length - 1];
  if (next !== undefined && last !== undefined) {
    const k = key(next);
    if (k.length > 3 && k === key(last) && !sides.has(k)) return lineBody(next).trim();
  }
  return null;
}

function fromRegions(
  file: ConflictedFile,
  texts: ReadonlyMap<number, string>,
  problems: string[],
): string {
  const segments = file.segments ?? [];
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === "clean") {
      out += seg.lines.join("");
      continue;
    }
    const text = texts.get(seg.index) ?? "";
    const replacement = normalizeText(text, file.eol, true);
    const prevSeg = segments[i - 1];
    const nextSeg = segments[i + 1];
    const dup = duplicatedNeighbour(
      prevSeg?.kind === "clean" ? prevSeg.lines : [],
      splitLines(replacement),
      nextSeg?.kind === "clean" ? nextSeg.lines : [],
      seg,
    );
    if (dup !== null)
      problems.push(
        `${file.path} conflict ${seg.index}: the text repeats the line "${dup.slice(0, 80)}" that is already right outside the region. Give only the lines that replace the region itself.`,
      );
    out += replacement;
  }
  return out;
}

/** Markers that are new in `after` (git's default ones count only if `before` had none). */
function leftoverMarkers(ws: Workspace, before: string | null, after: string): boolean {
  if (hasConflictMarkers(after, ws.markers)) return true;
  return (
    hasConflictMarkers(after, GIT_DEFAULT_MARKERS) &&
    !hasConflictMarkers(before ?? "", GIT_DEFAULT_MARKERS)
  );
}

export function applyModelResolution(ws: Workspace, model: ModelResolution): ApplyResult {
  const problems: string[] = [];
  const conflicted = new Map(ws.conflicted.map((f) => [f.path, f]));
  const context = new Map(ws.context.map((f) => [f.path, f]));

  const fileEdits = new Map<string, string | null>();
  for (const e of model.files) {
    if (fileEdits.has(e.path)) {
      problems.push(`"files" lists ${e.path} more than once.`);
      continue;
    }
    if (!conflicted.has(e.path) && !context.has(e.path)) {
      problems.push(
        `"files" edits ${e.path}, which you were not shown. You may only edit the conflicted files and the files shown in full.`,
      );
      continue;
    }
    if (conflicted.get(e.path)?.abbreviated || context.get(e.path)?.abbreviated) {
      problems.push(
        `${e.path} was shown abbreviated, so it cannot be replaced whole; resolve its conflict regions instead.`,
      );
      continue;
    }
    fileEdits.set(e.path, e.content);
  }

  const regionTexts = new Map<string, Map<number, string>>();
  for (const r of model.regions) {
    const file = conflicted.get(r.file);
    if (file === undefined) {
      problems.push(`"regions" names ${r.file}, which has no conflict regions.`);
      continue;
    }
    if (fileEdits.has(r.file)) {
      problems.push(
        `${r.file} is given both in "files" and in "regions"; use one of them for a file.`,
      );
      continue;
    }
    const count = file.wholeFile ? 1 : file.regions.length;
    if (r.conflict > count) {
      problems.push(
        `${r.file} has ${count} conflict region(s); there is no conflict ${r.conflict}.`,
      );
      continue;
    }
    const texts = regionTexts.get(r.file) ?? new Map<number, string>();
    if (texts.has(r.conflict)) {
      problems.push(`${r.file} conflict ${r.conflict} is resolved more than once.`);
      continue;
    }
    texts.set(r.conflict, r.text);
    regionTexts.set(r.file, texts);
  }

  const out: ResolvedFileChange[] = [];
  for (const file of ws.conflicted) {
    let after: string | null;
    const edit = fileEdits.get(file.path);
    if (edit !== undefined) {
      after =
        edit === null
          ? null
          : normalizeText(edit, file.eol, endsWithNewline(file.merged ?? file.sides.theirs));
    } else {
      const texts = regionTexts.get(file.path) ?? new Map<number, string>();
      const count = file.wholeFile ? 1 : file.regions.length;
      const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !texts.has(n));
      if (missing.length > 0) {
        problems.push(
          `${file.path}: no resolution for conflict ${missing.join(", ")}. Resolve every region, or give the whole file in "files".`,
        );
        continue;
      }
      after = file.wholeFile
        ? normalizeText(
            texts.get(1) ?? "",
            file.eol,
            endsWithNewline(file.merged ?? file.sides.theirs),
          )
        : fromRegions(file, texts, problems);
    }
    if (after !== null && leftoverMarkers(ws, file.merged, after)) {
      problems.push(`${file.path} still contains conflict markers.`);
      continue;
    }
    if (after === file.merged) continue;
    out.push({
      path: file.path,
      before: file.merged,
      after,
      mode: file.mode,
      conflicted: true,
      wholeFile: file.wholeFile,
      sides: file.sides,
    });
  }
  for (const f of ws.context) {
    const edit = fileEdits.get(f.path);
    if (edit === undefined) continue;
    const after = edit === null ? null : normalizeText(edit, f.eol, endsWithNewline(f.content));
    if (after !== null && leftoverMarkers(ws, f.content, after)) {
      problems.push(`${f.path} contains conflict markers.`);
      continue;
    }
    if (after === f.content) continue;
    out.push({
      path: f.path,
      before: f.content,
      after,
      mode: f.mode,
      conflicted: false,
      wholeFile: false,
    });
  }

  if (ws.conflicted.length === 0 && out.length === 0)
    problems.push('The answer changes nothing. A semantic conflict needs an edit in "files".');
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, files: out };
}
