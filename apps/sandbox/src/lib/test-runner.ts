/**
 * Detecting and driving the repository's test runner (vitest or jest) with a JSON reporter.
 *
 * The runner's own binary is resolved from the checkout's node_modules and invoked directly
 * (`node <bin> ...`), because reporter flags can't be appended reliably to an arbitrary shell
 * command. The test command (or the package.json `test` script) decides WHICH runner and keeps
 * its config-selecting flags (`--config`, `--project`, ...).
 */
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
import { z } from "zod";
import { errorMessage, log, tail } from "./log.js";
import { run } from "./proc.js";

export type RunnerKind = "vitest" | "jest";

export interface TestRunner {
  kind: RunnerKind;
  /** Absolute path of the runner's JS entry, run with `node`. */
  bin: string;
  /** Version of the runner package, when readable. */
  version: string | null;
  /** Flags kept from the test script (config selection). */
  args: string[];
  /** How the runner was found, for notes. */
  source: string;
}

export type DetectResult = { ok: true; runner: TestRunner } | { ok: false; reason: string };

const PackageJson = z
  .object({
    scripts: z.record(z.string(), z.unknown()).optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
    devDependencies: z.record(z.string(), z.unknown()).optional(),
    version: z.string().optional(),
    bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  })
  .passthrough();
type PackageJson = z.infer<typeof PackageJson>;

function readPackageJson(path: string): PackageJson | null {
  try {
    const parsed = PackageJson.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Minimal shell-word split (quotes, no expansion). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur !== "") words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur !== "") words.push(cur);
  return words;
}

const PM_RUN = /^(pnpm|npm|yarn|bun)$/;

/** Flags (with a value) kept from a test script, per runner. */
const KEEP_FLAGS: Record<RunnerKind, readonly string[]> = {
  vitest: ["--config", "-c", "--project", "--dir", "--root", "-r", "--environment", "--pool", "--mode"],
  jest: ["--config", "-c", "--selectProjects", "--rootDir", "--roots", "--testEnvironment"],
};

function keptArgs(kind: RunnerKind, words: readonly string[]): string[] {
  const keep = KEEP_FLAGS[kind];
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    const eq = w.indexOf("=");
    const flag = eq > 0 ? w.slice(0, eq) : w;
    if (!keep.includes(flag)) continue;
    if (eq > 0) out.push(w);
    else if (i + 1 < words.length) out.push(w, words[++i] ?? "");
  }
  return out;
}

interface CommandScan {
  kind: RunnerKind | null;
  args: string[];
  via: string;
}

/** Find the runner a command line invokes, following `pm run <script>` up to a few levels. */
function scanCommand(command: string, pkg: PackageJson | null, depth = 0): CommandScan {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = shellWords(segment.trim());
    // Skip env assignments and wrappers.
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
    while (i < words.length && ["npx", "cross-env", "dotenv", "--", "exec", "dlx"].includes(words[i] ?? "")) {
      i++;
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
    }
    const first = words[i] ?? "";
    const rest = words.slice(i + 1);
    const base = first.split("/").pop() ?? first;
    if (base === "vitest" || base === "jest") {
      return { kind: base, args: keptArgs(base, rest), via: segment.trim() };
    }
    if (PM_RUN.test(first) && depth < 4) {
      // pnpm [run|exec] <x>, npm [run|test], yarn [run] <x>, bun run <x>
      let j = 0;
      if (rest[j] === "run" || rest[j] === "run-script" || rest[j] === "exec") j++;
      const target = rest[j] ?? "";
      if (target === "vitest" || target === "jest") {
        return { kind: target, args: keptArgs(target, rest.slice(j + 1)), via: segment.trim() };
      }
      const script = pkg?.scripts?.[target === "t" ? "test" : target];
      if (typeof script === "string") {
        const inner = scanCommand(script, pkg, depth + 1);
        if (inner.kind !== null) return { ...inner, via: `${segment.trim()} → ${inner.via}` };
      }
    }
  }
  return { kind: null, args: [], via: command };
}

