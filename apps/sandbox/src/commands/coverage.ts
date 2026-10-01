/**
 * `evidence coverage`: changed-line coverage of the head commit.
 *
 * Runs the whole test suite once with coverage restricted (`include`) to the changed source
 * files, so a changed file that no test loads is reported as uncovered instead of being absent.
 * The istanbul JSON is intersected with the changed head lines by the pure producer.
 *
 * vitest: `--coverage.provider=v8`. vitest imports `@vitest/coverage-v8` by name, in the main
 * process AND in every worker, resolving it from vitest's own location. If the repository's
 * vitest can already resolve one (its own devDependency, or hoisted), that one is used.
 * Otherwise the runner links ITS copy at `<checkout>/node_modules/@vitest/coverage-v8` for the
 * duration of the run (removed afterwards); vitest's lookup from inside node_modules walks up
 * to that directory in npm, yarn and pnpm layouts alike. (A `custom` provider module path is
 * not enough: workers still import the package by name.)
 * jest: its built-in istanbul coverage.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { type CoverageDelta, changedLineCoverage, parseIstanbul } from "@app/evidence";
import { loadChanges } from "../lib/changes.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { errorMessage, log } from "../lib/log.js";
import { measuredChangedLines } from "../lib/patterns.js";
import { detectTestRunner, runTests, type TestRunner } from "../lib/test-runner.js";
import { coverageV8Module, findPackageDir, majorMinor, versionOf } from "../lib/tools.js";
import { coverageError, joinNotes, withNote } from "./items.js";

interface CoverageSetup {
  args: string[];
  reportFile: string;
  notes: string[];
  /** Undo whatever the setup changed in the checkout. */
  cleanup: () => void;
}

function escapeGlob(path: string): string {
  return path.replace(/[*?[\]{}()!]/g, "\\$&");
}

const noop = () => {};

/** Make `@vitest/coverage-v8` resolvable for the repository's vitest; see the module docs. */
function provideCoverageV8(
  repo: string,
  runner: TestRunner,
): { notes: string[]; cleanup: () => void } | { error: string } {
  const vitestDir = findPackageDir("vitest", repo);
  const existing = vitestDir === null ? null : findPackageDir("@vitest/coverage-v8", vitestDir);
  if (existing !== null) {
    const version = versionOf(existing);
    const notes = [
      `provider: @vitest/coverage-v8@${version ?? "?"} resolved by the repository's vitest`,
    ];
    if (majorMinor(version) !== majorMinor(runner.version))
      notes.push(
        `version skew: vitest ${runner.version ?? "?"} with @vitest/coverage-v8 ${version ?? "?"}`,
      );
    return { notes, cleanup: noop };
  }
  const ours = coverageV8Module();
  if (ours === null) return { error: "the runner's @vitest/coverage-v8 is not installed" };
  const nodeModules = join(repo, "node_modules");
  let isRealDir = false;
  try {
    const st = lstatSync(nodeModules);
    isRealDir = st.isDirectory() && !st.isSymbolicLink();
  } catch {
    isRealDir = false;
  }
  if (!isRealDir) {
    return {
      error: `cannot provide @vitest/coverage-v8: ${nodeModules} is not a directory the runner may write to`,
    };
  }
  const scope = join(nodeModules, "@vitest");
  const createdScope = !existsSync(scope);
  const link = join(scope, "coverage-v8");
  mkdirSync(scope, { recursive: true });
  symlinkSync(ours.dir, link, "dir");
  log(
    `coverage: linked the runner's @vitest/coverage-v8@${ours.version ?? "?"} into node_modules for this run`,
  );
  const notes = [
    `provider: gittifacts-runner's @vitest/coverage-v8@${ours.version ?? "?"} (the repository has none)`,
  ];
  if (majorMinor(ours.version) !== majorMinor(runner.version))
    notes.push(
      `version skew: vitest ${runner.version ?? "?"} with @vitest/coverage-v8 ${ours.version ?? "?"}`,
    );
  return {
    notes,
    cleanup: () => {
      rmSync(link, { force: true });
      if (createdScope) {
        try {
          rmdirSync(scope);
        } catch {
          // Not empty: something else was installed meanwhile.
        }
      }
    },
  };
}

