/**
 * The runner's own installed tools (TypeScript, Stryker, @vitest/coverage-v8), resolved next to
 * this module: `/opt/gittifacts-runner/node_modules` in the image, `apps/sandbox/node_modules`
 * in development. Repositories don't need to depend on any of them.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * `node_modules/<name>` as Node would find it from `fromDir`, walking up the directory tree but
 * ignoring NODE_PATH and global folders: "does this checkout have the package" must not be
 * answered by the environment the runner happens to be started from.
 */
export function findPackageDir(name: string, fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageDir(name: string, from?: string): string | null {
  if (from !== undefined) return findPackageDir(name, from);
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

export function versionOf(dir: string | null): string | null {
  return versionAt(dir);
}

function versionAt(dir: string | null): string | null {
  if (dir === null) return null;
  try {
    const json: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (
      json !== null &&
      typeof json === "object" &&
      "version" in json &&
      typeof json.version === "string"
    )
      return json.version;
  } catch {
    // ignore
  }
  return null;
}

export interface Tool {
  dir: string;
  version: string | null;
}

export function ownTool(name: string): Tool | null {
  const dir = packageDir(name);
  return dir === null ? null : { dir, version: versionAt(dir) };
}

/** The repository's own copy of a package, resolved from `repoDir`. */
export function repoTool(name: string, repoDir: string): Tool | null {
  const dir = packageDir(name, repoDir);
  return dir === null ? null : { dir, version: versionAt(dir) };
}

export function strykerBin(): string | null {
  const core = ownTool("@stryker-mutator/core");
  if (core === null) return null;
  const bin = join(core.dir, "bin", "stryker.js");
  return existsSync(bin) ? bin : null;
}

export function strykerVitestRunnerPlugin(): string | null {
  const runner = ownTool("@stryker-mutator/vitest-runner");
  if (runner === null) return null;
  const entry = join(runner.dir, "dist", "src", "index.js");
  return existsSync(entry) ? entry : null;
}

/** Entry module of our @vitest/coverage-v8 (a CoverageProviderModule as its default export). */
export function coverageV8Module(): (Tool & { entry: string }) | null {
  const tool = ownTool("@vitest/coverage-v8");
  if (tool === null) return null;
  const entry = join(tool.dir, "dist", "index.js");
  return existsSync(entry) ? { ...tool, entry } : null;
}

export function majorMinor(version: string | null): string | null {
  const m = version === null ? null : /^(\d+)\.(\d+)\./.exec(version);
  return m === null ? null : `${m[1]}.${m[2]}`;
}

function readNumber(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** CPUs actually available to this container (cgroup quota aware). */
export function availableCpus(): number {
  let cpus = availableParallelism();
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota !== undefined && quota !== "max" && period !== undefined) {
      const q = Number(quota) / Number(period);
      if (Number.isFinite(q) && q > 0) cpus = Math.min(cpus, Math.max(1, Math.ceil(q)));
    }
  } catch {
    const quota = readNumber("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
    const period = readNumber("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
    if (quota !== null && period !== null && quota > 0 && period > 0) {
      cpus = Math.min(cpus, Math.max(1, Math.ceil(quota / period)));
    }
  }
  return Math.max(1, cpus);
}

/** Memory available to this container in bytes (cgroup limit aware). */
export function availableMemory(): number {
  let mem = totalmem();
  try {
    const limit = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (limit !== "max") {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) mem = Math.min(mem, n);
    }
  } catch {
    const n = readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    if (n !== null && n > 0) mem = Math.min(mem, n);
  }
  return mem;
}

/**
 * Stryker worker processes: one per CPU (one spare above 4 CPUs for the main process), at most
 * one per ~768 MiB of memory (each runs its own vitest). `GITTIFACTS_MUTATION_CONCURRENCY` wins.
 */
export function mutationConcurrency(): number {
  const override = Number(process.env.GITTIFACTS_MUTATION_CONCURRENCY);
  if (Number.isInteger(override) && override > 0) return override;
  const cpus = availableCpus();
  const byCpu = cpus > 4 ? cpus - 1 : cpus;
  const byMem = Math.max(1, Math.floor(availableMemory() / (768 * 1024 * 1024)));
  return Math.max(1, Math.min(byCpu, byMem));
}
