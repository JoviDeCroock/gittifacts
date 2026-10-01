/**
 * Merge conflicts, their resolution, and quarantined tests.
 *
 * The facts a reviewer relies on are computed here, mechanically, from the merge with conflict
 * markers and the resolved files: which lines the conflict regions became and whether anything
 * else changed. A resolver's (model's) own account of what it did is never an input.
 *
 * "Within the conflict hunks" is decided exactly: the resolved file must be the merged file with
 * each conflict region (markers included) replaced by something, every clean line kept verbatim
 * and in order. That is a wildcard match (clean₀ * clean₁ * … * cleanₙ, anchored at both ends),
 * solved greedily: prefix, suffix, then each middle segment at its leftmost position.
 */
import { truncate, utf8Encode, wellFormed } from "../encoding.js";
import {
  type ConflictHunk,
  type ConflictResolution,
  type Quarantine,
  type QuarantinedTest,
  RESOLUTION_DIFF_MAX_BYTES,
  type UpstreamChangeRef,
} from "../schema.js";
import { GlobError, matchPathPattern } from "./glob.js";
import { diffLines, lineBody, splitLines } from "./text-diff.js";

// ---------------------------------------------------------------- markers

/**
 * How conflict markers look. Git's default is size 7 with labels (`<<<<<<< HEAD`). A label of
 * `undefined` matches any label (and none); give exact labels whenever the merge used known ones,
 * so content that merely looks like a marker is never mistaken for one.
 */
export interface ConflictMarkers {
  size: number;
  ours?: string;
  base?: string;
  theirs?: string;
}

export const GIT_DEFAULT_MARKERS: ConflictMarkers = { size: 7 };

export interface CleanSegment {
  kind: "clean";
  lines: string[];
}

export interface ConflictRegion {
  kind: "conflict";
  /** 1-based index of the region within its file. */
  index: number;
  ours: string[];
  /** null without a diff3 base section. */
  base: string[] | null;
  theirs: string[];
  /** 1-based lines of the merged text, markers included. */
  startLine: number;
  endLine: number;
}

export type ConflictSegment = CleanSegment | ConflictRegion;

export type ParsedConflicts =
  | { ok: true; segments: ConflictSegment[]; regions: ConflictRegion[] }
  | { ok: false; reason: string; line: number };

function markerLine(char: string, size: number, label: string | undefined, body: string): boolean {
  const run = char.repeat(size);
  if (!body.startsWith(run)) return false;
  const rest = body.slice(size);
  if (label === undefined) return rest === "" || (rest.startsWith(" ") && rest[1] !== char);
  return rest === (label === "" ? "" : ` ${label}`);
}

/**
 * Split merged text into clean segments and conflict regions (diff3 or merge style).
 * Lines keep their terminators; the clean segment list always starts and ends with a (possibly
 * empty) clean segment, alternating with regions.
 */