function resolveBin(dir: string, kind: RunnerKind): { bin: string; version: string | null } | null {
  const require = createRequire(join(dir, "package.json"));
  let pkgPath: string;
  try {
    pkgPath = require.resolve(`${kind}/package.json`);
  } catch {
    return null;
  }
  const pkg = readPackageJson(pkgPath);
  const binField = pkg?.bin;
  const rel = typeof binField === "string" ? binField : (binField?.[kind] ?? null);
  const fallback = kind === "vitest" ? "vitest.mjs" : "bin/jest.js";
  const bin = join(dirname(pkgPath), rel ?? fallback);
  if (!existsSync(bin)) return null;
  return { bin, version: pkg?.version ?? null };
}

/** Which runner the repository uses and where its binary is. */
export function detectTestRunner(dir: string, testCommand?: string | null): DetectResult {
  const pkg = readPackageJson(join(dir, "package.json"));
  let scan: CommandScan = { kind: null, args: [], via: "" };
  if (testCommand) scan = scanCommand(testCommand, pkg);
  if (scan.kind === null) {
    const script = pkg?.scripts?.test;
    if (typeof script === "string") scan = scanCommand(script, pkg);
  }
  if (scan.kind === null) {
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    if ("vitest" in deps) scan = { kind: "vitest", args: [], via: "vitest in package.json dependencies" };
    else if ("jest" in deps) scan = { kind: "jest", args: [], via: "jest in package.json dependencies" };
  }
  if (scan.kind === null) {
    const what = testCommand ? `test command ${JSON.stringify(testCommand)}` : "package.json test script";
    return { ok: false, reason: `could not find a supported test runner (vitest or jest) in the ${what}` };
  }
  const resolved = resolveBin(dir, scan.kind);
  if (resolved === null) {
    return {
      ok: false,
      reason: `the repository uses ${scan.kind} (${scan.via}) but it is not installed (cannot resolve ${scan.kind}/package.json from ${dir}); did the install step run?`,
    };
  }
  return {
    ok: true,
    runner: { kind: scan.kind, bin: resolved.bin, version: resolved.version, args: scan.args, source: scan.via },
  };
}

// ---------------------------------------------------------------- JSON results

