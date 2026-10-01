/**
 * Default pipelines for JS/TS repositories without `.platform/ci.ts`, and the repository feature
 * detection the platform uses to pick evidence steps. Pure: callers pass the root file names and
 * the parsed root `package.json` (read via the Artifacts binding, never executed).
 */
import { z } from "zod";
import { PIPELINE_SPEC_VERSION, type PipelineSpec, type StepSpec } from "./spec.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "yarn-berry" | "bun";

/** The subset of `package.json` the defaults look at. Unknown fields are ignored. */
export const PackageJsonLike = z
  .object({
    scripts: z.record(z.string(), z.unknown()).optional(),
    packageManager: z.string().optional(),
    workspaces: z.unknown().optional(),
    main: z.unknown().optional(),
    module: z.unknown().optional(),
    types: z.unknown().optional(),
    typings: z.unknown().optional(),
    exports: z.unknown().optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
    devDependencies: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type PackageJsonLike = z.infer<typeof PackageJsonLike>;

export interface RepoFacts {
  /** Names of entries at the repository root (files and directories). */
  rootEntries: readonly string[];
  /** Parsed root `package.json`, or null when absent or unparseable. */
  packageJson: unknown;
  /** Names of entries under `.platform/` (empty when the directory is absent). */
  platformEntries?: readonly string[];
}

const LOCKFILES: readonly [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function parsePackageJson(input: unknown): PackageJsonLike | null {
  const parsed = PackageJsonLike.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function fromPackageManagerField(field: string | undefined): PackageManager | null {
  if (field === undefined) return null;
  const match = /^(pnpm|npm|yarn|bun)@(\d+)/.exec(field.trim());
  if (match === null) return null;
  const [, name, major] = match;
  if (name === "yarn") return Number(major) >= 2 ? "yarn-berry" : "yarn";
  return name as PackageManager;
}

/** The lockfile the package manager uses, if one is present at the root. */
export function lockfileFor(pm: PackageManager, rootEntries: readonly string[]): string | null {
  for (const [file, owner] of LOCKFILES) {
    if (rootEntries.includes(file) && (owner === pm || (owner === "yarn" && pm === "yarn-berry")))
      return file;
  }
  return null;
}

/**
 * `packageManager` in package.json wins; otherwise the lockfile decides; a `package.json` with no
 * lockfile is npm. Returns null when there is no package.json at the root.
 */
export function detectPackageManager(facts: RepoFacts): PackageManager | null {
  if (!facts.rootEntries.includes("package.json")) return null;
  const pkg = parsePackageJson(facts.packageJson);
  const declared = fromPackageManagerField(pkg?.packageManager);
  if (declared !== null) return declared;
  for (const [file, pm] of LOCKFILES) {
    if (facts.rootEntries.includes(file)) {
      if (pm === "yarn" && facts.rootEntries.includes(".yarnrc.yml")) return "yarn-berry";
      return pm;
    }
  }
  return "npm";
}

export function installCommand(pm: PackageManager, hasLockfile: boolean): string {
  switch (pm) {
    case "pnpm":
      return hasLockfile ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "npm":
      return hasLockfile ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
    case "yarn":
      return hasLockfile
        ? "yarn install --frozen-lockfile --non-interactive"
        : "yarn install --non-interactive";
    case "yarn-berry":
      return hasLockfile ? "yarn install --immutable" : "yarn install";
    case "bun":
      return hasLockfile ? "bun install --frozen-lockfile" : "bun install";
  }
}

export function runScriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm run ${script}`;
    case "npm":
      return `npm run ${script}`;
    case "yarn":
    case "yarn-berry":
      return `yarn run ${script}`;
    case "bun":
      return `bun run ${script}`;
  }
}

/** npm's placeholder test script counts as "no tests". */
const PLACEHOLDER_TEST = /no test specified/i;

/** The first script name present (with a non-empty string body) among `names`. */
export function findScript(pkg: PackageJsonLike | null, names: readonly string[]): string | null {
  const scripts = pkg?.scripts ?? {};
  for (const name of names) {
    const body = scripts[name];
    if (typeof body !== "string" || body.trim() === "") continue;
    if (name === "test" && PLACEHOLDER_TEST.test(body)) continue;
    return name;
  }
  return null;
}

export interface RepoFeatures {
  packageManager: PackageManager | null;
  lockfile: string | null;
  hasPackageJson: boolean;
  scripts: {
    lint: string | null;
    typecheck: string | null;
    test: string | null;
    build: string | null;
  };
  hasTypeScript: boolean;
  /** `package.json` declares an entry point (`exports`/`main`/`types`/...) or workspaces. */
  hasPublicApi: boolean;
  /** `.platform/transforms/` exists. */
  hasTransforms: boolean;
  /** `.platform/ci.ts` exists. */
  hasPipelineFile: boolean;
}

export function detectRepoFeatures(facts: RepoFacts): RepoFeatures {
  const pkg = facts.rootEntries.includes("package.json")
    ? parsePackageJson(facts.packageJson)
    : null;
  const pm = detectPackageManager(facts);
  const platform = facts.platformEntries ?? [];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return {
    packageManager: pm,
    lockfile: pm === null ? null : lockfileFor(pm, facts.rootEntries),
    hasPackageJson: pkg !== null,
    scripts: {
      lint: findScript(pkg, ["lint"]),
      typecheck: findScript(pkg, ["typecheck", "type-check", "check-types", "tsc"]),
      test: findScript(pkg, ["test"]),
      build: findScript(pkg, ["build"]),
    },
    hasTypeScript: facts.rootEntries.includes("tsconfig.json") || "typescript" in deps,
    hasPublicApi:
      pkg !== null &&
      [pkg.exports, pkg.main, pkg.module, pkg.types, pkg.typings, pkg.workspaces].some(
        (v) => v !== undefined,
      ),
    hasTransforms: platform.includes("transforms"),
    hasPipelineFile: platform.includes("ci.ts"),
  };
}

/** Root files that change what an install produces; part of the default install cache inputs. */
export const INSTALL_CONFIG_FILES: readonly string[] = [
  "pnpm-workspace.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
];

/** Name of the install step in default pipelines. Evidence steps start from its snapshot. */
export const DEFAULT_INSTALL_STEP = "install";

/**
 * install → { lint, typecheck, test, build } in parallel, each starting from the install snapshot.
 * Only scripts that exist get a step. Repos without a root package.json get an empty pipeline.
 */
export function defaultPipeline(facts: RepoFacts): PipelineSpec {
  const features = detectRepoFeatures(facts);
  const pm = features.packageManager;
  if (pm === null) {
    return {
      version: PIPELINE_SPEC_VERSION,
      source: "default",
      steps: [],
      warnings: ["no package.json at the repository root; the default pipeline is empty"],
    };
  }
  const warnings: string[] = [];
  const inputs = ["**/package.json"];
  if (features.lockfile !== null) inputs.push(features.lockfile);
  else warnings.push(`no lockfile for ${pm}; install is not reproducible and is not cached`);
  for (const extra of INSTALL_CONFIG_FILES) {
    if (facts.rootEntries.includes(extra)) inputs.push(extra);
  }
  // Files package managers read during install that live in directories (patches, Yarn
  // releases/plugins). Globs that match nothing cost nothing.
  inputs.push("patches/**", ".yarn/releases/**", ".yarn/plugins/**");
  const install: StepSpec = {
    name: DEFAULT_INSTALL_STEP,
    command: installCommand(pm, features.lockfile !== null),
    parent: null,
    after: [],
    ...(features.lockfile === null ? {} : { cache: { inputs }, cacheScope: "global" as const }),
  };
  const steps: StepSpec[] = [install];
  const scriptSteps: [string, string | null][] = [
    ["lint", features.scripts.lint],
    ["typecheck", features.scripts.typecheck],
    ["test", features.scripts.test],
    ["build", features.scripts.build],
  ];
  for (const [name, script] of scriptSteps) {
    if (script === null) continue;
    steps.push({
      name,
      command: runScriptCommand(pm, script),
      parent: DEFAULT_INSTALL_STEP,
      after: [],
    });
  }
  if (features.scripts.test === null) warnings.push("no test script in package.json");
  return { version: PIPELINE_SPEC_VERSION, source: "default", steps, warnings };
}
