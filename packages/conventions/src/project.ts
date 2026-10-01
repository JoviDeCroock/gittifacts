/**
 * What the conventions need to know about a project to write its `.platform/ci.ts`, its AGENTS.md
 * command table and its Plan for an import: package manager, scripts, test runner, TypeScript.
 *
 * `detectProject` is pure: callers pass the root file names and the parsed root package.json (read
 * through the Artifacts binding, never executed). Whatever it can't tell for sure goes into
 * `uncertain`, which an import Plan must show the human instead of guessing quietly.
 */
import { z } from "zod";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type TestRunner = "vitest" | "jest" | "node" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface ProjectFeatures {
  /** false: no root package.json, so the generated pipeline has no steps. */
  hasPackageJson: boolean;
  packageManager: PackageManager;
  /** Lockfile at the root, or null (install is then not reproducible). */
  lockfile: string | null;
  /** package.json script names to run for each step, or null when there is none. */
  scripts: {
    lint: string | null;
    typecheck: string | null;
    test: string | null;
    build: string | null;
  };
  typescript: boolean;
  /** null: no test script at all. */
  testRunner: TestRunner | null;
  /** A wrangler config at the root (the project is a Worker). */
  worker: boolean;
  /**
   * Repository globs whose content fully determines the lint/typecheck/test/build results, so a
   * step may be skipped when none of them changed. null: unknown, so those steps always run.
   */
  cacheInputs: string[] | null;
}

export interface Detection {
  features: ProjectFeatures;
  confidence: Confidence;
  /** Plain sentences, one per thing detection had to guess. Empty when sure. */
  uncertain: string[];
}

export interface Commands {
  install: string;
  lint: string | null;
  typecheck: string | null;
  test: string | null;
  build: string | null;
  /** Runs a single test file: append the path. */
  testFile: string | null;
  /** Local preview, if the project has one. */
  dev: string | null;
}

