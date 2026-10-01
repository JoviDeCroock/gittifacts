/**
 * Verifies every fixture end to end, so integration tests can trust them:
 *
 *   pnpm tsx scripts/check-fixtures.ts [names...] [--jobs N] [--verbose]
 *
 * For each fixture it materializes the repo, checks out base and head in separate
 * worktrees (node_modules symlinked to the monorepo's install), and then checks:
 *   - fixture.json is valid; .platform/policy.ts at base and head is a valid RepoPolicy
 *   - `tsc` emits declarations at base and head; src + tests type-check at both
 *   - all tests pass at base and at head
 *   - red/green: head's changed test files, run on base, fail where the fixture says
 *   - a public API diff of dist/index.d.ts (base vs head) matches the expectation
 *   - changed files, dependency diff, sensitive-path hits, scope drift, policy change
 *   - transforms: re-running the transform on base reproduces head's tree byte-for-byte,
 *     and re-running it on head is a no-op
 *   - the expected reason codes are consistent with the measured facts
 */
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { RepoPolicy } from "../packages/domain/src/policy.js";
import {
  type ApiClassification,
  DEFAULT_OUT_DIR,
  type Fixture,
  git,
  listFixtureNames,
  matchesGlob,
  materializeFixture,
  REPO_ROOT,
  type RedGreenVerdict,
} from "./lib/fixtures.js";

const NODE_MODULES = join(REPO_ROOT, "node_modules");
const VITEST_BIN = join(NODE_MODULES, "vitest", "vitest.mjs");
const TSC_BIN = join(NODE_MODULES, "typescript", "bin", "tsc");
const POLICY_PATH = ".platform/policy.ts";
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"];

// ---------------------------------------------------------------- process helpers

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

const tail = (text: string, lines = 25): string => text.trim().split("\n").slice(-lines).join("\n");

// ---------------------------------------------------------------- checks

type Status = "pass" | "fail";

interface Check {
  label: string;
  status: Status;
  detail?: string;
}

class Report {
  readonly checks: Check[] = [];
  constructor(readonly name: string) {}

  pass(label: string, detail?: string): void {
    this.checks.push(
      detail === undefined ? { label, status: "pass" } : { label, status: "pass", detail },
    );
  }

  fail(label: string, detail: string): void {
    this.checks.push({ label, status: "fail", detail });
  }

  /** Records pass/fail for a boolean condition. */
  assert(label: string, ok: boolean, detail: string): void {
    if (ok) this.pass(label);
    else this.fail(label, detail);
  }

  /** Compares a measured value with an optional expectation (sets compare order-insensitively). */
  expect<T>(label: string, expected: T | undefined, actual: T): void {
    if (expected === undefined) {
      this.pass(`${label} (no expectation)`, JSON.stringify(actual));
      return;
    }
    const norm = (value: unknown): string =>
      JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
    if (norm(expected) === norm(actual)) this.pass(label, JSON.stringify(actual));
    else
      this.fail(label, `expected ${JSON.stringify(expected)}, measured ${JSON.stringify(actual)}`);
  }

  get failed(): boolean {
    return this.checks.some((check) => check.status === "fail");
  }
}

// ---------------------------------------------------------------- worktrees

async function addWorktree(repo: string, path: string, sha: string, linkModules: boolean) {
  await git(repo, ["worktree", "add", "-q", "--detach", path, sha]);
  if (linkModules) symlinkSync(NODE_MODULES, join(path, "node_modules"), "dir");
  return path;
}

// ---------------------------------------------------------------- tsc

async function buildDeclarations(dir: string, report: Report, side: string): Promise<boolean> {
  const build = await run(process.execPath, [TSC_BIN, "-p", "tsconfig.json"], dir);
  const entry = join(dir, "dist", "index.d.ts");
  const ok = build.code === 0 && existsSync(entry);
  report.assert(
    `tsc build emits dist/index.d.ts at ${side}`,
    ok,
    tail(build.stdout + build.stderr),
  );

  // Type-check sources and tests together (tests are excluded from the build config).
  const checkConfig = join(dir, "tsconfig.check.json");
  writeFileSync(
    checkConfig,
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: true,
        rootDir: ".",
        noUnusedLocals: true,
        noUnusedParameters: true,
      },
      include: ["src", "test"],
    }),
  );
  const check = await run(process.execPath, [TSC_BIN, "-p", "tsconfig.check.json"], dir);
  report.assert(
    `src + tests type-check at ${side}`,
    check.code === 0,
    tail(check.stdout + check.stderr),
  );
  return ok;
}

