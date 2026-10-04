/**
 * Import detection: what `gittifacts-runner detect` reports about a checked-out repository, and
 * what the platform turns into a proposed `.platform/*` + AGENTS.md (a Plan + Change a human
 * approves, never applied silently).
 *
 * `inspectRepo` is pure: callers pass the tracked file list and a reader (the sandbox reads the
 * checkout, tests pass in-memory files). It starts from `detectProject` and adds what only the
 * file contents can tell: test-runner config files, tsconfig, every wrangler config and its
 * Worker name, monorepo workspaces, and the dependencies whose install scripts pnpm 11 refuses to
 * run until a human approves them (`ERR_PNPM_IGNORED_BUILDS`). Whatever it can't tell for sure
 * goes into `uncertain`, one plain sentence each: the import Plan lists every one of them.
 */
import { z } from "zod";
import {
  type Commands,
  type Confidence,
  commandsFor,
  type Detection,
  detectProject,
  type PackageManager,
  type ProjectFeatures,
  type TestRunner,
} from "./project.js";

/**
 * Start of the `uncertain` sentence about unapproved install scripts (pnpm 11). The import Plan
 * gives these dependencies their own risk, so it skips this sentence among the doubts.
 */
export const BUILD_SCRIPTS_DOUBT =
  "pnpm 11 refuses to install until install scripts are approved (ERR_PNPM_IGNORED_BUILDS)";

/** Marker of the `detect` result line on the runner's stdout. */
export const DETECT_PREFIX = "::detect::";
export const DETECT_REPORT_VERSION = 1;

export interface RepoTree {
  /** Repository-relative paths of tracked files (no node_modules, no .git). */
  files: readonly string[];
  /** Text of a file, or null when it is absent, binary or too large to read. */
  read(path: string): string | null;
}

// ---------------------------------------------------------------- report schema

const PackageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]);
const TestRunnerSchema = z.enum(["vitest", "jest", "node", "unknown"]);

export const ProjectFeaturesSchema = z
  .object({
    hasPackageJson: z.boolean(),
    packageManager: PackageManagerSchema,
    lockfile: z.string().nullable(),
    scripts: z.object({
      lint: z.string().nullable(),
      typecheck: z.string().nullable(),
      test: z.string().nullable(),
      build: z.string().nullable(),
    }),
    typescript: z.boolean(),
    testRunner: TestRunnerSchema.nullable(),
    worker: z.boolean(),
    cacheInputs: z.array(z.string()).nullable(),
  })
  .strict();

export const BuildScriptDependency = z
  .object({
    name: z.string().min(1).max(214),
    /** Versions found in the lockfile (empty: only declared in a manifest). */
    versions: z.array(z.string().max(100)).max(20),
    /**
     * `lockfile`: the lockfile says it has install scripts (npm's `hasInstallScript`).
     * `known`: a well-known package with install scripts (pnpm/yarn lockfiles don't record them).
     */
    source: z.enum(["lockfile", "known"]),
  })
  .strict();
export type BuildScriptDependency = z.infer<typeof BuildScriptDependency>;