export function parseConflicts(
  text: string,
  markers: ConflictMarkers = GIT_DEFAULT_MARKERS,
): ParsedConflicts {
  const lines = splitLines(text);
  const segments: ConflictSegment[] = [];
  const regions: ConflictRegion[] = [];
  let clean: string[] = [];
  let state: "clean" | "ours" | "base" | "theirs" = "clean";
  let cur: ConflictRegion | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const body = lineBody(line);
    const isOpen = markerLine("<", markers.size, markers.ours, body);
    const isBase = markerLine("|", markers.size, markers.base, body);
    const isMid = body === "=".repeat(markers.size);
    const isClose = markerLine(">", markers.size, markers.theirs, body);
    switch (state) {
      case "clean":
        if (isOpen) {
          segments.push({ kind: "clean", lines: clean });
          clean = [];
          cur = {
            kind: "conflict",
            index: regions.length + 1,
            ours: [],
            base: null,
            theirs: [],
            startLine: i + 1,
            endLine: i + 1,
          };
          state = "ours";
        } else if (isClose || isBase) {
          return { ok: false, reason: "conflict marker outside a conflict region", line: i + 1 };
        } else clean.push(line);
        break;
      case "ours":
        if (isOpen) return { ok: false, reason: "nested conflict region", line: i + 1 };
        if (isBase) {
          cur!.base = [];
          state = "base";
        } else if (isMid) state = "theirs";
        else if (isClose)
          return { ok: false, reason: "region closed without =======", line: i + 1 };
        else cur!.ours.push(line);
        break;
      case "base":
        if (isMid) state = "theirs";
        else if (isOpen || isClose)
          return { ok: false, reason: "malformed diff3 base section", line: i + 1 };
        else cur!.base!.push(line);
        break;
      case "theirs":
        if (isClose) {
          cur!.endLine = i + 1;
          segments.push(cur!);
          regions.push(cur!);
          cur = null;
          state = "clean";
        } else if (isOpen) return { ok: false, reason: "nested conflict region", line: i + 1 };
        else cur!.theirs.push(line);
        break;
    }
  }
  if (state !== "clean") {
    return { ok: false, reason: "conflict region not closed", line: lines.length };
  }
  segments.push({ kind: "clean", lines: clean });
  return { ok: true, segments, regions };
}

/** True when `text` still contains a conflict marker line (open, base or close). */
export function hasConflictMarkers(
  text: string,
  markers: ConflictMarkers = GIT_DEFAULT_MARKERS,
): boolean {
  for (const line of splitLines(text)) {
    const body = lineBody(line);
    if (
      markerLine("<", markers.size, markers.ours, body) ||
      markerLine(">", markers.size, markers.theirs, body) ||
      markerLine("|", markers.size, markers.base, body)
    )
      return true;
  }
  return false;
}

// ---------------------------------------------------------------- resolution scope

export interface ResolvedFile {
  path: string;
  /** Content of the mechanical merge (conflict markers included); null = absent there. */
  merged: string | null;
  /** Content after the resolution; null = deleted by it. */
  resolved: string | null;
  /** The merge reported this path as conflicted. Edits to other paths are outside by definition. */
  conflicted: boolean;
  /**
   * The whole file is one conflict region (modify/delete, binary, add/add with nothing in
   * common, or no markers): any content, or deleting it, stays within the conflict.
   */
  wholeFile?: boolean;
  /** Both sides of a whole-file conflict, for counting novel lines. */
  sides?: { ours: string | null; base: string | null; theirs: string | null };
}

export interface FileScope {
  path: string;
  /** Number of conflict regions (a whole-file conflict counts as one). */
  regions: number;
  /** Some edit is not explained by replacing conflict regions. */
  outside: boolean;
  /** Conflict markers remain in the resolved content. */
  unresolved: boolean;
  novelLines: number;
  /** Where the conflict regions ended up (head side), when that is known. */
  hunks: ConflictHunk[];
  /** Head-side ranges edited outside the conflict regions. */
  outsideHunks: ConflictHunk[];
  /** Why the file counts as outside, when it does. */
  why?: string;
}

export interface ResolutionScope {
  files: FileScope[];
  conflictHunks: ConflictHunk[];
  /** Head-side ranges edited outside any conflict region. */
  outsideHunks: ConflictHunk[];
  touchesOutsideConflictHunks: boolean;
  /** Paths with an edit outside their conflict regions (or that were not conflicted at all). */
  outsideFiles: string[];
  /** Conflicted paths whose resolved content still contains conflict markers. */
  unresolvedFiles: string[];
  novelLines: number;
  regions: number;
}

function key(line: string): string {
  return lineBody(line).trim();
}

/** Lines of `lines` whose trimmed body is non-empty and found in none of `known`. */
function countNovel(lines: readonly string[], known: Iterable<string>): number {
  const set = new Set<string>();
  for (const l of known) set.add(key(l));
  let n = 0;
  for (const l of lines) {
    const k = key(l);
    if (k !== "" && !set.has(k)) n++;
  }
  return n;
}

