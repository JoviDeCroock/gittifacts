/**
 * `evidence red-green`: do the change's new/changed tests fail on base and pass on head?
 *
 * 1. Changed test files between base and head; within each, the changed test cases (syntax tree
 *    + diff lines; whole file when that can't be decided statically).
 * 2. Run those files at head (the working tree) with the repository's runner and a JSON reporter.
 * 3. Clean worktree of base, head's test files (and test support files) overlaid, dependencies
 *    linked from head when the dependency graph is identical (installed otherwise); run the same
 *    files there.
 * 4. Verdict via the pure producer. Tests absent on base (or whose file can't load there) are
 *    "missing", which counts as red.
 */
import { join } from "node:path";
import {
  type RedGreenProof,
  redGreenProof,
  type TestOutcome,
  type TestRef,
  type TestResult,
} from "@app/evidence";
import { type Changes, loadChanges, touchedHeadLines } from "../lib/changes.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { git, readBlob, removeWorktree } from "../lib/git.js";
import { errorMessage, log } from "../lib/log.js";
import { isTestFile, isTestSupportFile } from "../lib/patterns.js";
import { prepareBaseWorktree } from "../lib/repo.js";
import { allStaticTests, changedTestCases } from "../lib/test-cases.js";
import { detectTestRunner, runTests, type TestRunOutput, testId } from "../lib/test-runner.js";
import { joinNotes } from "./items.js";

const ID = "red-green";

export function redGreenError(
  ctx: Context,
  note: string | undefined,
  tests: TestRef[] = [],
): RedGreenProof {
  return {
    id: ID,
    kind: "red-green",
    status: "error",
    note: (note ?? "red/green measurement failed").slice(0, 4000),
    tests,
    base: { sha: ctx.base, results: [] },
    head: { sha: ctx.head, results: [] },
    verdict: "not-proven",
  };
}

interface FileSelection {
  file: string;
  /** null = every test the head run reports for the file. */
  paths: string[][] | null;
  reason?: string;
}

async function selectTests(ctx: Context, changes: Changes): Promise<FileSelection[]> {
  const out: FileSelection[] = [];
  for (const f of changes.headFiles) {
    if (f.binary || !isTestFile(f.path)) continue;
    if (f.status === "added" || f.status === "copied") {
      out.push({ file: f.path, paths: null, reason: `${f.path} is a new test file` });
      continue;
    }
    const text = await readBlob(ctx.repo, ctx.head, f.path);
    if (text === null) continue;
    const lines = touchedHeadLines(f);
    if (lines.length === 0) continue; // pure rename
    const changed = changedTestCases(f.path, text, lines);
    if (changed.kind === "whole-file")
      out.push({ file: f.path, paths: null, reason: `${f.path}: ${changed.reason}` });
    else if (changed.tests.length > 0)
      out.push({ file: f.path, paths: changed.tests.map((t) => t.path) });
  }
  return out;
}

function outcomeOn(
  run: TestRunOutput,
  id: string,
  file: string,
  side: "base" | "head",
): TestOutcome {
  const matches = run.tests.filter((t) => t.id === id);
  if (matches.length > 0) {
    if (matches.some((t) => t.outcome === "fail")) return "fail";
    if (matches.every((t) => t.outcome === "pass")) return "pass";
    return "missing"; // skipped / todo: did not run
  }
  const loadError = run.files.find((f) => f.file === file)?.loadError;
  if (loadError) return side === "head" ? "error" : "missing";
  return "missing";
}

