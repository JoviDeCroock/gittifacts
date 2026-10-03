/**
 * `evidence test-run`: the tests that can reach the Change (the whole suite when its test impact
 * is unknown) at head, with the repository's runner and a JSON reporter → TestRun.
 *
 * Failures are compared with the base commit: a failure that fails identically there (confirmed
 * in two base runs, same failure signature) is listed in `preExisting` and does not count against
 * the Change. Base results come from the baseline cache when an earlier run measured the same
 * base commit, else the failing files run on base now, but only when base installs the same
 * dependencies (nothing is installed for this). Without a baseline every failure counts.
 */
import { join } from "node:path";
import type { BaselineInfo, TestRun } from "@app/evidence";
import { BaselineStore, compareFailure, failureSignature, runnerId } from "../lib/baseline.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { removeWorktree } from "../lib/git.js";
import { errorMessage } from "../lib/log.js";
import { failingFiles, measureOnBase } from "../lib/preexisting-tests.js";
import { prepareBaseWorktree, sameDependencyGraph } from "../lib/repo.js";
import { selectedFiles, selectionEvidence, selectTests } from "../lib/selection.js";
import {
  detectTestRunner,
  runTests,
  type TestRunner,
  type TestRunOutput,
} from "../lib/test-runner.js";
import { joinNotes, testRunError } from "./items.js";

const MAX_FAILURES = 200;

export async function testRun(ctx: Context): Promise<TestRun> {
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return testRunError(ctx.head, wd.error);
  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  if (!detected.ok) return testRunError(ctx.head, detected.reason);
  const runner = detected.runner;
  const runnerName = `${runner.kind}${runner.version ? `@${runner.version}` : ""}`;
  const selection = await selectTests(ctx);
  const recorded = selectionEvidence(selection);
  if (selection.mode === "affected" && selection.files.length === 0) {
    return {
      id: "test-run",
      kind: "test-run",
      status: "ok",
      sha: ctx.head,
      step: "test",
      runner: runnerName,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      failures: [],
      selection: recorded,
      note: joinNotes([`no test ran: ${selection.reason}`, wd.note]) ?? "no test ran",
    };
  }
  const files = selectedFiles(selection);
  const result = await runTests({
    runner,
    dir: ctx.repo,
    ...(files === undefined ? {} : { files }),
    reportPath: join(ctx.tmp, "test-run.json"),
  });
  if (!result.ok)
    return {
      ...testRunError(ctx.head, result.error ?? "the test run failed", runnerName),
      selection: recorded,
    };
  const failures = [
    ...result.files
      .filter((f) => f.loadError !== null)
      .map((f) => ({ name: f.file, message: (f.loadError ?? "").slice(0, 4000) })),
    ...result.tests
      .filter((t) => t.outcome === "fail")
      .map((t) => ({ name: t.id, message: (t.message ?? "failed").slice(0, 4000) })),
  ];
  const item: TestRun = {
    id: "test-run",
    kind: "test-run",
    status: "ok",
    sha: ctx.head,
    step: "test",
    runner: runnerName,
    passed: result.tests.filter((t) => t.outcome === "pass").length,
    failed: failures.length,
    skipped: result.tests.filter((t) => t.outcome === "skip").length,
    durationMs: result.durationMs,
    failures: failures.slice(0, MAX_FAILURES),
    selection: recorded,
  };
  const notes: (string | null)[] = [`tests run: ${selection.reason}`];
  if (failures.length > 0) {
    const compared = await compareWithBase(ctx, runner, result);
    item.baseline = compared.baseline;
    if (compared.preExisting.length > 0)
      item.preExisting = compared.preExisting.slice(0, MAX_FAILURES);
    notes.push(...compared.notes);
  }
  notes.push(
    failures.length > MAX_FAILURES
      ? `${failures.length - MAX_FAILURES} more failures not listed`
      : null,
    result.exitCode !== 0 && failures.length === 0
      ? `the runner exited ${result.exitCode} although no test failed`
      : null,
    wd.note,
  );
  const note = joinNotes(notes);
  if (note !== undefined) item.note = note;
  // A non-zero exit with no failing test is unexplained: do not report it as a clean run.
  if (result.exitCode !== 0 && failures.length === 0) item.status = "error";
  return item;
}

