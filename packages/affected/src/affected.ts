/**
 * computeAffectedSet: touched files → module closure, test targets, public-API flag, Workers.
 *
 * Completeness (`complete`) is the AND of every analyzer report. It turns false when
 * - a touched file has no analyzer that understands its dependents (not a module the TS/JS
 *   analyzer scans, not docs/metadata/config/snapshot, and nothing imports it) — e.g. a data
 *   file read with `fs` or a shell script;
 * - the closure reaches a package with unresolvable incoming references (an import of a local
 *   package whose entry maps to no file, or an unresolved path alias inside it): importers of
 *   files there may be missing;
 * - an analyzer crashed, a scanned file was unreadable, or a wrangler config has no name.
 * An incomplete set still carries everything that could be computed, escalated: all tests,
 * `publicApi: true`, every known Worker.
 *
 * Config files (manifests, lockfiles, tsconfig, runner/bundler/lint configs, wrangler configs,
 * Dockerfiles, `.platform/**`) add {@link CONFIG_SENTINEL} to `modules` and select all tests;
 * the set stays complete.
 */

import { pathRulesAnalyzer } from "./analyzers/path-rules.js";
import { type TsPartialGraph, tsAnalyzer } from "./analyzers/ts.js";
import {
  configScope,
  isCodeFile,
  isConfigFile,
  isTestFile,
  isTestRunnerConfig,
  isTestSupportFile,
} from "./classify.js";
import { exportSurface, sameSurface } from "./exports.js";
import { ModuleGraph } from "./graph.js";
import { parseJsonc } from "./jsonc.js";
import { ancestors, baseName, dirOf, isUnder, sortedUnique } from "./paths.js";
import {
  type AffectedSet,
  ALL_TESTS,
  type Analyzer,
  type AnalyzerReport,
  CONFIG_SENTINEL,
  type CoverageMap,
  type FileChange,
  type PartialGraph,
  type RepoTree,
} from "./types.js";
import { discoverWorkers, isWorkerConfigFile, type WorkerConfig } from "./workers.js";

export const AFFECTED_VERSION = "1.0.0";

export interface ComputeInput {
  /** The tree the change produces (the commit being analyzed). */
  head: RepoTree;
  /**
   * The tree it is compared with. Only touched files are read from it (and only when they are
   * code or manifests): their previous imports and export surfaces.
   */
  base: RepoTree;
  changes: readonly FileChange[];
  /** Coverage map from main's last full run (see `parseCoverageMap`). */
  coverage?: CoverageMap | null;
  /** Notes from parsing the coverage map, or why it could not be used. */
  coverageNotes?: readonly string[];
  /** Defaults to {@link defaultAnalyzers}. */
  analyzers?: readonly Analyzer[];
  /**
   * A precise public-API verdict (from the `public-api` evidence item). When absent the cheap
   * exported-signature diff decides.
   */
  publicApi?: boolean | null;
  /** Caller notes (e.g. an unusable input), added to the `affected` report. */
  notes?: readonly string[];
}

export function defaultAnalyzers(): Analyzer[] {
  return [tsAnalyzer(), pathRulesAnalyzer()];
}

/** Should `path`'s content be loaded for `computeAffectedSet` (prefetch filter)? */
export function contentNeeded(
  path: string,
  analyzers: readonly Analyzer[] = defaultAnalyzers(),
): boolean {
  return (
    isWorkerConfigFile(path) ||
    baseName(path) === "package.json" ||
    analyzers.some((a) => a.reads(path))
  );
}

function isTsGraph(g: PartialGraph): g is TsPartialGraph {
  return "edgesFor" in g && "holes" in g;
}

const MAX_LISTED = 8;
function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join(", ");
  return paths.length > MAX_LISTED ? `${shown}, … (${paths.length})` : shown;
}