// ---------------------------------------------------------------- vitest

type Outcome = "pass" | "fail" | "skip";

interface VitestRun {
  ok: boolean;
  /** `<file> > <describe…> > <test>` → outcome */
  tests: Map<string, Outcome>;
  /** Test files that failed to load or run at all. */
  brokenFiles: string[];
  output: string;
}

interface VitestJson {
  testResults?: Array<{
    name: string;
    status?: string;
    message?: string;
    assertionResults?: Array<{ ancestorTitles?: string[]; title: string; status: string }>;
  }>;
}

async function runVitest(
  dir: string,
  label: string,
  files: readonly string[] = [],
): Promise<VitestRun> {
  const out = join(dirname(dir), `${label}.vitest.json`);
  rmSync(out, { force: true });
  const result = await run(
    process.execPath,
    [VITEST_BIN, "run", "--root", dir, "--reporter=json", `--outputFile=${out}`, ...files],
    dir,
  );
  const tests = new Map<string, Outcome>();
  const brokenFiles: string[] = [];
  if (existsSync(out)) {
    const json = JSON.parse(readFileSync(out, "utf8")) as VitestJson;
    const root = realpathSync(dir);
    for (const file of json.testResults ?? []) {
      const path = relative(root, realpathSync(file.name)).split(sep).join(posix.sep);
      const assertions = file.assertionResults ?? [];
      if (assertions.length === 0 && file.status === "failed") brokenFiles.push(path);
      for (const test of assertions) {
        const id = [path, ...(test.ancestorTitles ?? []), test.title].join(" > ");
        const outcome: Outcome =
          test.status === "passed" ? "pass" : test.status === "failed" ? "fail" : "skip";
        tests.set(id, outcome);
      }
    }
  }
  const allPassed = [...tests.values()].every((outcome) => outcome === "pass");
  return {
    ok: result.code === 0 && tests.size > 0 && allPassed && brokenFiles.length === 0,
    tests,
    brokenFiles,
    output: tail(result.stdout + result.stderr),
  };
}

function failures(run: VitestRun): string {
  const failed = [...run.tests].filter(([, outcome]) => outcome !== "pass").map(([id]) => id);
  return (
    [...failed, ...run.brokenFiles.map((file) => `${file} (did not load)`)].join("\n") || run.output
  );
}

// ---------------------------------------------------------------- public API (d.ts)

/** Exported name → normalized declaration text, read from a declaration entry point. */
function exportedApi(entry: string): Map<string, string> {
  const program = ts.createProgram({
    rootNames: [entry],
    options: {
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    },
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`cannot read exports of ${entry}`);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const api = new Map<string, string>();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const text = (target.getDeclarations() ?? [])
      .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()))
      .map((decl) =>
        decl
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .sort()
      .join("\n");
    api.set(symbol.getName(), text);
  }
  return api;
}

interface ApiDiff {
  classification: ApiClassification;
  added: string[];
  changed: string[];
  removed: string[];
}

function diffApi(base: Map<string, string>, head: Map<string, string>): ApiDiff {
  const added = [...head.keys()].filter((name) => !base.has(name)).sort();
  const removed = [...base.keys()].filter((name) => !head.has(name)).sort();
  const changed = [...head.keys()]
    .filter((name) => base.has(name) && base.get(name) !== head.get(name))
    .sort();
  const classification: ApiClassification =
    removed.length > 0 || changed.length > 0 ? "breaking" : added.length > 0 ? "additive" : "none";
  return { classification, added, changed, removed };
}

// ---------------------------------------------------------------- policy & manifests