interface Compared {
  baseline: BaselineInfo;
  /** Failure names (test ids, or files that failed to load) that fail identically on base. */
  preExisting: string[];
  notes: string[];
}

/** Head failures against base results (cache first, then the failing files run on base). */
async function compareWithBase(
  ctx: Context,
  runner: TestRunner,
  head: TestRunOutput,
): Promise<Compared> {
  const files = failingFiles(head).sort();
  const store = BaselineStore.load(ctx.base, runnerId(runner));
  const unavailable = (why: string): Compared => ({
    baseline: { sha: ctx.base, status: "unavailable", note: why.slice(0, 1000) },
    preExisting: [],
    notes: [`every failure counts: no baseline on base (${why})`],
  });
  const missing = files.filter((f) => !store.has(f));
  const wtPath = join(ctx.tmp, "baseline-base");
  let roots = [ctx.repo];
  let ran = 0;
  if (missing.length > 0) {
    if (!(await sameDependencyGraph(ctx.repo, ctx.base, ctx.head)))
      return unavailable("base installs different dependencies; not installed for this");
    try {
      const prepared = await prepareBaseWorktree({
        repo: ctx.repo,
        headDir: ctx.repo,
        base: ctx.base,
        head: ctx.head,
        path: wtPath,
        packageManager: ctx.packageManager,
        needDeps: true,
      });
      roots = [ctx.repo, prepared.dir];
      const baseRunner = detectTestRunner(prepared.dir, ctx.testCommand);
      if (!baseRunner.ok) return unavailable(`base: ${baseRunner.reason}`);
      const measured = await measureOnBase({
        runner: baseRunner.runner,
        dir: prepared.dir,
        tmp: ctx.tmp,
        files: missing,
        store,
        roots,
      });
      if (!measured.ok) return unavailable(measured.reason);
      ran = measured.ran;
    } catch (error) {
      return unavailable(`preparing the base checkout failed: ${errorMessage(error)}`);
    } finally {
      await removeWorktree(ctx.repo, wtPath).catch(() => {});
      store.save();
    }
  }
  const verdicts = { "pre-existing": 0, new: 0, differs: 0, unknown: 0 };
  const preExisting: string[] = [];
  for (const f of head.files.filter((x) => x.loadError !== null)) {
    const v = compareFailure(store.get(f.file), {
      id: f.file,
      loadError: true,
      signature: failureSignature(f.loadError, roots),
    });
    verdicts[v] += 1;
    if (v === "pre-existing") preExisting.push(f.file);
  }
  for (const t of head.tests.filter((x) => x.outcome === "fail")) {
    const v = compareFailure(store.get(t.file), {
      id: t.id,
      loadError: false,
      signature: failureSignature(t.message, roots),
    });
    verdicts[v] += 1;
    if (v === "pre-existing") preExisting.push(t.id);
  }
  const cached = files.length - missing.length;
  const source = ran === 0 ? "cache" : cached === 0 ? "run" : "mixed";
  const parts = [
    `${verdicts["pre-existing"]} fail identically on base ${ctx.base.slice(0, 12)} (pre-existing, not counted)`,
    `${verdicts.new} new`,
    verdicts.differs > 0 ? `${verdicts.differs} fail differently on base` : null,
    verdicts.unknown > 0 ? `${verdicts.unknown} without a confirmed base result` : null,
  ].filter((p): p is string => p !== null);
  return {
    baseline: { sha: ctx.base, status: "ok", source },
    preExisting,
    notes: [
      `failures against base: ${parts.join(", ")}; base results ${source === "cache" ? "from the cache" : source === "run" ? "measured now" : "cached and measured"}`,
    ],
  };
}
