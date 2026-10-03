/**
 * Pre-existing tests for `evidence red-green`. A test proves a fix when it fails on base and
 * passes on head, whether the change added it, changed it, or found it already there (an
 * imported repo's failing test, fixed by a source-only change).
 *
 * - `scanBase` runs the selected test files (the whole suite when the Change's test impact is
 *   unknown) on a PRISTINE base checkout (the base commit as it is, nothing overlaid from head),
 *   reusing cached base results (lib/baseline.ts), and re-runs the failing files once: only a
 *   test that fails in both runs counts, so a flaky failure is never a red.
 * - `listPreexisting` sorts those failures by their outcome at head: pass (the change fixes them:
 *   listed), failing differently (listed, so a fix that doesn't work is never proven), failing
 *   identically (pre-existing: reported apart, neither proves nor blocks), or gone (deleted,
 *   renamed or skipped at head: noted, not listed).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestOutcome, TestRef, TestResult } from "@app/evidence";
import { type BaselineStore, failureSignature } from "./baseline.js";
import { runTests, type TestRunner, type TestRunOutput } from "./test-runner.js";

/** A test that is red on base in two runs, or a whole file that failed to load there. */
export interface BaseFailure {
  id: string;
  file: string;
  /** Describe titles and the test title; null = the file failed to load (every test in it). */
  path: string[] | null;
  outcome: "fail" | "error";
  /** `failureSignature` of the failure on base. */
  signature: string;
}

export type BaseScan =
  | {
      ok: true;
      failures: BaseFailure[];
      notes: string[];
      source: "cache" | "run" | "mixed" | "none";
    }
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Base results for `files` (undefined: the whole suite) in `store`: cached files are reused, the
 * others run on the pristine base checkout at `dir`, and their failing files run a second time
 * (only a failure seen twice is confirmed).
 */
export async function measureOnBase(opts: {
  runner: TestRunner;
  dir: string;
  tmp: string;
  files: readonly string[] | undefined;
  store: BaselineStore;
  roots: readonly string[];
}): Promise<{ ok: true; ran: number; cached: number } | { ok: false; reason: string }> {
  const wanted = opts.files === undefined ? undefined : [...new Set(opts.files)];
  const toRun = wanted?.filter((f) => !opts.store.has(f));
  const cached = wanted === undefined ? 0 : wanted.length - (toRun?.length ?? 0);
  // A selected test file that does not exist on base has no failures there.
  const absent = toRun?.filter((f) => !existsSync(join(opts.dir, f))) ?? [];
  if (absent.length > 0) opts.store.record(absent, EMPTY_RUN, null, opts.roots);
  const present = toRun?.filter((f) => !absent.includes(f));
  if (present !== undefined && present.length === 0) return { ok: true, ran: 0, cached };
  const first = await runTests({
    runner: opts.runner,
    dir: opts.dir,
    ...(present === undefined ? {} : { files: present }),
    reportPath: join(opts.tmp, `base-run-${Date.now()}.json`),
  });
  if (!first.ok)
    return {
      ok: false,
      reason: `the tests did not run on base: ${first.error ?? "unknown error"}`,
    };
  const ran = present ?? [
    ...new Set([...first.files.map((f) => f.file), ...first.tests.map((t) => t.file)]),
  ];
  const failing = failingFiles(first);
  let confirm: TestRunOutput | null = null;
  if (failing.length > 0) {
    confirm = await runTests({
      runner: opts.runner,
      dir: opts.dir,
      files: failing,
      reportPath: join(opts.tmp, `base-confirm-${Date.now()}.json`),
    });
    if (!confirm.ok)
      return {
        ok: false,
        reason: `re-running base's failing tests failed: ${confirm.error ?? "unknown error"}`,
      };
  }
  opts.store.record(ran, first, confirm, opts.roots);
  return { ok: true, ran: ran.length, cached };
}

const EMPTY_RUN: TestRunOutput = {
  ok: true,
  exitCode: 0,
  timedOut: false,
  durationMs: 0,
  files: [],
  tests: [],
  outputTail: "",
};

/** Files with a failing test or a load error. */
export function failingFiles(run: TestRunOutput): string[] {
  const out = new Set<string>();
  for (const t of run.tests) if (t.outcome === "fail") out.add(t.file);
  for (const f of run.files) if (f.loadError !== null) out.add(f.file);
  return [...out];
}

/** Base failures among `files` seen in one run only (flaky: never a red). */
function flakyCount(store: BaselineStore, files: readonly string[]): number {
  let n = 0;
  for (const file of files) {
    const entry = store.get(file);
    if (entry === undefined) continue;
    if (entry.loadError !== null && entry.loadConfirmed !== true) n += 1;
    for (const t of Object.values(entry.tests))
      if (t.outcome === "fail" && t.confirmed !== true) n += 1;
  }
  return n;
}