async function loadPolicy(file: string, report: Report, side: string): Promise<RepoPolicy | null> {
  const label = `${POLICY_PATH} is a valid RepoPolicy at ${side}`;
  try {
    const mod: unknown = await import(pathToFileURL(file).href);
    const value =
      typeof mod === "object" && mod !== null && "default" in mod ? mod.default : undefined;
    if (typeof value !== "object" || value === null) {
      report.fail(label, "default export must be an object literal");
      return null;
    }
    const unknownKeys = Object.keys(value).filter((key) => !(key in RepoPolicy.shape));
    const parsed = RepoPolicy.safeParse(value);
    if (!parsed.success || unknownKeys.length > 0) {
      const problems = [
        ...(unknownKeys.length > 0 ? [`unknown keys: ${unknownKeys.join(", ")}`] : []),
        ...(parsed.success ? [] : [parsed.error.message]),
      ];
      report.fail(label, problems.join("\n"));
      return null;
    }
    report.pass(label);
    return parsed.data;
  } catch (error) {
    report.fail(label, String(error));
    return null;
  }
}

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function dependencyNames(manifestPath: string): Set<string> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const names = new Set<string>();
  for (const section of DEP_SECTIONS) {
    const deps = manifest[section];
    if (typeof deps === "object" && deps !== null) {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------- one fixture

async function checkFixture(name: string): Promise<Report> {
  const report = new Report(name);
  const { dir, baseSha, headSha, fixture } = await materializeFixture(name);
  report.pass("fixture.json is valid and materializes", `base ${baseSha} head ${headSha}`);
  const expected = fixture.expected.evidence;

  const work = join(DEFAULT_OUT_DIR, ".check", name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const base = await addWorktree(dir, join(work, "base"), baseSha, true);
  const head = await addWorktree(dir, join(work, "head"), headSha, true);

  // Changed files.
  const nameStatus = await git(dir, ["diff", "--name-status", "--no-renames", baseSha, headSha]);
  const changes = nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status, path };
    });
  const changedFiles = changes.map((change) => change.path).sort();
  report.expect("changed files", expected.changedFiles, changedFiles);

  // Policy (base governs; head must still be valid).
  const basePolicy = await loadPolicy(join(base, POLICY_PATH), report, "base");
  await loadPolicy(join(head, POLICY_PATH), report, "head");
  if (basePolicy !== null) {
    report.assert(
      "base policy keeps lane0Enabled false (shadow mode)",
      basePolicy.lane0Enabled === false,
      "fixtures assume shadow mode",
    );
  }

  // Builds and type-checks.
  const [baseBuilt, headBuilt] = await Promise.all([
    buildDeclarations(base, report, "base"),
    buildDeclarations(head, report, "head"),
  ]);

  // Tests on each side.
  const [baseRun, headRun] = await Promise.all([runVitest(base, "base"), runVitest(head, "head")]);
  report.assert(`all tests pass at base (${baseRun.tests.size})`, baseRun.ok, failures(baseRun));
  report.assert(`all tests pass at head (${headRun.tests.size})`, headRun.ok, failures(headRun));

  // Red/green: head's added/modified test files, run against base sources.
  const changedTests = changes
    .filter((change) => change.status !== "D" && /^test\/.*\.test\.ts$/.test(change.path))
    .map((change) => change.path);
  let verdict: RedGreenVerdict = "no-tests";
  let failingOnBase: string[] = [];
  if (changedTests.length > 0) {
    const redgreen = await addWorktree(dir, join(work, "redgreen"), baseSha, true);
    for (const file of changedTests) {
      mkdirSync(dirname(join(redgreen, file)), { recursive: true });
      copyFileSync(join(head, file), join(redgreen, file));
    }
    const onBase = await runVitest(redgreen, "redgreen", changedTests);
    const candidates = [...headRun.tests.keys()].filter((id) =>
      changedTests.some((file) => id.startsWith(`${file} > `)),
    );
    const brokenOnBase = new Set(onBase.brokenFiles);
    failingOnBase = candidates
      .filter((id) => {
        const file = changedTests.find((path) => id.startsWith(`${path} > `)) ?? "";
        return brokenOnBase.has(file) || onBase.tests.get(id) !== "pass";
      })
      .sort();
    const allGreenOnHead = candidates.every((id) => headRun.tests.get(id) === "pass");
    verdict =
      candidates.length === 0
        ? "no-tests"
        : failingOnBase.length > 0 && allGreenOnHead
          ? "proven"
          : "not-proven";
  }
  report.expect("red/green verdict", expected.redGreen, verdict);
  if (expected.failingOnBase !== undefined || failingOnBase.length > 0) {
    report.expect("new tests failing on base", expected.failingOnBase, failingOnBase);
  }

  // Public API from the emitted declarations.
  let apiClassification: ApiClassification | undefined;
  if (baseBuilt && headBuilt) {
    const api = diffApi(
      exportedApi(join(base, "dist", "index.d.ts")),
      exportedApi(join(head, "dist", "index.d.ts")),
    );
    apiClassification = api.classification;
    report.expect("public API classification", expected.publicApi, api.classification);
    if (expected.apiAdded !== undefined || api.added.length > 0)
      report.expect("API exports added", expected.apiAdded, api.added);
    if (expected.apiChanged !== undefined || api.changed.length > 0)
      report.expect("API exports changed", expected.apiChanged, api.changed);
    if (expected.apiRemoved !== undefined || api.removed.length > 0)
      report.expect("API exports removed", expected.apiRemoved, api.removed);
  }

  // Dependencies.
  const baseDeps = dependencyNames(join(base, "package.json"));
  const headDeps = dependencyNames(join(head, "package.json"));
  const depsAdded = [...headDeps].filter((dep) => !baseDeps.has(dep)).sort();
  const depsRemoved = [...baseDeps].filter((dep) => !headDeps.has(dep)).sort();
  report.expect("dependencies added", expected.dependenciesAdded, depsAdded);
  if (expected.dependenciesRemoved !== undefined || depsRemoved.length > 0)
    report.expect("dependencies removed", expected.dependenciesRemoved, depsRemoved);
  const lockfileChanged = changedFiles.some((path) => LOCKFILES.includes(posix.basename(path)));
  if (expected.lockfileChanged !== undefined || lockfileChanged)
    report.expect("lockfile changed", expected.lockfileChanged, lockfileChanged);

  // Sensitive paths (patterns from the BASE policy) and scope drift (from the plan).
  const sensitivePatterns = basePolicy?.sensitivePaths ?? [];
  const sensitiveHits = changedFiles.filter((path) =>
    sensitivePatterns.some((pattern) => matchesGlob(path, pattern)),
  );
  report.expect("sensitive-path hits", expected.sensitiveHits, sensitiveHits);
  const scopeDrift = changedFiles.filter(
    (path) => !fixture.plan.scopePaths.some((pattern) => matchesGlob(path, pattern)),
  );
  report.expect("scope drift (outside plan.scopePaths)", expected.scopeDrift, scopeDrift);
  const policyChanged = changedFiles.includes(POLICY_PATH);
  report.expect("policy file changed", expected.policyChanged, policyChanged);

  // Reproducible transform.
  let transformVerified: boolean | undefined;
  if (fixture.transform !== undefined) {
    transformVerified = await checkTransform(fixture, dir, work, baseSha, headSha, report);
    report.expect("transform reproduces head", expected.transformVerified, transformVerified);
  }

  // Expected reason codes must agree with what was measured.
  const { computedLane, laneWithShadow, requiresHumanApproval } = fixture.expected;
  const shadowed = computedLane === 0 && basePolicy?.lane0Enabled === false;
  const platformChanged = changedFiles.some((path) => path.startsWith(".platform/"));
  checkReasonCodes(fixture, report, {
    sensitive: sensitiveHits.length > 0,
    drift: scopeDrift.length > 0,
    depsAdded: depsAdded.length > 0,
    platformChanged,
    verdict,
    api: apiClassification,
    transformVerified,
    shadowed,
  });
  report.assert(
    "requiresHumanApproval iff something under .platform/ changed",
    requiresHumanApproval === platformChanged,
    `requiresHumanApproval is ${requiresHumanApproval}, .platform/ changed: ${platformChanged}`,
  );
  const shadowLane = shadowed ? 1 : computedLane;
  report.assert(
    "laneWithShadow follows shadow mode",
    laneWithShadow === shadowLane,
    `computedLane ${computedLane} with lane0Enabled=false should route to ${shadowLane}`,
  );
  if (computedLane === 0) {
    report.assert(
      "a Lane 0 expectation has proof (red/green proven or verified transform)",
      verdict === "proven" || transformVerified === true,
      `red/green is ${verdict}`,
    );
  }
  return report;
}

