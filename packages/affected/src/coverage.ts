/**
 * Coverage maps from main's last full run: which repo files each test file executed.
 *
 * Accepted JSON shapes (validated):
 * 1. `{ "<testFile>": ["<coveredFile>", …] }`
 * 2. `{ "<testFile>": <istanbul coverage-final.json object> }` — one report per test file; a
 *    file counts as covered when any statement, function or branch counter is > 0
 * 3. `{ "format": "gittifacts.coverage-map", "version": 1, "commit"?: sha, "root"?: dir,
 *      "tests": <1 or 2> }`
 *
 * Paths may be absolute (CI checkout) or relative; they are matched to repo files exactly after
 * stripping `root`, else by unique suffix. Tests or files that match nothing are dropped and
 * counted.
 */
import { z } from "zod";
import { createFileMatcher } from "./paths.js";
import type { CoverageMap } from "./types.js";

export const COVERAGE_MAP_FORMAT = "gittifacts.coverage-map";

const Counter = z.union([z.number(), z.array(z.number())]);
const IstanbulFile = z
  .object({
    path: z.string().optional(),
    s: z.record(z.string(), z.number()).optional(),
    f: z.record(z.string(), z.number()).optional(),
    b: z.record(z.string(), Counter).optional(),
  })
  .passthrough();
const IstanbulFinal = z.record(z.string(), z.unknown());

const TestEntry = z.union([z.array(z.string()), IstanbulFinal]);
const PlainMap = z.record(z.string(), TestEntry);
const Wrapped = z.object({
  format: z.literal(COVERAGE_MAP_FORMAT),
  version: z.literal(1),
  commit: z.string().optional(),
  root: z.string().optional(),
  tests: PlainMap,
});

export class CoverageMapError extends Error {
  override readonly name = "CoverageMapError";
}

export interface ParsedCoverageMap {
  map: CoverageMap;
  notes: string[];
}

function anyHit(entry: unknown): boolean {
  const unwrapped =
    entry !== null && typeof entry === "object" && "data" in entry && !("s" in entry)
      ? (entry as { data: unknown }).data
      : entry;
  const f = IstanbulFile.safeParse(unwrapped);
  if (!f.success) return false;
  const counts = [
    ...Object.values(f.data.s ?? {}),
    ...Object.values(f.data.f ?? {}),
    ...Object.values(f.data.b ?? {}).flatMap((c) => (Array.isArray(c) ? c : [c])),
  ];
  return counts.some((c) => c > 0);
}

/** Covered file paths (as reported) of one test's entry. */
function coveredOf(entry: z.infer<typeof TestEntry>): string[] {
  if (Array.isArray(entry)) return entry;
  const out: string[] = [];
  for (const [key, file] of Object.entries(entry)) {
    if (anyHit(file)) {
      const p = (file as { path?: unknown }).path;
      out.push(typeof p === "string" ? p : key);
    }
  }
  return out;
}

/**
 * Parse and normalize a coverage map against the head tree's files. Throws
 * {@link CoverageMapError} when the document has none of the accepted shapes.
 */
export function parseCoverageMap(
  json: unknown,
  opts: { files: readonly string[]; root?: string },
): ParsedCoverageMap {
  let value = json;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new CoverageMapError(`coverage map is not JSON: ${(error as Error).message}`);
    }
  }
  let tests: z.infer<typeof PlainMap>;
  let commit: string | null = null;
  let root = opts.root;
  const wrapped = Wrapped.safeParse(value);
  if (wrapped.success) {
    tests = wrapped.data.tests;
    commit = wrapped.data.commit ?? null;
    root = wrapped.data.root ?? root;
  } else {
    const plain = PlainMap.safeParse(value);
    if (!plain.success || (value !== null && typeof value === "object" && "format" in value)) {
      throw new CoverageMapError(
        `coverage map must be { testFile: coveredFiles[] | coverage-final.json } or a ${COVERAGE_MAP_FORMAT} document`,
      );
    }
    tests = plain.data;
  }
  const match = createFileMatcher(opts.files, root);
  const out = new Map<string, Set<string>>();
  let droppedTests = 0;
  let droppedFiles = 0;
  for (const [testKey, entry] of Object.entries(tests)) {
    const test = match(testKey);
    if (test === undefined) {
      droppedTests++;
      continue;
    }
    const covered = out.get(test) ?? new Set<string>();
    for (const reported of coveredOf(entry)) {
      const file = match(reported);
      if (file === undefined) droppedFiles++;
      else covered.add(file);
    }
    out.set(test, covered);
  }
  const notes: string[] = [];
  if (droppedTests > 0) notes.push(`${droppedTests} test(s) in the map are not in the tree`);
  if (droppedFiles > 0) notes.push(`${droppedFiles} covered path(s) matched no file in the tree`);
  return { map: { tests: out, commit }, notes };
}

/** Build a CoverageMap directly (tests, simulators). */
export function coverageMapOf(
  tests: Record<string, readonly string[]>,
  commit: string | null = null,
): CoverageMap {
  const m = new Map<string, Set<string>>();
  for (const [t, files] of Object.entries(tests)) m.set(t, new Set(files));
  return { tests: m, commit };
}
