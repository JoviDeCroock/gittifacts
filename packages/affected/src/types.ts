/**
 * The AffectedSet contract (consumed by the merge-queue core) and the pluggable analyzer API.
 */
import { z } from "zod";

/**
 * `modules` sentinel: a config file (package.json, lockfile, tsconfig, test-runner config,
 * `.platform/**`, wrangler config, …) changed. The change can affect any module, so the queue
 * must treat it as conflicting with every other entry. `complete` stays true: the analysis
 * itself succeeded; the answer is "everything".
 */
export const CONFIG_SENTINEL = "*config*";

/** `testTargets` value meaning "every test in the repository". */
export const ALL_TESTS = "*";

export const AnalyzerReport = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  complete: z.boolean(),
  note: z.string().optional(),
});
export type AnalyzerReport = z.infer<typeof AnalyzerReport>;

export const AffectedSet = z.object({
  /** Touched files (both sides of renames), repo-relative, sorted. */
  files: z.array(z.string()),
  /**
   * Touched files, plus their reverse-dependency closure in the module graph (test files
   * excluded: they are `testTargets`), plus the direct targets of import edges the change adds
   * (a new caller of an existing module overlaps changes to that module). May contain
   * {@link CONFIG_SENTINEL}. Sorted.
   */
  modules: z.array(z.string()),
  /** Test files covering the closure, sorted; `["*"]` = all tests. */
  testTargets: z.array(z.string()),
  /** The change alters an exported signature reachable from a package entry point. */
  publicApi: z.boolean(),
  /** Worker names (wrangler `name`) whose package the change reaches, sorted. */
  deploysTo: z.array(z.string()),
  /** false = unknown/uncomputable: the queue treats it as conflicting with everything. */
  complete: z.boolean(),
  analyzers: z.array(AnalyzerReport),
});
export type AffectedSet = z.infer<typeof AffectedSet>;

/** A repository tree: its file list and lazy content access. */
export interface RepoTree {
  /** Every file (blob) path, repo-relative POSIX. */
  readonly files: readonly string[];
  /** Text content, or null when absent, binary or not loaded. */
  read(path: string): string | null;
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface FileChange {
  status: ChangeStatus;
  /** Head path (for `deleted`: the base path). */
  path: string;
  /** Base path of a rename or copy. */
  oldPath?: string | null;
}

/** An import-like dependency edge: `from` depends on `to`. */
export interface Edge {
  from: string;
  to: string;
}

export interface AnalyzerContext {
  /** The head tree. */
  tree: RepoTree;
  /** Files that exist only at base (deleted by the change). Valid import targets as a fallback. */
  deleted: ReadonlySet<string>;
}

export interface PartialGraph {
  /** Dependency edges this analyzer found (targets are files of the head tree or `deleted`). */
  edges: Edge[];
  /**
   * Is every dependent of `path` represented by an edge into it (from this or any analyzer)?
   * The TS/JS analyzer says yes for module files: anything that can depend on a module does
   * so through an import it scans.
   */
  understands(path: string): boolean;
  /** Files of the tree whose outgoing edges this analyzer determined. */
  scanned: number;
  /** false when the analyzer could not do its job (a crash, an unreadable config). */
  complete: boolean;
  notes: string[];
}

/** A pluggable dependency analyzer (one per language / file family). */
export interface Analyzer {
  readonly name: string;
  readonly version: string;
  /** Does this analyzer have anything to say about a tree with these files? */
  supports(files: readonly string[]): boolean;
  /** Should `path`'s content be loaded for this analyzer? (Lets callers prefetch only that.) */
  reads(path: string): boolean;
  analyze(ctx: AnalyzerContext): PartialGraph;
}

/** Normalized coverage map: test file → repo files it executed (from main's last full run). */
export interface CoverageMap {
  tests: ReadonlyMap<string, ReadonlySet<string>>;
  /** Commit the map was produced on, when known. */
  commit: string | null;
}