function coverageSetup(
  repo: string,
  runner: TestRunner,
  files: readonly string[],
  dir: string,
): CoverageSetup | { error: string } {
  if (runner.kind === "jest") {
    return {
      args: [
        "--coverage",
        "--coverageReporters=json",
        `--coverageDirectory=${dir}`,
        ...files.map((f) => `--collectCoverageFrom=${escapeGlob(f)}`),
      ],
      reportFile: join(dir, "coverage-final.json"),
      notes: ["provider: jest (istanbul)"],
      cleanup: noop,
    };
  }
  const provided = provideCoverageV8(repo, runner);
  if ("error" in provided) return provided;
  return {
    args: [
      "--coverage.enabled=true",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${dir}`,
      "--coverage.reportOnFailure=true",
      "--coverage.clean=true",
      ...files.map((f) => `--coverage.include=${escapeGlob(f)}`),
    ],
    reportFile: join(dir, "coverage-final.json"),
    notes: provided.notes,
    cleanup: provided.cleanup,
  };
}

export async function coverage(ctx: Context): Promise<CoverageDelta> {
  const changes = await loadChanges(ctx);
  const changed = measuredChangedLines(changes.diff.changedLines);
  const files = Object.keys(changed).sort();
  if (files.length === 0) {
    return withNote(
      changedLineCoverage(new Map(), {}),
      "no changed lines in measured source files (tests, docs, configs and .platform/ are not measured)",
    );
  }
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return coverageError(wd.error);
  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  if (!detected.ok) return coverageError(detected.reason);
  const runner = detected.runner;
  const dir = join(ctx.tmp, "coverage");
  let setup: CoverageSetup | { error: string };
  try {
    setup = coverageSetup(ctx.repo, runner, files, dir);
  } catch (error) {
    return coverageError(`preparing coverage failed: ${errorMessage(error)}`);
  }
  if ("error" in setup) return coverageError(setup.error);
  let result: Awaited<ReturnType<typeof runTests>>;
  try {
    result = await runTests({
      runner,
      dir: ctx.repo,
      reportPath: join(ctx.tmp, "coverage-tests.json"),
      extraArgs: setup.args,
    });
  } finally {
    setup.cleanup();
  }
  const notes = [...setup.notes];
  if (result.timedOut)
    return coverageError(joinNotes(["the test run timed out", ...notes]) ?? "timed out");
  if (!existsSync(setup.reportFile)) {
    return coverageError(
      joinNotes([
        `no coverage report was written (exit ${result.exitCode}): ${result.error ?? result.outputTail}`,
        ...notes,
      ]) ?? "no report",
    );
  }
  if (!result.ok)
    return coverageError(
      joinNotes([`test results unreadable: ${result.error ?? "unknown"}`, ...notes]) ??
        "unreadable",
    );
  const failed = result.tests.filter((t) => t.outcome === "fail").length;
  const broken = result.files.filter((f) => f.loadError !== null).length;
  if (failed > 0 || broken > 0) {
    notes.push(`measured while ${failed} test(s) failed and ${broken} test file(s) did not load`);
  } else if (result.exitCode !== 0) {
    // Every test passed but the runner failed: e.g. the coverage provider crashed in a worker,
    // which leaves an all-zero report behind. That is not a measurement.
    return coverageError(
      joinNotes([
        `${runner.kind} exited ${result.exitCode} although every test passed: ${result.outputTail}`,
        ...notes,
      ]) ?? "runner failed",
    );
  }
  try {
    const map = parseIstanbul(readFileSync(setup.reportFile, "utf8"));
    const item = changedLineCoverage(map, changed, { root: realpathSync(ctx.repo) });
    if (item.unmeasuredFiles !== undefined) {
      notes.push(
        `not in the coverage report (counted as non-executable): ${item.unmeasuredFiles.join(", ")}`,
      );
    }
    return withNote(item, ...notes, wd.note);
  } catch (error) {
    return coverageError(
      joinNotes([`could not read the coverage report: ${errorMessage(error)}`, ...notes]) ??
        "unreadable report",
    );
  }
}
