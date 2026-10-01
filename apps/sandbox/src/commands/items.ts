/** Small helpers for building evidence items honestly. */
import type {
  CoverageDelta,
  DependencyDiff,
  MutationScore,
  PublicApiDiff,
  SensitivePathHits,
  TestRun,
} from "@app/evidence";

const MAX_NOTE = 4000;

/** Join notes into one item note (deduplicated, capped at the schema limit). */
export function joinNotes(notes: readonly (string | null | undefined)[]): string | undefined {
  const parts = [
    ...new Set(notes.filter((n): n is string => typeof n === "string" && n.trim() !== "")),
  ];
  if (parts.length === 0) return undefined;
  const text = parts.join("; ");
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text;
}

/** Attach a note (merging with an existing one). */
export function withNote<T extends { note?: string | undefined }>(
  item: T,
  ...notes: (string | null | undefined)[]
): T {
  const note = joinNotes([item.note, ...notes]);
  if (note === undefined) return item;
  return { ...item, note };
}

const capped = (note: string): string =>
  note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE - 1)}…` : note;

export function coverageError(note: string): CoverageDelta {
  return {
    id: "coverage",
    kind: "coverage",
    status: "error",
    note: capped(note),
    changedLines: 0,
    coveredChangedLines: 0,
    ratio: 0,
    files: [],
  };
}

export function mutationError(note: string, tool = "stryker"): MutationScore {
  return {
    id: "mutation",
    kind: "mutation",
    status: "error",
    note: capped(note),
    tool,
    files: [],
    killed: 0,
    survived: 0,
    timedOut: 0,
    noCoverage: 0,
    score: 0,
    survivors: [],
  };
}

export function publicApiError(note: string): PublicApiDiff {
  // "breaking" so that a consumer that ignores `status` still errs on the side of caution.
  return {
    id: "public-api",
    kind: "public-api",
    status: "error",
    note: capped(note),
    classification: "breaking",
    packages: [],
  };
}

export function dependenciesError(note: string): DependencyDiff {
  return {
    id: "dependencies",
    kind: "dependencies",
    status: "error",
    note: capped(note),
    added: [],
    removed: [],
    changed: [],
    newInstallScripts: [],
    lockfileChanged: false,
  };
}

export function sensitiveError(note: string, patterns: string[] = []): SensitivePathHits {
  return {
    id: "sensitive-paths",
    kind: "sensitive-paths",
    status: "error",
    note: capped(note),
    patterns,
    hits: [],
  };
}

export function testRunError(sha: string, note: string, runner = "unknown"): TestRun {
  return {
    id: "test-run",
    kind: "test-run",
    status: "error",
    note: capped(note),
    sha,
    step: "test",
    runner,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    failures: [],
  };
}