async function checkTransform(
  fixture: Fixture,
  repo: string,
  work: string,
  baseSha: string,
  headSha: string,
  report: Report,
): Promise<boolean> {
  const transform = fixture.transform;
  if (transform === undefined) return false;
  const scratch = await addWorktree(repo, join(work, "transform"), baseSha, false);
  if (transform.source === "head") {
    // Read the blob untrimmed: the script must be byte-identical to head's copy.
    const blob = await run("git", ["show", `${headSha}:${transform.script}`], repo);
    mkdirSync(dirname(join(scratch, transform.script)), { recursive: true });
    writeFileSync(join(scratch, transform.script), blob.stdout);
  } else {
    report.assert(
      `transform script exists at base (${transform.script})`,
      existsSync(join(scratch, transform.script)),
      "source is base but the script is not in the base tree",
    );
  }
  const ran = await run("sh", ["-c", transform.command], scratch);
  report.assert("transform runs cleanly on base", ran.code === 0, tail(ran.stdout + ran.stderr));
  await git(scratch, ["add", "-A"]);
  const producedTree = await git(scratch, ["write-tree"]);
  const headTree = await git(repo, ["rev-parse", `${headSha}^{tree}`]);
  const mismatched = await git(repo, ["diff", "--name-only", producedTree, headTree]);
  const verified = producedTree === headTree;
  report.assert(
    "transform output tree is byte-identical to head",
    verified,
    `tree ${producedTree} != ${headTree}; differing: ${mismatched.split("\n").join(", ")}`,
  );

  const again = await addWorktree(repo, join(work, "transform-idempotent"), headSha, false);
  const rerun = await run("sh", ["-c", transform.command], again);
  const dirty = await git(again, ["status", "--porcelain"]);
  report.assert(
    "transform is idempotent (re-run on head is a no-op)",
    rerun.code === 0 && dirty === "",
    dirty || tail(rerun.stdout + rerun.stderr),
  );
  return verified;
}