/** Confirmed base failures among `files` (undefined: every file in the store). */
export function baseFailures(store: BaselineStore, files: readonly string[]): BaseFailure[] {
  const out: BaseFailure[] = [];
  for (const file of files) {
    const entry = store.get(file);
    if (entry === undefined) continue;
    if (entry.loadError !== null) {
      if (entry.loadConfirmed === true)
        out.push({ id: file, file, path: null, outcome: "error", signature: entry.loadError });
      continue;
    }
    for (const [id, t] of Object.entries(entry.tests)) {
      if (t.outcome !== "fail" || t.confirmed !== true) continue;
      const name = id.startsWith(`${file} > `) ? id.slice(file.length + 3) : id;
      out.push({
        id,
        file,
        path: name.split(" > "),
        outcome: "fail",
        signature: t.signature ?? "",
      });
    }
  }
  return out;
}

/**
 * Pre-existing failures among the selected test files (undefined: the whole suite) on the
 * pristine base checkout at `dir`, through the baseline store (cache, then measured).
 */
export async function scanBase(opts: {
  runner: TestRunner;
  dir: string;
  tmp: string;
  files: readonly string[] | undefined;
  store: BaselineStore;
  roots: readonly string[];
}): Promise<BaseScan> {
  const measured = await measureOnBase(opts);
  if (!measured.ok) return measured;
  const files = opts.files ?? opts.store.knownFiles();
  const failures = baseFailures(opts.store, files);
  const unloadable = failures.filter((f) => f.path === null).length;
  const source =
    measured.ran === 0
      ? measured.cached === 0
        ? "none"
        : "cache"
      : measured.cached === 0
        ? "run"
        : "mixed";
  const notes = [
    failures.length === 0
      ? "no test fails on base as committed"
      : `on base as committed: ${plural(failures.length - unloadable, "test")} fail` +
        (unloadable > 0 ? `, ${plural(unloadable, "test file")} fail to load` : ""),
  ];
  const flaky = flakyCount(opts.store, files);
  if (flaky > 0)
    notes.push(`${plural(flaky, "test")} failed once on base, then passed (flaky: not red)`);
  if (measured.cached > 0)
    notes.push(`base results of ${plural(measured.cached, "test file")} from the cache`);
  return { ok: true, failures, notes, source };
}

export interface PreexistingListing {
  tests: TestRef[];
  base: TestResult[];
  head: TestResult[];
  /** Ids that fail on base and pass on head. */
  fixed: string[];
  /** Ids that fail on base and fail differently (or error) on head: listed, they block a proof. */
  stillFailing: string[];
  /** Fail on base and fail identically on head: pre-existing, not listed. */
  identical: (TestRef & { message?: string })[];
  /** Base failures with no outcome at head (deleted, renamed or skipped there). */
  gone: string[];
}

/** The signature of a test's failure in `run` (its file's load error when it has no result). */
function headSignature(
  run: TestRunOutput,
  id: string,
  file: string,
  roots: readonly string[],
): string {
  const failed = run.tests.find((t) => t.id === id && t.outcome === "fail");
  if (failed !== undefined) return failureSignature(failed.message, roots);
  return failureSignature(run.files.find((f) => f.file === file)?.loadError, roots);
}

/**
 * Base failures, by their outcome in `headRun` (which ran their files). Ids in `exclude` (the
 * new/changed tests, measured with head's test files on base) are left to that measurement. A
 * failure that is identical at head (same signature) is pre-existing: it neither proves nor
 * blocks anything, so it is reported apart instead of listed.
 */
export function listPreexisting(
  failures: readonly BaseFailure[],
  headRun: TestRunOutput,
  exclude: ReadonlySet<string>,
  roots: readonly string[] = [],
): PreexistingListing {
  const out: PreexistingListing = {
    tests: [],
    base: [],
    head: [],
    fixed: [],
    stillFailing: [],
    identical: [],
    gone: [],
  };
  const listed = new Set<string>();
  const add = (ref: TestRef, f: BaseFailure, head: TestOutcome) => {
    if (exclude.has(ref.id) || listed.has(ref.id)) return;
    listed.add(ref.id);
    if (head === "missing") {
      out.gone.push(ref.id);
      return;
    }
    if (head !== "pass" && headSignature(headRun, ref.id, ref.file, roots) === f.signature) {
      out.identical.push({
        ...ref,
        ...(f.signature === "" ? {} : { message: f.signature.slice(0, 500) }),
      });
      return;
    }
    out.tests.push(ref);
    out.base.push({ id: ref.id, outcome: f.outcome });
    out.head.push({ id: ref.id, outcome: head });
    (head === "pass" ? out.fixed : out.stillFailing).push(ref.id);
  };
  for (const f of failures) {
    if (f.path !== null) {
      const name = f.path.join(" > ");
      add({ id: f.id, file: f.file, name }, f, outcomeOn(headRun, f.id, f.file, "head"));
      continue;
    }
    // The file failed to load on base: every test it reports at head was red there.
    const reported = headRun.tests.filter((t) => t.file === f.file);
    if (reported.length > 0) {
      for (const t of reported) {
        const ref = { id: t.id, file: f.file, name: t.path.join(" > ") };
        add(ref, f, outcomeOn(headRun, t.id, f.file, "head"));
      }
      continue;
    }
    const headLoad = headRun.files.find((x) => x.file === f.file)?.loadError ?? null;
    const name = "(the file fails to load on base and on head)";
    add({ id: f.file, file: f.file, name }, f, headLoad !== null ? "error" : "missing");
  }
  return out;
}