export async function redGreen(ctx: Context): Promise<RedGreenProof> {
  const changes = await loadChanges(ctx);
  const selections = await selectTests(ctx, changes);
  if (selections.length === 0) {
    const changedTestFiles = changes.headFiles.filter((f) => isTestFile(f.path)).map((f) => f.path);
    return redGreenProof({
      tests: [],
      base: { sha: ctx.base, results: [] },
      head: { sha: ctx.head, results: [] },
      note:
        changedTestFiles.length === 0
          ? "the change adds or modifies no test files"
          : `test files changed (${changedTestFiles.join(", ")}) but no test case in them changed`,
    });
  }
  const wd = workdirCheck(ctx);
  if (wd.error !== null) return redGreenError(ctx, wd.error);

  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  if (!detected.ok) return redGreenError(ctx, detected.reason);
  const runner = detected.runner;
  const files = [...new Set(selections.map((s) => s.file))];

  const headRun = await runTests({
    runner,
    dir: ctx.repo,
    files,
    reportPath: join(ctx.tmp, "red-green-head.json"),
  });
  if (!headRun.ok)
    return redGreenError(
      ctx,
      `running the changed tests at head failed: ${headRun.error ?? "unknown error"}`,
    );

  // The tests under scrutiny.
  const tests: TestRef[] = [];
  const notes: string[] = [];
  for (const s of selections) {
    if (s.reason) notes.push(`whole-file granularity: ${s.reason}`);
    if (s.paths !== null) {
      for (const path of s.paths)
        tests.push({ id: testId(s.file, path), file: s.file, name: path.join(" > ") });
      continue;
    }
    const reported = headRun.tests.filter((t) => t.file === s.file);
    if (reported.length > 0) {
      for (const t of reported) tests.push({ id: t.id, file: s.file, name: t.path.join(" > ") });
      continue;
    }
    // The file reported nothing at head (failed to load?): fall back to its static tests.
    const text = await readBlob(ctx.repo, ctx.head, s.file);
    const statics = text === null ? null : allStaticTests(s.file, text);
    if (statics !== null && statics.length > 0) {
      for (const t of statics)
        tests.push({ id: testId(s.file, t.path), file: s.file, name: t.path.join(" > ") });
    } else {
      tests.push({ id: s.file, file: s.file, name: "(no test reported for this file at head)" });
    }
  }
  const seen = new Set<string>();
  const uniqueTests = tests.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // Base: clean worktree + head's test files.
  const wtPath = join(ctx.tmp, "base");
  let baseRun: TestRunOutput;
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
    notes.push(...prepared.notes);
    if (prepared.deps === "install-failed") {
      return redGreenError(
        ctx,
        joinNotes([
          "could not install the base commit's dependencies, so a red result on base would prove nothing",
          ...notes,
        ]),
        uniqueTests,
      );
    }
    const overlay = changes.headFiles.filter((f) => isTestSupportFile(f.path)).map((f) => f.path);
    const deletedSupport = changes.diff.files
      .filter((f) => f.status === "deleted" && isTestSupportFile(f.path))
      .map((f) => f.path);
    if (overlay.length > 0) await git(prepared.dir, ["checkout", ctx.head, "--", ...overlay]);
    if (deletedSupport.length > 0)
      await git(prepared.dir, ["rm", "-q", "--ignore-unmatch", "--", ...deletedSupport]);
    log(
      `red-green: overlaid ${overlay.length} test file(s) from head onto base (deps: ${prepared.deps})`,
    );
    // The runner as installed for base (linked or freshly installed).
    const baseRunner = detectTestRunner(prepared.dir, ctx.testCommand);
    const runnerForBase = baseRunner.ok ? baseRunner.runner : runner;
    if (!baseRunner.ok) notes.push(`base: ${baseRunner.reason}; used head's ${runner.kind}`);
    baseRun = await runTests({
      runner: runnerForBase,
      dir: prepared.dir,
      files,
      reportPath: join(ctx.tmp, "red-green-base.json"),
    });
  } catch (error) {
    return redGreenError(
      ctx,
      joinNotes([`preparing the base worktree failed: ${errorMessage(error)}`, ...notes]),
      uniqueTests,
    );
  } finally {
    await removeWorktree(ctx.repo, wtPath).catch(() => {});
  }
  if (!baseRun.ok) {
    return redGreenError(
      ctx,
      joinNotes([
        `running the changed tests on base failed: ${baseRun.error ?? "unknown error"}`,
        ...notes,
      ]),
      uniqueTests,
    );
  }

  const baseResults: TestResult[] = uniqueTests.map((t) => ({
    id: t.id,
    outcome: outcomeOn(baseRun, t.id, t.file, "base"),
  }));
  const headResults: TestResult[] = uniqueTests.map((t) => ({
    id: t.id,
    outcome: outcomeOn(headRun, t.id, t.file, "head"),
  }));
  for (const f of baseRun.files)
    if (f.loadError) notes.push(`base: ${f.file} failed to load (its tests count as missing)`);
  if (wd.note !== null) notes.push(wd.note);
  notes.push(
    `runner: ${runner.kind}${runner.version ? `@${runner.version}` : ""} (${runner.source})`,
  );
  const item = redGreenProof({
    tests: uniqueTests,
    base: { sha: ctx.base, results: baseResults },
    head: { sha: ctx.head, results: headResults },
    note: joinNotes(notes),
  });
  return item;
}