export const DetectReport = z
  .object({
    version: z.literal(DETECT_REPORT_VERSION),
    /** The commit inspected, when the caller knows it. */
    sha: z.string().nullable(),
    features: ProjectFeaturesSchema,
    confidence: z.enum(["high", "medium", "low"]),
    /** One plain sentence per guess; the import Plan lists every one as a risk. */
    uncertain: z.array(z.string().min(1).max(2000)).max(100),
    packageManager: PackageManagerSchema,
    /** `packageManager` field of package.json, e.g. "pnpm@11.27.0". */
    packageManagerSpec: z.string().nullable(),
    lockfile: z.string().nullable(),
    testRunner: TestRunnerSchema.nullable(),
    /** Runner config files found at the root (vitest.config.ts, jest.config.js, ...). */
    testConfigs: z.array(z.string()).max(20),
    installCommand: z.string(),
    testCommand: z.string().nullable(),
    buildCommand: z.string().nullable(),
    typecheckCommand: z.string().nullable(),
    lintCommand: z.string().nullable(),
    tsconfig: z
      .object({
        path: z.string(),
        extends: z.string().nullable(),
        strict: z.boolean().nullable(),
        /** Project references (`references`), i.e. `tsc -b` builds. */
        references: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /** `name` of every Worker (wrangler config); unnamed configs are listed in `uncertain`. */
    workers: z.array(z.string().max(200)).max(100),
    workerConfigs: z
      .array(z.object({ path: z.string(), name: z.string().nullable() }).strict())
      .max(100),
    /** Monorepo package globs (package.json `workspaces` / pnpm-workspace.yaml `packages`). */
    workspaces: z.array(z.string().max(300)).max(200),
    /** pnpm: dependencies whose install scripts would fail the install until approved. */
    buildScriptsNeedingApproval: z.array(BuildScriptDependency).max(200),
    /** pnpm: dependencies already allowed to run install scripts (allowBuilds/onlyBuiltDependencies). */
    approvedBuilds: z.array(z.string().max(214)).max(500),
    /** Informational facts that are not doubts. */
    notes: z.array(z.string().min(1).max(2000)).max(50),
  })
  .strict();
export type DetectReport = z.infer<typeof DetectReport>;

/** The `::detect::` document in runner output (the last such line), validated; null if absent. */
export function parseDetectOutput(text: string): DetectReport | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith(DETECT_PREFIX)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line.slice(DETECT_PREFIX.length));
    } catch {
      return null;
    }
    const parsed = DetectReport.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

// ---------------------------------------------------------------- small parsers

/** JSON with comments and trailing commas (tsconfig, wrangler.jsonc). Null when unparseable. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as unknown;
  } catch {
    return null;
  }
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Lines of a top-level YAML block (`key:` at column 0) up to the next top-level key, or the
 * inline value after `key:` when the block is written on one line. Enough for the handful of
 * pnpm settings detection reads; anything fancier counts as unreadable.
 */
function yamlBlock(text: string, key: string): { inline: string; lines: string[] } | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (start === -1) return null;
  const inline = (lines[start] ?? "").replace(new RegExp(`^${key}\\s*:`), "").trim();
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    body.push(line);
  }
  return { inline, lines: body };
}

