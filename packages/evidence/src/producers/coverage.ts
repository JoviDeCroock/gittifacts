/**
 * Changed-line coverage from LCOV text and/or istanbul `coverage-final.json`.
 *
 * Only executable lines count: a changed line is executable iff the coverage map has
 * an entry for it. Changed lines with no entry (comments, types, blank lines) are
 * ignored. A changed file with no entry at all is listed in `unmeasuredFiles` and,
 * by default, contributes nothing — pass `treatMissingAsUncovered` to count such
 * files' changed lines as executable and uncovered instead.
 */
import { z } from "zod";
import type { CoverageDelta } from "../schema.js";
import { ProducerInputError } from "./errors.js";
import { createPathResolver } from "./paths.js";

/** file path (as reported) → line → hit count. */
export type CoverageMap = Map<string, Map<number, number>>;

function addHits(
  map: CoverageMap,
  file: string,
  line: number,
  hits: number,
  merge: "sum" | "max",
): void {
  let lines = map.get(file);
  if (!lines) {
    lines = new Map();
    map.set(file, lines);
  }
  const prev = lines.get(line);
  const h = Number.isFinite(hits) && hits > 0 ? hits : 0;
  lines.set(line, prev === undefined ? h : merge === "sum" ? prev + h : Math.max(prev, h));
}

/** Parse LCOV tracefile text (`SF:`/`DA:`/`end_of_record`). Repeated records for a file are summed. */
export function parseLcov(text: string): CoverageMap {
  const map: CoverageMap = new Map();
  let file: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3);
      if (!map.has(file)) map.set(file, new Map());
    } else if (line === "end_of_record") {
      file = null;
    } else if (line.startsWith("DA:") && file !== null) {
      const [ln, hits] = line.slice(3).split(",");
      const n = Number(ln);
      if (Number.isInteger(n) && n > 0) addHits(map, file, n, Number(hits), "sum");
    }
  }
  return map;
}

const Position = z.object({ line: z.number().int() });
const IstanbulFile = z.object({
  path: z.string().optional(),
  statementMap: z.record(z.string(), z.object({ start: Position })),
  s: z.record(z.string(), z.number()),
});
const IstanbulFinal = z.record(z.string(), z.unknown());

/**
 * Parse istanbul `coverage-final.json` (object or JSON text). Line hits follow
 * istanbul's own `getLineCoverage`: each statement counts on its start line, max wins.
 */
export function parseIstanbul(json: unknown): CoverageMap {
  let value = json;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      throw new ProducerInputError(`coverage-final.json is not JSON: ${(e as Error).message}`);
    }
  }
  const top = IstanbulFinal.safeParse(value);
  if (!top.success)
    throw new ProducerInputError("coverage-final.json must be an object keyed by file");
  const map: CoverageMap = new Map();
  for (const [key, entry] of Object.entries(top.data)) {
    // Some writers wrap each file as { data: {...} }.
    const unwrapped =
      entry !== null && typeof entry === "object" && "data" in entry && !("statementMap" in entry)
        ? (entry as { data: unknown }).data
        : entry;
    const f = IstanbulFile.safeParse(unwrapped);
    if (!f.success)
      throw new ProducerInputError(
        `coverage-final.json entry ${key} is not istanbul file coverage`,
      );
    const file = f.data.path ?? key;
    if (!map.has(file)) map.set(file, new Map());
    for (const [id, stmt] of Object.entries(f.data.statementMap)) {
      const count = f.data.s[id];
      if (stmt.start.line > 0) addHits(map, file, stmt.start.line, count ?? 0, "max");
    }
  }
  return map;
}

/** Union of several maps; a line is covered if any input covered it. */
export function mergeCoverage(...maps: CoverageMap[]): CoverageMap {
  const out: CoverageMap = new Map();
  for (const m of maps) {
    for (const [file, lines] of m) {
      if (!out.has(file)) out.set(file, new Map());
      for (const [line, hits] of lines) addHits(out, file, line, hits, "max");
    }
  }
  return out;
}

export interface ChangedLineCoverageOptions {
  id?: string;
  /** Prefix to strip from report paths (e.g. the CI checkout dir). */
  root?: string;
  /** For changed files absent from the report: return true to count them as uncovered. */
  treatMissingAsUncovered?: (path: string) => boolean;
  logRef?: string;
}

const MAX_UNCOVERED = 2000;

export function changedLineCoverage(
  coverage: CoverageMap,
  changedLines: Readonly<Record<string, readonly number[]>>,
  opts: ChangedLineCoverageOptions = {},
): CoverageDelta {
  const resolve = createPathResolver(coverage.keys(), opts.root);
  const files: CoverageDelta["files"] = [];
  const unmeasured: string[] = [];
  let changed = 0;
  let covered = 0;
  let anyChanged = false;

  for (const path of Object.keys(changedLines).sort()) {
    const lines = [...new Set(changedLines[path] ?? [])].sort((a, b) => a - b);
    if (lines.length === 0) continue;
    anyChanged = true;
    const key = resolve(path);
    const hits = key === undefined ? undefined : coverage.get(key);
    if (hits === undefined) {
      unmeasured.push(path);
      if (opts.treatMissingAsUncovered?.(path)) {
        files.push({
          path,
          changed: lines.length,
          covered: 0,
          uncoveredLines: lines.slice(0, MAX_UNCOVERED),
        });
        changed += lines.length;
      }
      continue;
    }
    let fileChanged = 0;
    let fileCovered = 0;
    const uncovered: number[] = [];
    for (const line of lines) {
      const h = hits.get(line);
      if (h === undefined) continue; // not executable
      fileChanged++;
      if (h > 0) fileCovered++;
      else uncovered.push(line);
    }
    if (fileChanged === 0) continue;
    files.push({
      path,
      changed: fileChanged,
      covered: fileCovered,
      uncoveredLines: uncovered.slice(0, MAX_UNCOVERED),
    });
    changed += fileChanged;
    covered += fileCovered;
  }

  const item: CoverageDelta = {
    id: opts.id ?? "coverage",
    kind: "coverage",
    status: "ok",
    changedLines: changed,
    coveredChangedLines: covered,
    ratio: changed === 0 ? 1 : covered / changed,
    files,
  };
  if (unmeasured.length > 0) item.unmeasuredFiles = unmeasured.slice(0, MAX_UNCOVERED);
  if (coverage.size === 0 && anyChanged) {
    item.status = "error";
    item.note = "coverage report contains no files; cannot measure changed-line coverage";
  }
  if (opts.logRef !== undefined) item.logRef = opts.logRef;
  return item;
}
