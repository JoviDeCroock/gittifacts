/**
 * `evidence red-green`: does a test that fails on base pass on head? Such a test proves the
 * change, whether the change added it, changed it, or found it already there.
 *
 * Listed tests:
 * - new/changed tests: the changed test files between base and head, and within each the changed
 *   test cases (syntax tree + diff lines; the whole file when that can't be decided statically);
 * - pre-existing tests that fail on base as committed (twice: a flaky failure is not a red) and
 *   at head pass (the change fixes them) or still fail (listed, so a fix that doesn't work is
 *   never proven). A base failure that disappears at head is noted, not listed.
 *
 * 1. A clean worktree of base: head's node_modules linked when the dependency graph is
 *    identical, installed otherwise (only when new/changed tests need it: looking for fixed
 *    pre-existing tests alone never installs; it is skipped with a note).
 * 2. Pristine base: the whole suite with the repo's runner and a JSON reporter
 *    (lib/preexisting-tests.ts).
 * 3. Head's test and test-support files overlaid on base; the new/changed test files run there.
 *    New/changed tests absent on base (or whose file can't load there) are "missing" = red.
 * 4. Head (the working tree): the new/changed test files and the files of base's failures.
 * 5. Verdict via the pure producer: proven iff ≥ 1 listed test is red on base and every listed
 *    test is green on head.
 *
 * Looking for pre-existing failures can only add a proof or block one. When it can't run (no
 * runner, unsound base environment), the item says why and rests on the new/changed tests:
 * `no-tests` when there are none, exactly as before pre-existing tests counted.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type RedGreenProof, redGreenProof, type TestRef, type TestResult } from "@app/evidence";
import { BaselineStore, runnerId } from "../lib/baseline.js";
import { type Changes, loadChanges, touchedHeadLines } from "../lib/changes.js";
import { type Context, workdirCheck } from "../lib/context.js";
import { git, readBlob, removeWorktree } from "../lib/git.js";
import { errorMessage, log } from "../lib/log.js";
import { isTestFile, isTestSupportFile } from "../lib/patterns.js";
import { type BaseScan, listPreexisting, outcomeOn, scanBase } from "../lib/preexisting-tests.js";
import { prepareBaseWorktree, sameDependencyGraph } from "../lib/repo.js";
import {
  type Selection,
  selectTests as selectAffected,
  selectedFiles,
  selectionEvidence,
} from "../lib/selection.js";
import { allStaticTests, changedTestCases } from "../lib/test-cases.js";
import {
  detectTestRunner,
  runTests,
  type TestRunner,
  type TestRunOutput,
  testId,
} from "../lib/test-runner.js";
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

function noTests(ctx: Context, notes: readonly string[]): RedGreenProof {
  return redGreenProof({
    tests: [],
    base: { sha: ctx.base, results: [] },
    head: { sha: ctx.head, results: [] },
    note: joinNotes(notes) ?? "no test fails on base and passes on head",
  });
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

/** The new/changed tests, resolved against the head run (whole files: what it reported). */
async function listSelected(
  ctx: Context,
  selections: readonly FileSelection[],
  headRun: TestRunOutput,
  notes: string[],
): Promise<TestRef[]> {
  const tests: TestRef[] = [];
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
  return tests.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

interface BasePhase {
  /** Pre-existing failures on base as committed (ok: false when they couldn't be looked for). */
  scan: BaseScan;
  /** The new/changed test files on base with head's tests overlaid (null: none selected). */
  overlaid: TestRunOutput | null;
}

/**
 * Base: pristine suite run, then head's test files overlaid and the selected files run. Returns
 * an error item when the selected tests can't be measured; a failed scan is reported in `scan`.
 */
async function measureBase(
  ctx: Context,
  changes: Changes,
  files: readonly string[],
  headRunner: TestRunner,
  notes: string[],
  selection: Selection,
  store: BaselineStore,
): Promise<BasePhase | RedGreenProof> {
  const wtPath = join(ctx.tmp, "base");
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
      const why =
        "could not install the base commit's dependencies, so a red result on base would prove nothing";
      return files.length > 0
        ? redGreenError(ctx, joinNotes([why, ...notes]))
        : { scan: { ok: false, reason: why }, overlaid: null };
    }
    // The runner as installed for base (linked or freshly installed). Base failures only count
    // from base's own runner: anything else is not base as committed.
    const baseRunner = detectTestRunner(prepared.dir, ctx.testCommand);
    // Only the selected test files can be fixed by the Change (all of them when its test impact
    // is unknown); base results come from the cache when an earlier run measured this commit.
    const scan: BaseScan = !baseRunner.ok
      ? { ok: false, reason: `base: ${baseRunner.reason}` }
      : selection.mode === "affected" && selection.files.length === 0
        ? { ok: true, failures: [], notes: [], source: "none" }
        : await scanBase({
            runner: baseRunner.runner,
            dir: prepared.dir,
            tmp: ctx.tmp,
            files: selectedFiles(selection),
            store,
            roots: rootsOf(ctx.repo, prepared.dir),
          });
    if (files.length === 0) return { scan, overlaid: null };

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
    const runner = baseRunner.ok ? baseRunner.runner : headRunner;
    if (!baseRunner.ok) notes.push(`base: ${baseRunner.reason}; used head's ${runner.kind}`);
    const overlaid = await runTests({
      runner,
      dir: prepared.dir,
      files,
      reportPath: join(ctx.tmp, "red-green-base.json"),
    });
    if (!overlaid.ok) {
      const why = `running the changed tests on base failed: ${overlaid.error ?? "unknown error"}`;
      return redGreenError(ctx, joinNotes([why, ...notes]));
    }
    return { scan, overlaid };
  } catch (error) {
    const why = `preparing the base worktree failed: ${errorMessage(error)}`;
    return files.length > 0
      ? redGreenError(ctx, joinNotes([why, ...notes]))
      : { scan: { ok: false, reason: why }, overlaid: null };
  } finally {
    await removeWorktree(ctx.repo, wtPath).catch(() => {});
  }
}