/** A YAML list (`- a` lines, or `[a, b]` inline) under a top-level key. */
function yamlList(text: string, key: string): string[] {
  const block = yamlBlock(text, key);
  if (block === null) return [];
  if (block.inline.startsWith("[")) {
    return block.inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter((s) => s !== "");
  }
  return block.lines
    .map((l) => /^\s+-\s+(.+?)\s*(#.*)?$/.exec(l)?.[1])
    .filter((s): s is string => s !== undefined)
    .map(unquote);
}

/** A YAML map of `name: value` lines under a top-level key (pnpm 11 `allowBuilds`). */
function yamlMap(text: string, key: string): Map<string, string> {
  const out = new Map<string, string>();
  const block = yamlBlock(text, key);
  if (block === null) return out;
  for (const line of block.lines) {
    const m = /^\s+(['"]?[^'":\s][^'":]*['"]?)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m?.[1] !== undefined) out.set(unquote(m[1]), unquote(m[2] ?? ""));
  }
  return out;
}

// ---------------------------------------------------------------- install scripts

/**
 * Well-known packages that run install scripts (native builds or binary downloads). pnpm and
 * yarn lockfiles don't record install scripts, so for them this list is the evidence, which is
 * why detection says so in `uncertain`.
 */
export const KNOWN_BUILD_SCRIPT_PACKAGES: readonly string[] = [
  "@parcel/watcher",
  "@prisma/client",
  "@prisma/engines",
  "@scarf/scarf",
  "@sentry/cli",
  "@serialport/bindings-cpp",
  "@swc/core",
  "@vscode/ripgrep",
  "argon2",
  "bcrypt",
  "better-sqlite3",
  "bufferutil",
  "canvas",
  "chromedriver",
  "core-js",
  "core-js-pure",
  "cpu-features",
  "cypress",
  "deasync",
  "electron",
  "es5-ext",
  "esbuild",
  "fsevents",
  "geckodriver",
  "keytar",
  "kerberos",
  "leveldown",
  "lefthook",
  "msgpackr-extract",
  "node-pty",
  "node-sass",
  "nx",
  "prisma",
  "protobufjs",
  "puppeteer",
  "re2",
  "sharp",
  "sqlite3",
  "ssh2",
  "unrs-resolver",
  "utf-8-validate",
  "vue-demi",
  "workerd",
  "zeromq",
];

/** `name@version` keys of a pnpm lockfile's `packages:` section. */
export function pnpmLockPackages(lock: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const block = yamlBlock(lock, "packages");
  if (block === null) return out;
  for (const line of block.lines) {
    // v9: `  esbuild@0.25.0:` / `  '@scope/x@1.0.0':`; v6: `  /esbuild@0.25.0:`.
    const m = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^@\s'"/]+)@([^\s'":(]+)/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    const versions = out.get(m[1]) ?? [];
    if (!versions.includes(m[2])) versions.push(m[2]);
    out.set(m[1], versions);
  }
  return out;
}

/** The platform CI and preview runners: what a lockfile's `os`/`cpu`/`libc` fields are matched against. */
export const RUNNER_PLATFORM = { os: "linux", cpu: "x64", libc: "glibc" } as const;

/** npm/pnpm platform list semantics: empty = any; `!x` excludes x; otherwise x must be listed. */
function platformAllows(list: readonly string[], value: string): boolean {
  if (list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((v) => !v.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

/** `[a, b]` or `a` → values (quotes dropped). */
function inlineList(text: string): string[] {
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(unquote)
    .filter((s) => s !== "");
}

/**
 * Package names whose every pnpm lockfile entry is restricted (`os`, `cpu`, `libc`) to platforms
 * other than the runner's (`RUNNER_PLATFORM`): pnpm never installs them there, so their install
 * scripts never run in CI (`fsevents`: `os: [darwin]`).
 */
export function pnpmLockSkippedOnRunner(lock: string): Set<string> {
  const block = yamlBlock(lock, "packages");
  if (block === null) return new Set();
  const installable = new Map<string, boolean>();
  let current: { name: string; fields: Record<string, string[]> } | null = null;
  let listKey: string | null = null;
  const close = () => {
    if (current === null) return;
    const f = current.fields;
    const ok =
      platformAllows(f.os ?? [], RUNNER_PLATFORM.os) &&
      platformAllows(f.cpu ?? [], RUNNER_PLATFORM.cpu) &&
      platformAllows(f.libc ?? [], RUNNER_PLATFORM.libc);
    installable.set(current.name, (installable.get(current.name) ?? false) || ok);
  };
  for (const line of block.lines) {
    const entry = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^@\s'"/]+)@[^\s'":(]+/.exec(line);
    if (entry?.[1] !== undefined) {
      close();
      current = { name: entry[1], fields: {} };
      listKey = null;
      continue;
    }
    if (current === null) continue;
    const field = /^ {4}(os|cpu|libc)\s*:\s*(.*?)\s*$/.exec(line);
    if (field?.[1] !== undefined) {
      listKey = field[2] === "" ? field[1] : null;
      current.fields[field[1]] = field[2] === "" ? [] : inlineList(field[2] ?? "");
      continue;
    }
    const item = /^ {6}-\s+(.+?)\s*$/.exec(line);
    if (listKey !== null && item?.[1] !== undefined) {
      current.fields[listKey]?.push(unquote(item[1]));
      continue;
    }
    if (/^ {4}\S/.test(line)) listKey = null;
  }
  close();
  return new Set([...installable].filter(([, ok]) => !ok).map(([name]) => name));
}

/** npm lockfile packages flagged `hasInstallScript`. */
export function npmInstallScriptPackages(lock: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lock) as unknown;
  } catch {
    return out;
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (typeof packages !== "object" || packages === null) return out;
  for (const [path, meta] of Object.entries(packages as Record<string, unknown>)) {
    if (typeof meta !== "object" || meta === null) continue;
    if ((meta as { hasInstallScript?: unknown }).hasInstallScript !== true) continue;
    const name = path.split("node_modules/").at(-1);
    if (name === undefined || name === "") continue;
    const version = (meta as { version?: unknown }).version;
    const versions = out.get(name) ?? [];
    if (typeof version === "string" && !versions.includes(version)) versions.push(version);
    out.set(name, versions);
  }
  return out;
}

// ---------------------------------------------------------------- inspection

const TEST_CONFIG = /^(vitest|jest)\.config\.(ts|mts|cts|js|mjs|cjs|json)$/;
const VITE_CONFIG = /^vite\.config\.(ts|mts|cts|js|mjs|cjs)$/;
const WRANGLER = /(^|\/)wrangler\.(jsonc|json|toml)$/;
/** Paths whose wrangler configs are test fixtures, not Workers of this repo. */
const FIXTURE_DIR = /(^|\/)(node_modules|fixtures?|__fixtures__|test|tests|__tests__|examples?)\//;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workerName(path: string, text: string | null): string | null {
  if (text === null) return null;
  if (path.endsWith(".toml")) {
    // Top-level `name = "..."`, before the first [section].
    const top = text.split(/^\s*\[/m)[0] ?? "";
    return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? null;
  }
  const name = asRecord(parseJsonc(text))?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

function refineTestRunner(
  detected: TestRunner | null,
  configs: readonly string[],
  hasJestField: boolean,
  viteHasTest: boolean,
): { runner: TestRunner | null; doubt: string | null } {
  const vitest = configs.some((c) => c.startsWith("vitest.")) || viteHasTest;
  const jest = configs.some((c) => c.startsWith("jest.")) || hasJestField;
  if (detected === null) return { runner: null, doubt: null };
  if (detected === "unknown") {
    if (vitest && !jest) {
      return {
        runner: "vitest",
        doubt:
          "The test script doesn't call vitest directly; a vitest config suggests vitest (red/green proof and coverage assume it).",
      };
    }
    if (jest && !vitest) {
      return {
        runner: "jest",
        doubt:
          "The test script doesn't call jest directly; a jest config suggests jest (red/green proof and coverage assume it).",
      };
    }
    return { runner: "unknown", doubt: null };
  }
  if (vitest && jest) {
    return {
      runner: detected,
      doubt: `Both vitest and jest are configured; detection picked ${detected} from the test script.`,
    };
  }
  return { runner: detected, doubt: null };
}

function confidenceOf(base: Confidence, extraDoubts: number): Confidence {
  const rank: Confidence[] = ["high", "medium", "low"];
  let i = rank.indexOf(base);
  if (extraDoubts > 0) i = Math.max(i, 1);
  if (extraDoubts > 2) i = 2;
  return rank[i] ?? "low";
}

/** What `gittifacts-runner detect` reports for a checkout. Never throws. */
export function inspectRepo(tree: RepoTree, opts: { sha?: string | null } = {}): DetectReport {
  const files = [...new Set(tree.files)].sort();
  const rootEntries = [...new Set(files.map((f) => f.split("/")[0] ?? f))];
  const has = (path: string) => files.includes(path);
  const pkgText = has("package.json") ? tree.read("package.json") : null;
  const pkgRaw = parseJson(pkgText);
  const pkg = asRecord(pkgRaw);
  const detection: Detection = detectProject({ rootEntries, packageJson: pkgRaw ?? null });
  const features: ProjectFeatures = {
    ...detection.features,
    scripts: { ...detection.features.scripts },
  };
  const uncertain = [...detection.uncertain];
  const notes: string[] = [];
  const extraDoubts: string[] = [];

  // Test runner: config files refine an "unknown" runner.
  const rootFiles = files.filter((f) => !f.includes("/"));
  const testConfigs = rootFiles.filter((f) => TEST_CONFIG.test(f));
  const viteConfig = rootFiles.find((f) => VITE_CONFIG.test(f));
  const viteHasTest = viteConfig !== undefined && /\btest\s*:/.test(tree.read(viteConfig) ?? "");
  if (viteHasTest && viteConfig !== undefined) testConfigs.push(viteConfig);
  const refined = refineTestRunner(
    features.testRunner,
    testConfigs,
    pkg !== null && "jest" in pkg,
    viteHasTest,
  );
  if (refined.runner !== features.testRunner && refined.runner !== null) {
    features.testRunner = refined.runner;
    const generic = uncertain.findIndex((u) => u.startsWith("The test runner is neither"));
    if (generic !== -1) uncertain.splice(generic, 1);
  }
  if (refined.doubt !== null) extraDoubts.push(refined.doubt);

  // tsconfig.
  let tsconfig: DetectReport["tsconfig"] = null;
  if (has("tsconfig.json")) {
    const parsed = asRecord(parseJsonc(tree.read("tsconfig.json") ?? ""));
    if (parsed === null) {
      extraDoubts.push("tsconfig.json could not be parsed: typecheck settings are unknown.");
      tsconfig = { path: "tsconfig.json", extends: null, strict: null, references: 0 };
    } else {
      const options = asRecord(parsed.compilerOptions);
      const ext = parsed.extends;
      tsconfig = {
        path: "tsconfig.json",
        extends: typeof ext === "string" ? ext : Array.isArray(ext) ? ext.join(", ") : null,
        strict: typeof options?.strict === "boolean" ? options.strict : null,
        references: Array.isArray(parsed.references) ? parsed.references.length : 0,
      };
      if (tsconfig.references > 0) {
        extraDoubts.push(
          `tsconfig.json uses ${tsconfig.references} project reference(s): the typecheck step may need \`tsc -b\` instead of \`tsc --noEmit\`.`,
        );
      }
    }
  } else if (features.typescript) {
    extraDoubts.push(
      "TypeScript is a dependency but there is no root tsconfig.json: the typecheck command is a guess.",
    );
  }

  // Workers.
  const workerConfigs = files
    .filter((f) => WRANGLER.test(f) && !FIXTURE_DIR.test(f))
    .map((path) => ({ path, name: workerName(path, tree.read(path)) }));
  const workers = workerConfigs.map((w) => w.name).filter((n): n is string => n !== null);
  for (const w of workerConfigs.filter((c) => c.name === null)) {
    extraDoubts.push(`${w.path} has no readable \`name\`: that Worker's previews can't be named.`);
  }
  if (workerConfigs.length > 1) {
    notes.push(
      `${workerConfigs.length} Worker configs (${workerConfigs.map((w) => w.path).join(", ")}).`,
    );
  }

  // Monorepo workspaces.
  const workspaceYaml = has("pnpm-workspace.yaml") ? (tree.read("pnpm-workspace.yaml") ?? "") : "";
  const pkgWorkspaces = pkg?.workspaces;
  const yarnWorkspaces = asRecord(pkgWorkspaces)?.packages;
  const workspaces = [
    ...(Array.isArray(pkgWorkspaces) ? pkgWorkspaces : []),
    ...(Array.isArray(yarnWorkspaces) ? yarnWorkspaces : []),
    ...yamlList(workspaceYaml, "packages"),
  ].filter((w): w is string => typeof w === "string");
  if (workspaces.length > 0) {
    extraDoubts.push(
      `A monorepo (${workspaces.length} workspace glob(s)): the generated pipeline runs the root scripts only; per-package steps need a hand-written .platform/ci.ts.`,
    );
  }

  // Install scripts pnpm would refuse to run.
  const pm: PackageManager = features.packageManager;
  const pnpmSettings = asRecord(pkg?.pnpm);
  const approvedBuilds = [
    ...[...yamlMap(workspaceYaml, "allowBuilds")].filter(([, v]) => v === "true").map(([k]) => k),
    ...yamlList(workspaceYaml, "onlyBuiltDependencies"),
    ...(Array.isArray(pnpmSettings?.onlyBuiltDependencies)
      ? (pnpmSettings.onlyBuiltDependencies as unknown[])
      : []),
  ].filter((s): s is string => typeof s === "string");
  const denied = new Set([
    ...[...yamlMap(workspaceYaml, "allowBuilds")].filter(([, v]) => v === "false").map(([k]) => k),
    ...yamlList(workspaceYaml, "ignoredBuiltDependencies"),
    ...(Array.isArray(pnpmSettings?.ignoredBuiltDependencies)
      ? (pnpmSettings.ignoredBuiltDependencies as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : []),
  ]);
  const buildScriptsNeedingApproval: BuildScriptDependency[] = [];
  if (pm === "pnpm") {
    const lock = features.lockfile === null ? null : tree.read(features.lockfile);
    const known = new Set(KNOWN_BUILD_SCRIPT_PACKAGES);
    let candidates: Map<string, string[]>;
    // Platform-restricted packages (fsevents: os darwin) are never installed on the runners.
    const otherPlatforms = lock === null ? new Set<string>() : pnpmLockSkippedOnRunner(lock);
    const skippedOnRunner: string[] = [];
    if (lock !== null) {
      candidates = pnpmLockPackages(lock);
      if (candidates.size === 0) {
        extraDoubts.push(
          `${features.lockfile} lists no packages detection could read: install-script approvals are unknown.`,
        );
      }
    } else {
      const deps = { ...asRecord(pkg?.dependencies), ...asRecord(pkg?.devDependencies) };
      candidates = new Map(Object.keys(deps).map((name) => [name, []]));
    }
    for (const [name, versions] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
      if (!known.has(name) || denied.has(name) || approvedBuilds.includes(name)) continue;
      if (otherPlatforms.has(name)) {
        skippedOnRunner.push(name);
        continue;
      }
      buildScriptsNeedingApproval.push({ name, versions: versions.slice(0, 20), source: "known" });
    }
    if (skippedOnRunner.length > 0) {
      notes.push(
        `${skippedOnRunner.join(", ")} only ${skippedOnRunner.length === 1 ? "installs" : "install"} on other platforms (os/cpu/libc in ${features.lockfile}): pnpm skips them on the Linux runners, so their install scripts never run in CI and need no approval there.`,
      );
    }
    if (buildScriptsNeedingApproval.length > 0) {
      uncertain.push(
        `${BUILD_SCRIPTS_DOUBT} for: ${buildScriptsNeedingApproval.map((d) => d.name).join(", ")}. Each needs a decision in pnpm-workspace.yaml \`allowBuilds\`: true runs its install script, false skips it (the platform never approves build scripts on its own, and never for unclaimed repos).`,
      );
    }
    extraDoubts.push(
      "pnpm lockfiles don't record which packages have install scripts: the approval list comes from well-known packages and may be incomplete.",
    );
  } else if (pm === "npm" && features.lockfile !== null) {
    const scripted = npmInstallScriptPackages(tree.read(features.lockfile) ?? "");
    if (scripted.size > 0) {
      notes.push(
        `npm runs install scripts of ${scripted.size} package(s) (${[...scripted.keys()].slice(0, 10).join(", ")}${scripted.size > 10 ? ", ..." : ""}).`,
      );
    }
  }

  const pmSpec = typeof pkg?.packageManager === "string" ? pkg.packageManager : null;
  if (pmSpec !== null) notes.push(`package.json pins ${pmSpec}.`);

  const commands: Commands = commandsFor(features);
  uncertain.push(...extraDoubts);
  return DetectReport.parse({
    version: DETECT_REPORT_VERSION,
    sha: opts.sha ?? null,
    features,
    confidence: confidenceOf(detection.confidence, extraDoubts.length),
    uncertain: uncertain.map((u) => u.slice(0, 2000)).slice(0, 100),
    packageManager: pm,
    packageManagerSpec: pmSpec,
    lockfile: features.lockfile,
    testRunner: features.testRunner,
    testConfigs: testConfigs.slice(0, 20),
    installCommand: commands.install,
    testCommand: commands.test,
    buildCommand: commands.build,
    typecheckCommand: commands.typecheck,
    lintCommand: commands.lint,
    tsconfig,
    workers: workers.slice(0, 100),
    workerConfigs: workerConfigs.slice(0, 100),
    workspaces: workspaces.slice(0, 200),
    buildScriptsNeedingApproval: buildScriptsNeedingApproval.slice(0, 200),
    approvedBuilds: [...new Set(approvedBuilds)].slice(0, 500),
    notes: notes.slice(0, 50),
  });
}
