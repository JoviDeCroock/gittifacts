/**
 * `evidence mutation`: Stryker mutation score on the changed lines of head.
 *
 * Stryker is ours (the repository needn't depend on it): the CLI from our
 * `@stryker-mutator/core`, the vitest runner plugin loaded by absolute path. `mutate` is
 * restricted to the changed line ranges of changed source files (`file:start-end`), so only
 * mutants on changed lines are generated; the pure producer then scores exactly the mutants
 * whose location contains a changed line. vitest repos use the vitest runner with per-test
 * coverage analysis; other runners fall back to Stryker's `command` runner (the test command per
 * mutant, no coverage analysis: slower but runner-agnostic).
 */
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MutationScore,
  mutationScore,
  parseStrykerReport,
  type StrykerReport,
  stripAnsi,
} from "@app/evidence";
import { loadChanges } from "../lib/changes.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { errorMessage, log, tail } from "../lib/log.js";
import { lineRanges, measuredChangedLines } from "../lib/patterns.js";
import { run } from "../lib/proc.js";
import { detectTestRunner } from "../lib/test-runner.js";
import {
  mutationConcurrency,
  ownTool,
  strykerBin,
  strykerVitestRunnerPlugin,
} from "../lib/tools.js";
import { joinNotes, mutationError, withNote } from "./items.js";

const EMPTY_REPORT: StrykerReport = { schemaVersion: "2", files: {} };

function configFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--config" || a === "-c") return args[i + 1];
    if (a.startsWith("--config=")) return a.slice("--config=".length);
  }
  return undefined;
}