function startsAt(hay: readonly string[], needle: readonly string[], at: number): boolean {
  if (at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
  return true;
}

/** Leftmost index ≥ from where `needle` occurs and ends by `limit`, or -1. */
function indexOfSeq(
  hay: readonly string[],
  needle: readonly string[],
  from: number,
  limit: number,
): number {
  for (let i = from; i + needle.length <= limit; i++) if (startsAt(hay, needle, i)) return i;
  return -1;
}

/**
 * Where each conflict region's replacement lies in `resolved` ([start, end) line indexes), or
 * null when `resolved` is not "merged with regions replaced".
 */
export function matchRegions(
  segments: readonly ConflictSegment[],
  resolved: readonly string[],
): Array<[number, number]> | null {
  const cleans = segments.filter((s): s is CleanSegment => s.kind === "clean").map((s) => s.lines);
  if (cleans.length < 2) return null; // no region
  const first = cleans[0]!;
  const last = cleans[cleans.length - 1]!;
  if (!startsAt(resolved, first, 0)) return null;
  const suffixStart = resolved.length - last.length;
  if (suffixStart < first.length || !startsAt(resolved, last, suffixStart)) return null;
  const spans: Array<[number, number]> = [];
  let pos = first.length;
  for (let i = 1; i < cleans.length - 1; i++) {
    const seg = cleans[i]!;
    const at = indexOfSeq(resolved, seg, pos, suffixStart);
    if (at === -1) return null;
    spans.push([pos, at]);
    pos = at + seg.length;
  }
  if (pos > suffixStart) return null;
  spans.push([pos, suffixStart]);
  return spans;
}

function hunkFor(file: string, span: [number, number], total: number): ConflictHunk | null {
  const [s, e] = span;
  if (e > s) return { file, startLine: s + 1, endLine: e };
  if (total === 0) return null;
  // An empty replacement is anchored on the line that now follows it (or the last line).
  const line = Math.min(s + 1, total);
  return { file, startLine: line, endLine: line };
}

/** Changed line ranges of `after` versus `before` (head side), for reporting outside edits. */
function changedRanges(file: string, before: string[], after: string[]): ConflictHunk[] {
  const ops = diffLines(before, after);
  const out: ConflictHunk[] = [];
  let b = 0;
  let runStart = -1;
  let pendingDelete = false;
  const flush = (end: number) => {
    if (runStart !== -1) out.push({ file, startLine: runStart + 1, endLine: end });
    else if (pendingDelete && after.length > 0) {
      const line = Math.min(end + 1, after.length);
      out.push({ file, startLine: line, endLine: line });
    }
    runStart = -1;
    pendingDelete = false;
  };
  for (const o of ops) {
    if (o.op === "ins") {
      if (runStart === -1) runStart = b;
      b++;
    } else if (o.op === "del") pendingDelete = true;
    else {
      flush(b);
      b++;
    }
  }
  flush(b);
  return out;
}

function scopeOfFile(f: ResolvedFile, markers: ConflictMarkers): FileScope {
  const after = f.resolved === null ? [] : splitLines(f.resolved);
  const scope = (partial: Partial<FileScope>): FileScope => ({
    path: f.path,
    regions: 0,
    outside: false,
    unresolved: false,
    novelLines: 0,
    hunks: [],
    outsideHunks: [],
    ...partial,
  });
  if (!f.conflicted) {
    if (f.merged === f.resolved) return scope({});
    const before = f.merged === null ? [] : splitLines(f.merged);
    return scope({
      outside: true,
      why: "not in conflict",
      outsideHunks: changedRanges(f.path, before, after),
      novelLines: countNovel(after, before),
    });
  }
  const unresolved = f.resolved !== null && hasConflictMarkers(f.resolved, markers);
  const whole = (why?: string): FileScope => {
    const sides = f.sides ?? { ours: null, base: null, theirs: null };
    const known = [sides.ours, sides.base, sides.theirs, f.merged]
      .filter((t): t is string => t !== null)
      .flatMap(splitLines);
    const hunks: ConflictHunk[] =
      after.length > 0 ? [{ file: f.path, startLine: 1, endLine: after.length }] : [];
    const out = scope({ regions: 1, unresolved, novelLines: countNovel(after, known), hunks });
    if (why !== undefined) out.why = why;
    return out;
  };
  if (f.wholeFile || f.merged === null) return whole();
  const parsed = parseConflicts(f.merged, markers);
  if (!parsed.ok) {
    // We cannot tell where the regions were: count every edit as outside (unknown → escalate).
    return scope({
      regions: 1,
      outside: f.merged !== f.resolved,
      unresolved,
      why: `conflict markers could not be parsed (${parsed.reason} at line ${parsed.line})`,
      outsideHunks: changedRanges(f.path, splitLines(f.merged), after),
      novelLines: countNovel(after, splitLines(f.merged)),
    });
  }
  if (parsed.regions.length === 0) return whole();
  if (f.resolved === null) {
    const cleanLines = parsed.segments.some((s) => s.kind === "clean" && s.lines.length > 0);
    return scope({
      regions: parsed.regions.length,
      outside: cleanLines,
      ...(cleanLines ? { why: "deleted a file with lines outside its conflict regions" } : {}),
    });
  }
  const spans = matchRegions(parsed.segments, after);
  if (spans === null) {
    const merged = splitLines(f.merged);
    return scope({
      regions: parsed.regions.length,
      outside: true,
      unresolved,
      why: "edited lines outside the conflict regions",
      outsideHunks: changedRanges(f.path, merged, after),
      novelLines: countNovel(
        after,
        parsed.segments.flatMap((s) =>
          s.kind === "clean" ? s.lines : [...s.ours, ...(s.base ?? []), ...s.theirs],
        ),
      ),
    });
  }
  let novel = 0;
  const hunks: ConflictHunk[] = [];
  parsed.regions.forEach((r, i) => {
    const span = spans[i]!;
    novel += countNovel(after.slice(span[0], span[1]), [...r.ours, ...(r.base ?? []), ...r.theirs]);
    const h = hunkFor(f.path, span, after.length);
    if (h !== null) hunks.push(h);
  });
  return scope({ regions: parsed.regions.length, unresolved, novelLines: novel, hunks });
}

/**
 * Decide, mechanically, what a resolution touched. `files` lists every path the resolution or the
 * merge's conflicts involve; paths not marked conflicted that changed count as outside.
 */
export function resolutionScope(
  files: readonly ResolvedFile[],
  markers: ConflictMarkers = GIT_DEFAULT_MARKERS,
): ResolutionScope {
  const scopes = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => scopeOfFile(f, markers));
  const outsideFiles = scopes.filter((s) => s.outside).map((s) => s.path);
  return {
    files: scopes,
    conflictHunks: scopes.flatMap((s) => s.hunks),
    outsideHunks: scopes.flatMap((s) => s.outsideHunks),
    touchesOutsideConflictHunks: outsideFiles.length > 0,
    outsideFiles,
    unresolvedFiles: scopes.filter((s) => s.unresolved).map((s) => s.path),
    novelLines: scopes.reduce((n, s) => n + s.novelLines, 0),
    regions: scopes.reduce((n, s) => n + s.regions, 0),
  };
}