/** Config files that change what a Worker bundles (not lint/test-runner/CI configs). */
function affectsBuild(path: string): boolean {
  if (path.startsWith(".platform/")) return false;
  const base = baseName(path);
  return !/^(?:vitest|jest|playwright|stryker|eslint|prettier|biome)\b|^\.(?:eslintrc|prettierrc)|^Dockerfile|dockerignore$/.test(
    base,
  );
}

const MANIFEST_API_FIELDS = [
  "name",
  "exports",
  "main",
  "module",
  "types",
  "typings",
  "bin",
] as const;

function manifestApiChanged(base: string | null, head: string | null): boolean {
  if (base === null || head === null) return base !== head;
  const b = parseJsonc(base);
  const h = parseJsonc(head);
  if (b === null || h === null || typeof b !== "object" || typeof h !== "object") return true;
  const br = b as Record<string, unknown>;
  const hr = h as Record<string, unknown>;
  return MANIFEST_API_FIELDS.some((f) => JSON.stringify(br[f]) !== JSON.stringify(hr[f]));
}

export function computeAffectedSet(input: ComputeInput): AffectedSet {
  const { head, base } = input;
  const headFiles = new Set(head.files);
  const basePathOf = new Map<string, string>();
  const touchedList: string[] = [];
  for (const c of input.changes) {
    touchedList.push(c.path);
    if (c.oldPath !== undefined && c.oldPath !== null && c.oldPath !== c.path) {
      touchedList.push(c.oldPath);
      if (c.status === "renamed" || c.status === "copied") basePathOf.set(c.path, c.oldPath);
    }
  }
  const files = sortedUnique(touchedList);
  const deleted = new Set(files.filter((p) => !headFiles.has(p)));
  const reports: AnalyzerReport[] = [];
  const affectedNotes: string[] = [...(input.notes ?? [])];
  let affectedComplete = true;

  // ---- module graph
  const analyzers = input.analyzers ?? defaultAnalyzers();
  const graphs: PartialGraph[] = [];
  for (const a of analyzers) {
    if (!a.supports(head.files) && !a.supports(files)) continue;
    try {
      const g = a.analyze({ tree: head, deleted });
      graphs.push(g);
      const note = g.notes.join("; ");
      reports.push({
        name: a.name,
        version: a.version,
        complete: g.complete,
        ...(note === "" ? {} : { note }),
      });
    } catch (error) {
      reports.push({
        name: a.name,
        version: a.version,
        complete: false,
        note: `analyzer failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          500,
        ),
      });
    }
  }
  const graph = new ModuleGraph(graphs.flatMap((g) => g.edges));
  const analyzersOk = reports.every((r) => r.complete);

  // ---- Workers (their static assets have no module dependents: they only deploy)
  const discovery = discoverWorkers(
    [...head.files, ...[...deleted].filter(isWorkerConfigFile)],
    (p) => head.read(p) ?? base.read(p),
  );
  const isAsset = (p: string): boolean =>
    discovery.workers.some((w) => w.assets !== null && isUnder(p, w.assets));

  // ---- classification of touched files
  const configTouched = files.filter(isConfigFile);
  const unknown = files.filter(
    (p) =>
      !isConfigFile(p) &&
      !isAsset(p) &&
      !graphs.some((g) => g.understands(p)) &&
      graph.dependentsOf(p).size === 0,
  );
  if (unknown.length > 0) {
    affectedComplete = false;
    affectedNotes.push(`no analyzer understands the dependents of: ${listed(unknown)}`);
  }
  if (configTouched.length > 0)
    affectedNotes.push(`config changed (${listed(configTouched)}): ${CONFIG_SENTINEL}, all tests`);

  // ---- closure
  const closure = graph.reverseClosure(files);
  const tsGraphs = graphs.filter(isTsGraph);
  for (const g of tsGraphs) {
    for (const [dir, example] of g.holes) {
      const hit = [...closure].find((p) => isUnder(p, dir) && !deleted.has(p));
      if (hit !== undefined) {
        affectedComplete = false;
        affectedNotes.push(
          `closure reaches ${dir === "" ? "the root package" : dir}, which has unresolvable references (${example})`,
        );
      }
    }
  }

  // ---- new dependencies: targets of edges the change adds
  const added = new Set<string>();
  for (const g of tsGraphs) {
    for (const f of files) {
      if (!headFiles.has(f)) continue;
      const after = head.read(f);
      if (after === null) continue;
      const basePath = basePathOf.get(f) ?? f;
      const before = base.read(basePath);
      // The old version's imports resolve from where it lived (a moved file keeps its targets).
      const was = new Set(before === null ? [] : g.edgesFor(basePath, before));
      was.delete(f);
      for (const t of g.edgesFor(f, after)) if (!was.has(t)) added.add(t);
    }
  }

  const complete = analyzersOk && affectedComplete;
  const modules = new Set<string>(files);
  for (const p of closure) if (!isTestFile(p)) modules.add(p);
  for (const p of added) modules.add(p);
  if (configTouched.length > 0) modules.add(CONFIG_SENTINEL);

  // ---- test targets
  const testsAtHead = head.files.filter(isTestFile);
  const tests = selectTests({
    files,
    closure,
    graph,
    testsAtHead,
    headFiles,
    coverage: input.coverage ?? null,
    coverageNotes: input.coverageNotes ?? [],
    allTests: configTouched.length > 0 || !complete,
    allTestsWhy:
      configTouched.length > 0
        ? "config changed"
        : !complete
          ? "the module graph is incomplete"
          : "",
  });
  reports.push(tests.report);

  // ---- public API
  const api = publicApiCheck(input, files, deleted, basePathOf, graph, tsGraphs, complete);
  reports.push(api.report);

  // ---- Workers
  const deploys = deploysTo(
    discovery.workers,
    files,
    modules,
    configTouched,
    graph,
    head.files,
    complete,
  );
  reports.push({
    name: "workers",
    version: AFFECTED_VERSION,
    complete: discovery.problems.length === 0,
    note:
      `${discovery.workers.length} Worker(s): ${discovery.workers.map((w) => `${w.name} (${w.dir || "."})`).join(", ") || "none"}` +
      (discovery.problems.length > 0 ? `; problems: ${discovery.problems.join("; ")}` : ""),
  });

  reports.unshift({
    name: "affected",
    version: AFFECTED_VERSION,
    complete: affectedComplete,
    ...(affectedNotes.length > 0 ? { note: affectedNotes.join("; ") } : {}),
  });

  const allComplete = reports.every((r) => r.complete);
  return {
    files,
    modules: sortedUnique(modules),
    testTargets: allComplete || tests.targets[0] === ALL_TESTS ? tests.targets : [ALL_TESTS],
    publicApi: allComplete ? api.changed : true,
    deploysTo: allComplete ? deploys : sortedUnique(discovery.workers.map((w) => w.name)),
    complete: allComplete,
    analyzers: reports,
  };
}

// ---------------------------------------------------------------- tests

interface SelectInput {
  files: readonly string[];
  closure: ReadonlySet<string>;
  graph: ModuleGraph;
  testsAtHead: readonly string[];
  headFiles: ReadonlySet<string>;
  coverage: CoverageMap | null;
  coverageNotes: readonly string[];
  allTests: boolean;
  allTestsWhy: string;
}

export const TEST_IMPACT_NAME = "test-impact";

function selectTests(input: SelectInput): { targets: string[]; report: AnalyzerReport } {
  const report = (note: string): AnalyzerReport => ({
    name: TEST_IMPACT_NAME,
    version: AFFECTED_VERSION,
    complete: true,
    note,
  });
  const coverageNote = input.coverageNotes.length > 0 ? `; ${input.coverageNotes.join("; ")}` : "";
  if (input.allTests)
    return {
      targets: [ALL_TESTS],
      report: report(`all tests: ${input.allTestsWhy}${coverageNote}`),
    };

  const isTest = new Set(input.testsAtHead);
  const targets = new Set<string>();
  const notes: string[] = [];

  // Test-runner configs in the closure (a touched setup file): every test below the config.
  const runnerScopes = [...input.closure].filter(
    (p) => isTestRunnerConfig(p) && !input.files.includes(p),
  );
  for (const cfg of runnerScopes) {
    const scope = configScope(cfg);
    if (scope === "")
      return {
        targets: [ALL_TESTS],
        report: report(`all tests: ${cfg} loads a touched file${coverageNote}`),
      };
    for (const t of input.testsAtHead) if (isUnder(t, scope)) targets.add(t);
    notes.push(`all tests under ${scope}/ (${cfg} loads a touched file)`);
  }

  // Touched tests always run.
  for (const f of input.files) if (isTest.has(f)) targets.add(f);

  const staticTargets = [...input.closure].filter((p) => isTest.has(p));
  if (input.coverage === null) {
    for (const t of staticTargets) targets.add(t);
    notes.unshift(`static: ${staticTargets.length} test file(s) import the closure`);
    return { targets: sortedUnique(targets), report: report(notes.join("; ") + coverageNote) };
  }

  // Coverage map first: the tests that executed a touched file on main. A test reaches a
  // change only by executing the changed code, so dependents need no coverage of their own.
  // Static analysis covers what the map cannot know: touched files no test executed on main
  // (new files, data files, files without statements) and test files missing from the map.
  const map = input.coverage.tests;
  const known = new Set<string>();
  for (const covered of map.values()) for (const f of covered) known.add(f);
  const touchedSource = input.files.filter((p) => !isTest.has(p) && !isTestFile(p));
  let byCoverage = 0;
  for (const [test, covered] of map) {
    if (!input.headFiles.has(test)) continue;
    if (touchedSource.some((p) => covered.has(p))) {
      targets.add(test);
      byCoverage++;
    }
  }
  const unseen = touchedSource.filter((p) => !known.has(p));
  let byStatic = 0;
  if (unseen.length > 0) {
    for (const p of input.graph.reverseClosure(unseen)) {
      if (isTest.has(p) && !targets.has(p)) {
        targets.add(p);
        byStatic++;
      }
    }
  }
  let newTests = 0;
  for (const t of staticTargets) {
    if (!map.has(t) && !targets.has(t)) {
      targets.add(t);
      newTests++;
    }
  }
  notes.unshift(
    `coverage map${input.coverage.commit === null ? "" : ` @${input.coverage.commit.slice(0, 12)}`} (${map.size} tests): ${byCoverage} by coverage` +
      (unseen.length > 0
        ? `, ${byStatic} by static fallback for ${unseen.length} touched file(s) no test executed on main`
        : "") +
      (newTests > 0 ? `, ${newTests} test file(s) missing from the map` : "") +
      ` (static alone: ${staticTargets.length})`,
  );
  return { targets: sortedUnique(targets), report: report(notes.join("; ") + coverageNote) };
}

// ---------------------------------------------------------------- public API

function publicApiCheck(
  input: ComputeInput,
  files: readonly string[],
  deleted: ReadonlySet<string>,
  basePathOf: ReadonlyMap<string, string>,
  graph: ModuleGraph,
  tsGraphs: readonly TsPartialGraph[],
  complete: boolean,
): { changed: boolean; report: AnalyzerReport } {
  const report = (complete: boolean, note: string): AnalyzerReport => ({
    name: "public-api",
    version: AFFECTED_VERSION,
    complete,
    note,
  });
  if (input.publicApi !== undefined && input.publicApi !== null) {
    return { changed: input.publicApi, report: report(true, "from the public-api evidence item") };
  }
  const ts = tsGraphs[0];
  if (ts === undefined) {
    return { changed: !complete, report: report(true, "no TS/JS packages") };
  }
  const reasons: string[] = [];
  for (const f of files) {
    if (baseName(f) !== "package.json") continue;
    if (manifestApiChanged(input.base.read(basePathOf.get(f) ?? f), input.head.read(f)))
      reasons.push(`${f}: entry fields changed`);
  }
  // Package entry points → everything they (transitively) import.
  const entries = new Set<string>();
  for (const pkg of ts.resolver.packages.values()) {
    if (isTestSupportFile(`${pkg.dir}/x`) && pkg.dir !== "") continue;
    const exp = pkg.manifest.exports;
    const subpaths =
      exp !== null &&
      typeof exp === "object" &&
      !Array.isArray(exp) &&
      Object.keys(exp).every((k) => k.startsWith("."))
        ? Object.keys(exp)
        : ["."];
    for (const sub of subpaths) {
      if (sub.includes("*") || sub.endsWith("package.json")) continue;
      for (const e of ts.resolver.packageEntry(pkg, sub) ?? []) entries.add(e);
    }
  }
  const reachable = graph.forwardClosure(entries);
  for (const f of files) {
    if (!isCodeFile(f) || isTestSupportFile(f) || deleted.has(f) || !reachable.has(f)) continue;
    const after = input.head.read(f);
    const before = input.base.read(basePathOf.get(f) ?? f);
    if (after === null) continue;
    if (before === null) {
      if (exportSurface(after).size > 0) reasons.push(`${f}: new exported module`);
      continue;
    }
    if (!sameSurface(exportSurface(before), exportSurface(after)))
      reasons.push(`${f}: exported signatures changed`);
  }
  return {
    changed: reasons.length > 0,
    report: report(
      true,
      reasons.length > 0
        ? `exported-signature diff: ${listed(reasons)}`
        : `exported-signature diff: no change reachable from ${entries.size} entry point(s)`,
    ),
  };
}

// ---------------------------------------------------------------- Workers

function deploysTo(
  workers: readonly WorkerConfig[],
  files: readonly string[],
  modules: ReadonlySet<string>,
  configTouched: readonly string[],
  graph: ModuleGraph,
  allFiles: readonly string[],
  complete: boolean,
): string[] {
  if (!complete) return sortedUnique(workers.map((w) => w.name));
  const out = new Set<string>();
  // Build-affecting config: every non-test file under its scope counts as touched.
  const configSeeds = new Set<string>();
  let rootConfig = false;
  for (const c of configTouched) {
    if (!affectsBuild(c)) continue;
    const scope = configScope(c);
    if (scope === "") rootConfig = true;
    else
      for (const f of allFiles) if (isUnder(f, scope) && !isTestSupportFile(f)) configSeeds.add(f);
  }
  const configReach = configSeeds.size > 0 ? graph.reverseClosure(configSeeds) : new Set<string>();
  const manifests = new Set(allFiles.filter((f) => baseName(f) === "package.json").map(dirOf));
  for (const w of workers) {
    // A container image built from a directory of the repo ships that directory's code.
    const roots = [w.dir, ...w.containers];
    // An assets directory that is a build output (nothing tracked under it) belongs to the
    // package that builds it: its sources deploy with this Worker.
    if (w.assets !== null && !allFiles.some((f) => isUnder(f, w.assets ?? ""))) {
      const pkg = ancestors(`${w.assets}/x`).find((d) => manifests.has(d));
      if (pkg !== undefined && pkg !== "" && !isUnder(w.dir, pkg)) roots.push(pkg);
    }
    const inWorker = (p: string): boolean =>
      roots.some((r) => isUnder(p, r)) && !isTestSupportFile(p);
    if (
      rootConfig ||
      files.includes(w.config) ||
      (w.main !== null && modules.has(w.main)) ||
      (w.assets !== null && files.some((f) => isUnder(f, w.assets ?? ""))) ||
      [...modules].some(inWorker) ||
      [...configReach].some(inWorker)
    )
      out.add(w.name);
  }
  return sortedUnique(out);
}