export async function mutation(ctx: Context): Promise<MutationScore> {
  const changes = await loadChanges(ctx);
  const changed = measuredChangedLines(changes.diff.changedLines);
  const files = Object.keys(changed).sort();
  if (files.length === 0) {
    return withNote(
      mutationScore(EMPTY_REPORT, {}),
      "no changed lines in measured source files, so there is nothing to mutate",
    );
  }
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return mutationError(wd.error);
  const bin = strykerBin();
  if (bin === null) return mutationError("the runner's @stryker-mutator/core is not installed");
  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  const notes: string[] = [];
  // No point starting more vitest workers than there are (roughly) mutants to run.
  const changedLineCount = files.reduce((n, f) => n + (changed[f]?.length ?? 0), 0);
  const concurrency = Math.max(1, Math.min(mutationConcurrency(), changedLineCount));
  const reportFile = join(ctx.tmp, "mutation.json");
  const mutate = files.flatMap((f) =>
    lineRanges(changed[f] ?? []).map(([a, b]) => `${f}:${a}-${b}`),
  );
  const config: Record<string, unknown> = {
    mutate,
    reporters: ["json", "clear-text"],
    jsonReporter: { fileName: reportFile },
    clearTextReporter: { allowColor: false, logTests: false, reportTests: false },
    concurrency,
    checkers: [],
    incremental: false,
    cleanTempDir: true,
    allowEmpty: true,
    logLevel: "info",
    fileLogLevel: "off",
    dryRunTimeoutMinutes: 10,
  };
  if (detected.ok && detected.runner.kind === "vitest") {
    const plugin = strykerVitestRunnerPlugin();
    if (plugin === null)
      return mutationError("the runner's @stryker-mutator/vitest-runner is not installed");
    const configFile = configFlag(detected.runner.args);
    config.testRunner = "vitest";
    config.plugins = [plugin];
    config.coverageAnalysis = "perTest";
    config.vitest = { related: true, ...(configFile === undefined ? {} : { configFile }) };
    notes.push(`vitest runner (${detected.runner.version ?? "?"}), perTest coverage analysis`);
  } else {
    const command = ctx.testCommand ?? null;
    if (command === null) {
      return mutationError(
        detected.ok
          ? `no --test-command for the ${detected.runner.kind} command runner`
          : detected.reason,
      );
    }
    config.testRunner = "command";
    config.plugins = [];
    config.coverageAnalysis = "off";
    config.commandRunner = { command };
    notes.push(`command runner (${command}); every mutant runs the whole test command`);
  }
  const configPath = join(ctx.tmp, "stryker.config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const stryker = ownTool("@stryker-mutator/core");
  log(
    `mutation: stryker ${stryker?.version ?? "?"} on ${mutate.length} range(s) in ${files.length} file(s), concurrency ${concurrency}`,
  );
  const timeoutMs = Number(process.env.GITTIFACTS_MUTATION_TIMEOUT_MS) || 25 * 60_000;
  // Stryker's sandbox copies of the tests must not outlive the run (a later test run in the
  // same checkout would pick them up).
  const strykerTmp = join(ctx.repo, ".stryker-tmp");
  const hadStrykerTmp = existsSync(strykerTmp);
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(process.execPath, [bin, "run", configPath], { cwd: ctx.repo, timeoutMs });
  } catch (error) {
    return mutationError(`could not start stryker: ${errorMessage(error)}`);
  } finally {
    if (!hadStrykerTmp) rmSync(strykerTmp, { recursive: true, force: true });
  }
  if (result.timedOut)
    return mutationError(
      joinNotes([`stryker timed out after ${Math.round(timeoutMs / 60_000)} min`, ...notes]) ??
        "timed out",
    );
  if (!existsSync(reportFile)) {
    const output = stripAnsi(result.stdout + result.stderr);
    const untested = noTestsFound(result.code, output);
    if (untested !== null) {
      // Stryker found no test related to the mutated files: a measurement (nothing covers these
      // lines), not a tool failure.
      if (untested === 0)
        return withNote(
          mutationScore(EMPTY_REPORT, {}),
          "stryker generated no mutant on the changed lines",
          ...notes,
        );
      const measured: MutationScore = {
        id: "mutation",
        kind: "mutation",
        status: "ok",
        tool: `stryker@${stryker?.version ?? "?"}`,
        files,
        killed: 0,
        survived: 0,
        timedOut: 0,
        noCoverage: untested,
        score: 0,
        survivors: [],
      };
      return withNote(
        measured,
        `no test covers the changed files: no test is related to ${files.join(", ")}, so all ${untested} mutant(s) have no coverage`,
        ...notes,
        wd.note,
      );
    }
    return mutationError(
      joinNotes([
        `stryker exited ${result.code} without a report: ${tail(result.stdout + result.stderr, 12)}`,
        ...notes,
      ]) ?? "no report",
    );
  }
  let report: StrykerReport;
  try {
    report = parseStrykerReport(readFileSync(reportFile, "utf8"));
  } catch (error) {
    return mutationError(
      joinNotes([`unreadable stryker report: ${errorMessage(error)}`, ...notes]) ??
        "unreadable report",
    );
  }
  if (result.code !== 0)
    notes.push(`stryker exited ${result.code}: ${tail(result.stdout + result.stderr, 6)}`);
  notes.push(
    `stryker ${stryker?.version ?? "?"}, concurrency ${concurrency}, mutate ${mutate.join(" ")}`,
  );
  const item = mutationScore(report, changed, {
    root: realpathSync(ctx.repo),
    tool: `stryker@${stryker?.version ?? "?"}`,
  });
  // A crashed run with a partial report must not read as a clean measurement.
  if (result.code !== 0 && item.status === "ok")
    return {
      ...mutationError(joinNotes(notes) ?? "stryker failed"),
      ...countsOf(item),
      status: "error",
    };
  return withNote(item, ...notes, wd.note);
}

/**
 * The mutant count when Stryker stopped because no test relates to the mutated files (exit 0, no
 * report, "No tests were found"); null otherwise or when the count is not in its output.
 */
export function noTestsFound(code: number, output: string): number | null {
  if (code !== 0 || !/\bNo tests were (?:found|executed)\b/.test(output)) return null;
  const m = /Instrumented \d+ source file\(s\) with (\d+) mutant\(s\)/.exec(output);
  return m === null ? null : Number(m[1]);
}

function countsOf(
  item: MutationScore,
): Pick<
  MutationScore,
  "files" | "killed" | "survived" | "timedOut" | "noCoverage" | "score" | "survivors"
> {
  const { files, killed, survived, timedOut, noCoverage, score, survivors } = item;
  return { files, killed, survived, timedOut, noCoverage, score, survivors };
}