// ---------------------------------------------------------------- conflict-resolution items

/** Cut `diff` at a line boundary so it fits `maxBytes` UTF-8 bytes. */
export function capResolutionDiff(
  diff: string,
  maxBytes: number = RESOLUTION_DIFF_MAX_BYTES,
): { text: string; truncated: boolean } {
  const safe = wellFormed(diff);
  if (utf8Encode(safe).length <= maxBytes) return { text: safe, truncated: false };
  let bytes = 0;
  let out = "";
  for (const line of splitLines(safe)) {
    const n = utf8Encode(line).length;
    if (bytes + n > maxBytes) {
      if (out === "") {
        // A single line longer than the cap: cut it on a character boundary.
        let cut = "";
        for (const ch of line) {
          const c = utf8Encode(ch).length;
          if (bytes + c > maxBytes) break;
          cut += ch;
          bytes += c;
        }
        out = cut;
      }
      break;
    }
    out += line;
    bytes += n;
  }
  return { text: out, truncated: true };
}

export interface ResolverIdentity {
  model: string;
  principalId: string;
  promptVersion: string;
}

export interface ConflictResolutionInput {
  id?: string;
  upstreamChanges: readonly UpstreamChangeRef[];
  ontoSha?: string;
  scope: Pick<ResolutionScope, "conflictHunks" | "touchesOutsideConflictHunks" | "novelLines"> &
    Partial<Pick<ResolutionScope, "outsideHunks">>;
  /** The full resolution diff; it is capped here. */
  resolutionDiff: string;
  semanticConflictWith: string | null;
  failingTests?: readonly string[];
  rationale: string;
  resolver: ResolverIdentity;
  attempts: number;
}

