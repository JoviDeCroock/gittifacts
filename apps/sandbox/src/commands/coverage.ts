/**
 * `evidence coverage`: changed-line coverage of the head commit.
 *
 * Runs the whole test suite once with coverage restricted (`include`) to the changed source
 * files, so a changed file that no test loads is reported as uncovered instead of being absent.
 * vitest: the repository's `@vitest/coverage-v8` when it has one, else ours through
 * `--coverage.provider=custom --coverage.customProviderModule=<our @vitest/coverage-v8>`.
 * jest: its built-in istanbul coverage. The istanbul JSON is intersected with the changed head
 * lines by the pure producer.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type CoverageDelta, changedLineCoverage, parseIstanbul } from "@app/evidence";
import { loadChanges } from "../lib/changes.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { errorMessage } from "../lib/log.js";
import { measuredChangedLines } from "../lib/patterns.js";
import { detectTestRunner, runTests, type TestRunner } from "../lib/test-runner.js";
import { coverageV8Module, majorMinor, repoTool } from "../lib/tools.js";
import { coverageError, joinNotes, withNote } from "./items.js";

interface CoverageArgs {
  args: string[];
  reportFile: string;
  notes: string[];
}

function escapeGlob(path: string): string {
  return path.replace(/[*?[\]{}()!]/g, "\\$&");
}

function coverageArgs(repo: string, runner: TestRunner, files: readonly string[], dir: string): CoverageArgs | { error: string } {
  const notes: string[] = [];
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
    };
  }
  const providerArgs: string[] = [];
  const own = repoTool("@vitest/coverage-v8", repo);
  if (own !== null) {
    providerArgs.push("--coverage.provider=v8");
    notes.push(`provider: the repository's @vitest/coverage-v8@${own.version ?? "?"}`);
  } else {
    const ours = coverageV8Module();
    if (ours === null) return { error: "the runner's @vitest/coverage-v8 is not installed" };
    providerArgs.push("--coverage.provider=custom", `--coverage.customProviderModule=${ours.entry}`);
    notes.push(`provider: gittifacts-runner's @vitest/coverage-v8@${ours.version ?? "?"}`);
    if (majorMinor(ours.version) !== majorMinor(runner.version)) {
      notes.push(`version skew: vitest ${runner.version ?? "?"} with @vitest/coverage-v8 ${ours.version ?? "?"}`);
    }
  }
  return {
    args: [
      "--coverage.enabled=true",
      ...providerArgs,
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${dir}`,
      "--coverage.reportOnFailure=true",
      "--coverage.clean=true",
      ...files.map((f) => `--coverage.include=${escapeGlob(f)}`),
    ],
    reportFile: join(dir, "coverage-final.json"),
    notes,
  };
}

export async function coverage(ctx: Context): Promise<CoverageDelta> {
  const changes = await loadChanges(ctx);
  const changed = measuredChangedLines(changes.diff.changedLines);
  const files = Object.keys(changed).sort();
  if (files.length === 0) {
    return withNote(changedLineCoverage(new Map(), {}), "no changed lines in measured source files (tests, docs, configs and .platform/ are not measured)");
  }
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return coverageError(wd.error);
  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  if (!detected.ok) return coverageError(detected.reason);
  const runner = detected.runner;
  const dir = join(ctx.tmp, "coverage");
  const cov = coverageArgs(ctx.repo, runner, files, dir);
  if ("error" in cov) return coverageError(cov.error);

  const result = await runTests({ runner, dir: ctx.repo, reportPath: join(ctx.tmp, "coverage-tests.json"), extraArgs: cov.args });
  const notes = [...cov.notes];
  if (result.timedOut) return coverageError(joinNotes([`the test run timed out`, ...notes]) ?? "timed out");
  if (!existsSync(cov.reportFile)) {
    return coverageError(
      joinNotes([`no coverage report was written (exit ${result.exitCode}): ${result.error ?? result.outputTail}`, ...notes]) ?? "no report",
    );
  }
  if (result.ok) {
    const failed = result.tests.filter((t) => t.outcome === "fail").length;
    const broken = result.files.filter((f) => f.loadError !== null).length;
    if (failed > 0 || broken > 0) notes.push(`measured while ${failed} test(s) failed and ${broken} test file(s) did not load`);
  } else {
    notes.push(`test results unreadable: ${result.error ?? "unknown"}`);
  }
  try {
    const map = parseIstanbul(readFileSync(cov.reportFile, "utf8"));
    const item = changedLineCoverage(map, changed, { root: realpathSync(ctx.repo) });
    if (item.unmeasuredFiles !== undefined) {
      notes.push(`not in the coverage report (counted as non-executable): ${item.unmeasuredFiles.join(", ")}`);
    }
    return withNote(item, ...notes, wd.note);
  } catch (error) {
    return coverageError(joinNotes([`could not read the coverage report: ${errorMessage(error)}`, ...notes]) ?? "unreadable report");
  }
}