const LOCKFILES: readonly [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

const PackageJson = z
  .object({
    packageManager: z.string().optional(),
    scripts: z.record(z.string(), z.unknown()).optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
    devDependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type PackageJson = z.infer<typeof PackageJson>;

/** npm's placeholder test script means "no tests". */
const PLACEHOLDER_TEST = /no test specified/i;

function script(pkg: PackageJson | null, names: readonly string[]): string | null {
  const scripts = pkg?.scripts ?? {};
  for (const name of names) {
    const body = scripts[name];
    if (typeof body !== "string" || body.trim() === "") continue;
    if (name === "test" && PLACEHOLDER_TEST.test(body)) continue;
    return name;
  }
  return null;
}

function testRunnerOf(pkg: PackageJson | null, testScript: string | null): TestRunner | null {
  if (testScript === null) return null;
  const body = String(pkg?.scripts?.[testScript] ?? "");
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (/\bvitest\b/.test(body) || "vitest" in deps) return "vitest";
  if (/\bjest\b/.test(body) || "jest" in deps) return "jest";
  if (/\bnode\b.*--test\b/.test(body)) return "node";
  return "unknown";
}

/** Install command for a package manager. Without a lockfile the install can't be frozen. */
export function installCommand(pm: PackageManager, lockfile: string | null): string {
  const frozen = lockfile !== null;
  switch (pm) {
    case "pnpm":
      return frozen ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "npm":
      return frozen ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
    case "yarn":
      return frozen ? "yarn install --frozen-lockfile" : "yarn install";
    case "bun":
      return frozen ? "bun install --frozen-lockfile" : "bun install";
  }
}

export function runScript(pm: PackageManager, name: string): string {
  return `${pm === "npm" ? "npm run" : `${pm} run`} ${name}`;
}

function execBin(pm: PackageManager, bin: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm exec ${bin}`;
    case "npm":
      return `npx ${bin}`;
    case "yarn":
      return `yarn ${bin}`;
    case "bun":
      return `bunx ${bin}`;
  }
}

/** The commands an agent runs locally (and CI runs) for a project. */
export function commandsFor(features: ProjectFeatures): Commands {
  const pm = features.packageManager;
  const s = features.scripts;
  const run = (name: string | null) => (name === null ? null : runScript(pm, name));
  const testFile =
    features.testRunner === "vitest"
      ? execBin(pm, "vitest run")
      : features.testRunner === "jest"
        ? execBin(pm, "jest")
        : features.testRunner === "node"
          ? "node --test"
          : null;
  return {
    install: installCommand(pm, features.lockfile),
    lint: run(s.lint),
    typecheck: run(s.typecheck) ?? (features.typescript ? execBin(pm, "tsc --noEmit") : null),
    test: run(s.test),
    build: run(s.build),
    testFile,
    dev: features.worker ? "wrangler dev" : null,
  };
}

export interface RepoFacts {
  /** Names of entries at the repository root. */
  rootEntries: readonly string[];
  /** Parsed root package.json, or null when absent or unparseable. */
  packageJson: unknown;
}

/** Best-effort detection for an imported repository. Never throws. */
export function detectProject(facts: RepoFacts): Detection {
  const uncertain: string[] = [];
  const has = (name: string) => facts.rootEntries.includes(name);
  const parsed = PackageJson.safeParse(facts.packageJson);
  const pkg = has("package.json") && parsed.success ? parsed.data : null;
  if (!has("package.json")) {
    uncertain.push("No package.json at the root: the generated pipeline has no steps. Write .platform/ci.ts by hand.");
  } else if (pkg === null) {
    uncertain.push("package.json could not be parsed, so no scripts were detected.");
  }

  const declared = /^(pnpm|npm|yarn|bun)@/.exec(pkg?.packageManager ?? "")?.[1] as PackageManager | undefined;
  const locks = LOCKFILES.filter(([file]) => has(file));
  const packageManager: PackageManager = declared ?? locks[0]?.[1] ?? "npm";
  if (declared === undefined && locks.length === 0 && pkg !== null) {
    uncertain.push("No lockfile and no packageManager field: assuming npm, and installs are not reproducible.");
  }
  if (declared === undefined && new Set(locks.map(([, pm]) => pm)).size > 1) {
    uncertain.push(`Several lockfiles (${locks.map(([f]) => f).join(", ")}): picked ${packageManager}.`);
  }
  if (declared !== undefined && locks.length > 0 && !locks.some(([, pm]) => pm === declared)) {
    uncertain.push(`packageManager says ${declared} but the lockfile is ${locks[0]?.[0]}: using ${declared} without a frozen install.`);
  }
  const lockfile = locks.find(([, pm]) => pm === packageManager)?.[0] ?? null;

  const scripts = {
    lint: script(pkg, ["lint"]),
    typecheck: script(pkg, ["typecheck", "type-check", "check-types", "tsc"]),
    test: script(pkg, ["test"]),
    build: script(pkg, ["build"]),
  };
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const typescript = has("tsconfig.json") || "typescript" in deps;
  const testRunner = testRunnerOf(pkg, scripts.test);
  const worker = WRANGLER_CONFIGS.some(has);

  if (pkg !== null && scripts.test === null) {
    uncertain.push("No test script: CI runs no tests, every Change lacks test evidence and is at least Lane 2 until one exists.");
  } else if (testRunner === "unknown") {
    uncertain.push("The test runner is neither vitest nor jest: red/green proof and coverage may be unavailable (raises lanes).");
  }
  if (typescript && scripts.typecheck === null) {
    uncertain.push("No typecheck script: CI runs `tsc --noEmit` with the root tsconfig.json.");
  }
  if (worker && scripts.build === null) {
    uncertain.push("A Worker without a build script: previews rely on wrangler bundling `main` directly.");
  }
  if (pkg !== null) {
    uncertain.push("Step caching is off (which files affect each step is unknown); every push runs every step.");
  }

  const features: ProjectFeatures = {
    hasPackageJson: pkg !== null,
    packageManager,
    lockfile,
    scripts,
    typescript,
    testRunner,
    worker,
    cacheInputs: null,
  };
  // Step caching being off is a speed note, not a correctness doubt.
  const doubts = uncertain.filter((u) => !u.startsWith("Step caching"));
  const confidence: Confidence = pkg === null ? "low" : doubts.length === 0 ? "high" : doubts.length <= 2 ? "medium" : "low";
  return { features, confidence, uncertain };
}