const AssertionResult = z
  .object({
    ancestorTitles: z.array(z.string()).optional(),
    title: z.string(),
    fullName: z.string().optional(),
    status: z.string(),
    duration: z.number().nullable().optional(),
    failureMessages: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const FileResult = z
  .object({
    name: z.string(),
    status: z.string().optional(),
    message: z.string().nullable().optional(),
    assertionResults: z.array(AssertionResult).optional(),
  })
  .passthrough();

const JsonReport = z
  .object({
    numTotalTests: z.number().optional(),
    success: z.boolean().optional(),
    startTime: z.number().optional(),
    testResults: z.array(FileResult),
  })
  .passthrough();

export type CaseOutcome = "pass" | "fail" | "skip";

export interface TestCaseResult {
  /** `<file> > <describe…> > <title>`. */
  id: string;
  file: string;
  /** Describe titles and the test title. */
  path: string[];
  outcome: CaseOutcome;
  message?: string;
  durationMs: number;
}

export interface TestFileResult {
  file: string;
  /** The file failed before reporting any test (import/syntax error, suite crash). */
  loadError: string | null;
}

export interface TestRunOutput {
  /** A JSON report was produced and parsed. */
  ok: boolean;
  /** Why not, when !ok. */
  error?: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  files: TestFileResult[];
  tests: TestCaseResult[];
  /** Tail of the runner's output, for notes. */
  outputTail: string;
}

export function testId(file: string, path: readonly string[]): string {
  return [file, ...path].join(" > ");
}

function toPosixRelative(root: string, file: string): string {
  let abs = file;
  try {
    abs = realpathSync(file);
  } catch {
    // Reported file may be gone (temp files); keep as is.
  }
  let rootReal = root;
  try {
    rootReal = realpathSync(root);
  } catch {
    // ignore
  }
  const rel = relative(rootReal, abs);
  return rel.split(sep).join(posix.sep);
}

function outcomeOf(status: string): CaseOutcome {
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  return "skip";
}

export function parseJsonReport(json: unknown, root: string): { files: TestFileResult[]; tests: TestCaseResult[] } {
  const report = JsonReport.parse(json);
  const files: TestFileResult[] = [];
  const tests: TestCaseResult[] = [];
  for (const f of report.testResults) {
    const file = toPosixRelative(root, f.name);
    const assertions = f.assertionResults ?? [];
    const failedToLoad = assertions.length === 0 && f.status === "failed";
    files.push({ file, loadError: failedToLoad ? (f.message ?? "test file failed to run").slice(0, 2000) : null });
    for (const a of assertions) {
      const path = [...(a.ancestorTitles ?? []), a.title];
      const message = (a.failureMessages ?? []).join("\n").slice(0, 2000);
      const test: TestCaseResult = {
        id: testId(file, path),
        file,
        path,
        outcome: outcomeOf(a.status),
        durationMs: Math.max(0, a.duration ?? 0),
      };
      if (message !== "") test.message = message;
      tests.push(test);
    }
  }
  return { files, tests };
}

export interface RunTestsOptions {
  runner: TestRunner;
  /** Directory to run in (the checkout root). */
  dir: string;
  /** Repo-relative test files to restrict the run to (empty: the whole suite). */
  files?: readonly string[];
  /** Where to write the JSON report. */
  reportPath: string;
  /** Extra runner flags (e.g. coverage). */
  extraArgs?: readonly string[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export function runnerArgs(opts: RunTestsOptions): string[] {
  const { runner, reportPath } = opts;
  const files = opts.files ?? [];
  if (runner.kind === "vitest") {
    return [
      runner.bin,
      "run",
      ...runner.args,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
      "--passWithNoTests",
      ...(opts.extraArgs ?? []),
      ...files,
    ];
  }
  return [
    runner.bin,
    "--ci",
    "--json",
    `--outputFile=${reportPath}`,
    "--passWithNoTests",
    ...runner.args,
    ...(opts.extraArgs ?? []),
    ...(files.length > 0 ? ["--runTestsByPath", ...files] : []),
  ];
}

/** Run tests and parse the JSON report. Never throws for test failures. */
export async function runTests(opts: RunTestsOptions): Promise<TestRunOutput> {
  rmSync(opts.reportPath, { force: true });
  const args = runnerArgs(opts);
  log(`running ${opts.runner.kind} in ${opts.dir}${opts.files?.length ? ` (${opts.files.length} file(s))` : ""}`);
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(process.execPath, args, {
      cwd: opts.dir,
      timeoutMs: opts.timeoutMs ?? 20 * 60_000,
      ...(opts.env === undefined ? {} : { env: opts.env }),
    });
  } catch (error) {
    return {
      ok: false,
      error: `could not start ${opts.runner.kind}: ${errorMessage(error)}`,
      exitCode: -1,
      timedOut: false,
      durationMs: 0,
      files: [],
      tests: [],
      outputTail: "",
    };
  }
  const outputTail = tail(result.stdout + result.stderr, 25);
  const base = {
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputTail,
  };
  if (result.timedOut) {
    return { ...base, ok: false, error: `${opts.runner.kind} timed out after ${Math.round(result.durationMs / 1000)}s`, files: [], tests: [] };
  }
  if (!existsSync(opts.reportPath)) {
    return {
      ...base,
      ok: false,
      error: `${opts.runner.kind} exited ${result.code} without writing a JSON report: ${outputTail}`,
      files: [],
      tests: [],
    };
  }
  try {
    const parsed = parseJsonReport(JSON.parse(readFileSync(opts.reportPath, "utf8")), opts.dir);
    return { ...base, ok: true, ...parsed };
  } catch (error) {
    return { ...base, ok: false, error: `unreadable ${opts.runner.kind} JSON report: ${errorMessage(error)}`, files: [], tests: [] };
  }
}
