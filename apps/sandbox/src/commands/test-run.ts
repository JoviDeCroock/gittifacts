/**
 * `evidence test-run`: the whole test suite at head with the repository's runner and a JSON
 * reporter → TestRun. (The platform can also derive this from the CI `test` step; this is the
 * sandbox's own measurement.)
 */
import { join } from "node:path";
import type { TestRun } from "@app/evidence";
import { type Context, workdirCheck } from "../lib/context.js";
import { detectTestRunner, runTests } from "../lib/test-runner.js";
import { joinNotes, testRunError } from "./items.js";

const MAX_FAILURES = 200;

export async function testRun(ctx: Context): Promise<TestRun> {
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return testRunError(ctx.head, wd.error);
  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  if (!detected.ok) return testRunError(ctx.head, detected.reason);
  const runner = detected.runner;
  const result = await runTests({
    runner,
    dir: ctx.repo,
    reportPath: join(ctx.tmp, "test-run.json"),
  });
  const runnerName = `${runner.kind}${runner.version ? `@${runner.version}` : ""}`;
  if (!result.ok) return testRunError(ctx.head, result.error ?? "the test run failed", runnerName);
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
  };
  const note = joinNotes([
    failures.length > MAX_FAILURES
      ? `${failures.length - MAX_FAILURES} more failures not listed`
      : null,
    result.exitCode !== 0 && failures.length === 0
      ? `the runner exited ${result.exitCode} although no test failed`
      : null,
    wd.note,
  ]);
  if (note !== undefined) item.note = note;
  // A non-zero exit with no failing test is unexplained: do not report it as a clean run.
  if (result.exitCode !== 0 && failures.length === 0) item.status = "error";
  return item;
}
