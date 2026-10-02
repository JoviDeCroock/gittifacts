/**
 * Pre-existing tests for `evidence red-green`. A test proves a fix when it fails on base and
 * passes on head, whether the change added it, changed it, or found it already there (an
 * imported repo's failing test, fixed by a source-only change).
 *
 * - `scanBase` runs the whole suite on a PRISTINE base checkout (the base commit as it is,
 *   nothing overlaid from head) and re-runs the failing files once: only a test that fails in
 *   both runs counts, so a flaky failure is never a red.
 * - `listPreexisting` sorts those failures by their outcome at head: pass (the change fixes
 *   them), fail/error (listed too, so a fix that doesn't work is never proven), or gone (deleted,
 *   renamed or skipped at head: noted, not listed).
 */
import { join } from "node:path";
import type { TestOutcome, TestRef, TestResult } from "@app/evidence";
import { runTests, type TestRunner, type TestRunOutput } from "./test-runner.js";

/** A test that is red on base in two runs, or a whole file that failed to load there. */
export interface BaseFailure {
  id: string;
  file: string;
  /** Describe titles and the test title; null = the file failed to load (every test in it). */
  path: string[] | null;
  outcome: "fail" | "error";
}

export type BaseScan =
  | { ok: true; failures: BaseFailure[]; notes: string[] }
  | { ok: false; reason: string };

/** The outcome of one listed test in a run (skipped/todo and absent tests are "missing"). */
export function outcomeOn(
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

/** Failing tests and unloadable files of one run. A test with any passing result is not failing. */
export function failuresOf(run: TestRunOutput): BaseFailure[] {
  const passed = new Set(run.tests.filter((t) => t.outcome === "pass").map((t) => t.id));
  const out = new Map<string, BaseFailure>();
  for (const t of run.tests) {
    if (t.outcome !== "fail" || passed.has(t.id)) continue;
    out.set(t.id, { id: t.id, file: t.file, path: t.path, outcome: "fail" });
  }
  for (const f of run.files) {
    if (f.loadError !== null)
      out.set(f.file, { id: f.file, file: f.file, path: null, outcome: "error" });
  }
  return [...out.values()];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The whole suite on the pristine base checkout at `dir`, failures confirmed by a second run. */
export async function scanBase(opts: {
  runner: TestRunner;
  dir: string;
  tmp: string;
}): Promise<BaseScan> {
  const first = await runTests({
    runner: opts.runner,
    dir: opts.dir,
    reportPath: join(opts.tmp, "red-green-base-suite.json"),
  });
  if (!first.ok)
    return {
      ok: false,
      reason: `the suite did not run on base: ${first.error ?? "unknown error"}`,
    };
  const failing = failuresOf(first);
  if (failing.length === 0)
    return { ok: true, failures: [], notes: ["no test fails on base as committed"] };
  const again = await runTests({
    runner: opts.runner,
    dir: opts.dir,
    files: [...new Set(failing.map((f) => f.file))],
    reportPath: join(opts.tmp, "red-green-base-confirm.json"),
  });
  if (!again.ok) {
    const why = again.error ?? "unknown error";
    return { ok: false, reason: `re-running base's failing tests failed: ${why}` };
  }
  const confirmed = new Set(failuresOf(again).map((f) => f.id));
  const failures = failing.filter((f) => confirmed.has(f.id));
  const flaky = failing.length - failures.length;
  const unloadable = failures.filter((f) => f.path === null).length;
  const notes = [
    `on base as committed: ${plural(failures.length - unloadable, "test")} fail` +
      (unloadable > 0 ? `, ${plural(unloadable, "test file")} fail to load` : ""),
  ];
  if (flaky > 0)
    notes.push(`${plural(flaky, "test")} failed once on base, then passed (flaky: not red)`);
  return { ok: true, failures, notes };
}

export interface PreexistingListing {
  tests: TestRef[];
  base: TestResult[];
  head: TestResult[];
  /** Ids that fail on base and pass on head. */
  fixed: string[];
  /** Ids that fail on base and still fail (or error) on head. */
  stillFailing: string[];
  /** Base failures with no outcome at head (deleted, renamed or skipped there). */
  gone: string[];
}

/**
 * Base failures, by their outcome in `headRun` (which ran their files). Ids in `exclude` (the
 * new/changed tests, measured with head's test files on base) are left to that measurement.
 */
export function listPreexisting(
  failures: readonly BaseFailure[],
  headRun: TestRunOutput,
  exclude: ReadonlySet<string>,
): PreexistingListing {
  const out: PreexistingListing = {
    tests: [],
    base: [],
    head: [],
    fixed: [],
    stillFailing: [],
    gone: [],
  };
  const listed = new Set<string>();
  const add = (ref: TestRef, base: "fail" | "error", head: TestOutcome) => {
    if (exclude.has(ref.id) || listed.has(ref.id)) return;
    if (head === "missing") {
      out.gone.push(ref.id);
      return;
    }
    listed.add(ref.id);
    out.tests.push(ref);
    out.base.push({ id: ref.id, outcome: base });
    out.head.push({ id: ref.id, outcome: head });
    (head === "pass" ? out.fixed : out.stillFailing).push(ref.id);
  };
  for (const f of failures) {
    if (f.path !== null) {
      const name = f.path.join(" > ");
      add({ id: f.id, file: f.file, name }, f.outcome, outcomeOn(headRun, f.id, f.file, "head"));
      continue;
    }
    // The file failed to load on base: every test it reports at head was red there.
    const reported = headRun.tests.filter((t) => t.file === f.file);
    if (reported.length > 0) {
      for (const t of reported) {
        const ref = { id: t.id, file: f.file, name: t.path.join(" > ") };
        add(ref, "error", outcomeOn(headRun, t.id, f.file, "head"));
      }
      continue;
    }
    const headLoad = headRun.files.find((x) => x.file === f.file)?.loadError ?? null;
    const name = "(the file fails to load on base and on head)";
    add({ id: f.file, file: f.file, name }, "error", headLoad !== null ? "error" : "missing");
  }
  return out;
}