export async function redGreen(ctx: Context): Promise<RedGreenProof> {
  const changes = await loadChanges(ctx);
  const selections = await selectTests(ctx, changes);
  const files = [...new Set(selections.map((s) => s.file))];
  const notes: string[] = [];
  if (selections.length === 0) {
    const changed = changes.headFiles.filter((f) => isTestFile(f.path)).map((f) => f.path);
    notes.push(
      changed.length === 0
        ? "the change adds or modifies no test files"
        : `test files changed (${changed.join(", ")}) but no test case in them changed`,
    );
  }
  // Without new/changed tests, only a pre-existing failure can prove anything: when it can't be
  // looked for, say why (never an error: the item is what it was before pre-existing tests counted).
  const unscanned = (reason: string) =>
    noTests(ctx, [...notes, `pre-existing tests not checked: ${reason}`]);

  const wd = workdirCheck(ctx);
  if (wd.error !== null)
    return files.length === 0 ? unscanned(wd.error) : redGreenError(ctx, wd.error);
  const detected = detectTestRunner(ctx.repo, ctx.testCommand);
  if (!detected.ok)
    return files.length === 0 ? unscanned(detected.reason) : redGreenError(ctx, detected.reason);
  const runner = detected.runner;
  if (files.length === 0 && !(await sameDependencyGraph(ctx.repo, ctx.base, ctx.head)))
    return unscanned("base and head install different dependencies (not installed for this alone)");

  const selection = await selectAffected(ctx);
  const store = BaselineStore.load(ctx.base, runnerId(runner));
  const base = await measureBase(ctx, changes, files, runner, notes, selection, store);
  store.save();
  if ("kind" in base) return { ...base, selection: selectionEvidence(selection) };
  const { scan, overlaid } = base;
  if (scan.ok) notes.push(...scan.notes);
  else notes.push(`pre-existing tests not checked: ${scan.reason}`);
  const failures = scan.ok ? scan.failures : [];
  notes.push(`tests looked at: ${selection.reason}`);
  if (files.length === 0 && failures.length === 0)
    return { ...noTests(ctx, notes), selection: selectionEvidence(selection) };

  // Head: the new/changed test files and the files of base's failures that still exist.
  const failureFiles = failures.map((f) => f.file).filter((f) => existsSync(join(ctx.repo, f)));
  const headFiles = [...new Set([...files, ...failureFiles])];
  if (headFiles.length === 0) {
    notes.push("every test file failing on base is gone at head");
    return { ...noTests(ctx, notes), selection: selectionEvidence(selection) };
  }
  const headRun = await runTests({
    runner,
    dir: ctx.repo,
    files: headFiles,
    reportPath: join(ctx.tmp, "red-green-head.json"),
  });
  if (!headRun.ok) {
    const why = `running the tests at head failed: ${headRun.error ?? "unknown error"}`;
    return redGreenError(ctx, joinNotes([why, ...notes]));
  }

  const selected = await listSelected(ctx, selections, headRun, notes);
  const pre = listPreexisting(
    failures,
    headRun,
    new Set(selected.map((t) => t.id)),
    rootsOf(ctx.repo, join(ctx.tmp, "base")),
  );
  const baseResults: TestResult[] = selected.map((t) => ({
    id: t.id,
    outcome: overlaid === null ? "missing" : outcomeOn(overlaid, t.id, t.file, "base"),
  }));
  const headResults: TestResult[] = selected.map((t) => ({
    id: t.id,
    outcome: outcomeOn(headRun, t.id, t.file, "head"),
  }));
  for (const f of overlaid?.files ?? [])
    if (f.loadError) notes.push(`base: ${f.file} failed to load (its tests count as missing)`);
  const ids = (xs: readonly string[]) =>
    xs.length > 5 ? `${xs.slice(0, 5).join(", ")} and ${xs.length - 5} more` : xs.join(", ");
  if (pre.fixed.length > 0)
    notes.push(`pre-existing, fail on base and pass on head: ${ids(pre.fixed)}`);
  if (pre.stillFailing.length > 0)
    notes.push(`fail on base and fail differently on head: ${ids(pre.stillFailing)}`);
  if (pre.identical.length > 0)
    notes.push(
      `pre-existing, fail identically on base and head (not counted): ${ids(pre.identical.map((t) => t.id))}`,
    );
  if (pre.gone.length > 0) notes.push(`fail on base, no result at head: ${ids(pre.gone)}`);
  if (wd.note !== null) notes.push(wd.note);
  notes.push(
    `runner: ${runner.kind}${runner.version ? `@${runner.version}` : ""} (${runner.source})`,
  );
  const item = redGreenProof({
    tests: [...selected, ...pre.tests],
    base: { sha: ctx.base, results: [...baseResults, ...pre.base] },
    head: { sha: ctx.head, results: [...headResults, ...pre.head] },
    note: joinNotes(notes),
  });
  return {
    ...item,
    ...(pre.identical.length === 0 ? {} : { preExisting: pre.identical.slice(0, 200) }),
    selection: selectionEvidence(selection),
  };
}

/** Checkout roots (and their real paths) that failure messages may embed. */
function rootsOf(...dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    out.add(d);
    try {
      out.add(realpathSync(d));
    } catch {
      // gone already
    }
  }
  return [...out];
}