interface Facts {
  sensitive: boolean;
  drift: boolean;
  depsAdded: boolean;
  platformChanged: boolean;
  verdict: RedGreenVerdict;
  /** Measured API classification; undefined when declarations could not be built. */
  api: ApiClassification | undefined;
  transformVerified: boolean | undefined;
  shadowed: boolean;
}

const RED_GREEN_CODES: Record<RedGreenVerdict, string> = {
  proven: "red-green.proven",
  "not-proven": "red-green.not-proven",
  "no-tests": "red-green.no-tests",
};

/**
 * The expected reason codes (names from packages/classifier REASON_CODES) must agree with
 * the facts measured here: a code is listed exactly when its condition holds.
 */
function checkReasonCodes(fixture: Fixture, report: Report, facts: Facts): void {
  const codes = new Set(fixture.expected.reasonCodes);
  const pairs: Array<[string, boolean]> = [
    ["sensitive.hit", facts.sensitive],
    ["scope.drift", facts.drift],
    ["dependency.added", facts.depsAdded],
    ["policy.changed", facts.platformChanged],
    ["transform.verified", facts.transformVerified === true],
    ["shadow.lane0-disabled", facts.shadowed],
  ];
  if (facts.api !== undefined) {
    pairs.push(
      ["api.breaking", facts.api === "breaking"],
      ["api.additive", facts.api === "additive"],
    );
  }
  // Red/green only gates claimed fixes; other categories get "red-green.not-required".
  for (const [verdict, code] of Object.entries(RED_GREEN_CODES)) {
    pairs.push([code, fixture.claim.category === "fix" && facts.verdict === verdict]);
  }
  const mismatched = pairs
    .filter(([code, measured]) => codes.has(code) !== measured)
    .map(
      ([code, measured]) =>
        `${code}: ${measured ? "condition holds but code not listed" : "listed but condition does not hold"}`,
    );
  report.assert(
    "expected reason codes match the measured facts",
    mismatched.length === 0,
    mismatched.join("; "),
  );
}

// ---------------------------------------------------------------- main

async function pool<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let jobs = 3;
  let verbose = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--jobs" || arg === "-j") jobs = Number(args[++i]);
    else if (arg.startsWith("--jobs=")) jobs = Number(arg.slice("--jobs=".length));
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg !== "--") names.push(arg);
  }
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer");
  if (!existsSync(VITEST_BIN) || !existsSync(TSC_BIN)) {
    throw new Error("vitest/typescript are not installed at the monorepo root; run pnpm install");
  }
  const selected = names.length > 0 ? names : listFixtureNames();
  const started = Date.now();
  const reports = await pool(selected, jobs, async (name) => {
    try {
      return await checkFixture(name);
    } catch (error) {
      const report = new Report(name);
      report.fail(
        "fixture check crashed",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      return report;
    }
  });

  for (const report of reports) {
    console.log(`\n${report.failed ? "FAIL" : "ok  "} ${report.name}`);
    for (const check of report.checks) {
      const mark = check.status === "pass" ? "  ✓" : "  ✗";
      const showDetail =
        verbose || check.status === "fail" || check.label.endsWith("(no expectation)");
      console.log(
        `${mark} ${check.label}${showDetail && check.detail ? `\n      ${check.detail.split("\n").join("\n      ")}` : ""}`,
      );
    }
  }
  const failed = reports.filter((report) => report.failed);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${reports.length - failed.length}/${reports.length} fixtures verified in ${seconds}s` +
      (failed.length > 0 ? ` — failing: ${failed.map((report) => report.name).join(", ")}` : ""),
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