function text(s: string, max: number): string {
  return truncate(wellFormed(s), max);
}

function upstreamList(list: readonly UpstreamChangeRef[]): UpstreamChangeRef[] {
  const seen = new Set<string>();
  const out: UpstreamChangeRef[] = [];
  for (const u of list) {
    if (seen.has(u.changeId)) continue;
    seen.add(u.changeId);
    out.push(u.planId === undefined ? { changeId: u.changeId, sha: u.sha } : { ...u });
  }
  return out.slice(0, 200);
}

/** A resolution that was produced and validated (status ok). */
export function conflictResolutionItem(input: ConflictResolutionInput): ConflictResolution {
  const diff = capResolutionDiff(input.resolutionDiff);
  const hunks = input.scope.conflictHunks.slice(0, 2000);
  // No regions to stay inside but something changed (semantic conflicts): that is outside.
  const outside =
    input.scope.touchesOutsideConflictHunks || (hunks.length === 0 && diff.text.trim() !== "");
  const item: ConflictResolution = {
    id: input.id ?? "conflict-resolution",
    kind: "conflict-resolution",
    status: "ok",
    upstreamChanges: upstreamList(input.upstreamChanges),
    conflictHunks: hunks,
    resolutionDiff: diff.text,
    truncated: diff.truncated,
    touchesOutsideConflictHunks: outside,
    novelLines: input.scope.novelLines,
    semanticConflictWith: input.semanticConflictWith,
    rationale: text(input.rationale, 4000),
    resolver: { ...input.resolver },
    attempts: input.attempts,
  };
  if (input.ontoSha !== undefined) item.ontoSha = input.ontoSha;
  const outsideHunks = input.scope.outsideHunks ?? [];
  if (outsideHunks.length > 0) item.outsideHunks = outsideHunks.slice(0, 2000);
  if (input.failingTests !== undefined)
    item.failingTests = input.failingTests.slice(0, 200).map((t) => text(t, 1000));
  return item;
}

export interface ConflictResolutionErrorInput {
  id?: string;
  note: string;
  upstreamChanges: readonly UpstreamChangeRef[];
  ontoSha?: string;
  semanticConflictWith?: string | null;
  failingTests?: readonly string[];
  rationale?: string;
  resolver: ResolverIdentity;
  attempts: number;
}

/** The resolver ran and failed: nothing of it can be trusted, so everything counts as outside. */
export function conflictResolutionError(input: ConflictResolutionErrorInput): ConflictResolution {
  const item: ConflictResolution = {
    id: input.id ?? "conflict-resolution",
    kind: "conflict-resolution",
    status: "error",
    note: text(input.note, 4000),
    upstreamChanges: upstreamList(input.upstreamChanges),
    conflictHunks: [],
    resolutionDiff: "",
    truncated: false,
    touchesOutsideConflictHunks: true,
    semanticConflictWith: input.semanticConflictWith ?? null,
    rationale: text(input.rationale ?? "", 4000),
    resolver: { ...input.resolver },
    attempts: input.attempts,
  };
  if (input.ontoSha !== undefined) item.ontoSha = input.ontoSha;
  if (input.failingTests !== undefined)
    item.failingTests = input.failingTests.slice(0, 200).map((t) => text(t, 1000));
  return item;
}

/** Internal consistency problems of a conflict-resolution item (empty when consistent). */
export function checkConflictResolution(item: ConflictResolution): string[] {
  const problems: string[] = [];
  if (item.status === "error" && !item.note) problems.push("an errored resolution has no note");
  if (
    item.status === "ok" &&
    !item.touchesOutsideConflictHunks &&
    item.conflictHunks.length === 0 &&
    item.resolutionDiff.trim() !== ""
  )
    problems.push("edits with no conflict hunks must count as outside the conflict hunks");
  if (
    item.semanticConflictWith !== null &&
    !item.upstreamChanges.some((u) => u.changeId === item.semanticConflictWith)
  )
    problems.push(`semanticConflictWith ${item.semanticConflictWith} is not an upstream change`);
  const ids = item.upstreamChanges.map((u) => u.changeId);
  if (new Set(ids).size !== ids.length) problems.push("duplicate upstream changes");
  if (utf8Encode(item.resolutionDiff).length > RESOLUTION_DIFF_MAX_BYTES)
    problems.push("resolutionDiff is over the size cap");
  return problems;
}

// ---------------------------------------------------------------- quarantine

export interface QuarantineInput {
  id?: string;
  quarantined: readonly QuarantinedTest[];
  /**
   * The Change's affected test targets (test ids, test files or gitignore-style globs).
   * null = the affected set is unknown, so every quarantined test counts as affected.
   */
  affected: { testTargets: readonly string[] } | null;
}

function inTargets(test: QuarantinedTest, targets: readonly string[]): boolean {
  for (const target of targets) {
    if (target === test.id || target === test.file) return true;
    try {
      if (matchPathPattern(target, test.file)) return true;
    } catch (e) {
      // A target we cannot evaluate might cover the test: unknown → affected.
      if (e instanceof GlobError || e instanceof SyntaxError) return true;
      throw e;
    }
  }
  return false;
}

/** The quarantine item for a merged-tree bundle. */
export function quarantineEvidence(input: QuarantineInput): Quarantine {
  const seen = new Set<string>();
  const tests: QuarantinedTest[] = [];
  for (const t of input.quarantined) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    tests.push({ ...t });
  }
  const inAffectedSet = tests
    .filter((t) => input.affected === null || inTargets(t, input.affected.testTargets))
    .map((t) => t.id);
  return {
    id: input.id ?? "quarantine",
    kind: "quarantine",
    status: "ok",
    ...(input.affected === null
      ? { note: "affected set unknown: every quarantined test counts as affected" }
      : {}),
    tests: tests.slice(0, 2000),
    inAffectedSet: inAffectedSet.slice(0, 2000),
  };
}

/** Internal consistency problems of a quarantine item (empty when consistent). */
export function checkQuarantine(item: Quarantine): string[] {
  const problems: string[] = [];
  const ids = new Set(item.tests.map((t) => t.id));
  if (ids.size !== item.tests.length) problems.push("duplicate quarantined test ids");
  for (const id of item.inAffectedSet)
    if (!ids.has(id)) problems.push(`inAffectedSet lists ${id}, which is not quarantined`);
  return problems;
}
