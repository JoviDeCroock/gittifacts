/**
 * Repository facts the evidence commands need: package manager, manifests at a commit, whether
 * base and head resolve the same dependency graph, and preparing a base worktree that can run
 * the repository's tools (head's `node_modules` linked when the dependency graph is identical,
 * a fresh install otherwise).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { LOCKFILE_NAMES } from "@app/evidence";
import {
  detectPackageManager,
  installCommand,
  lockfileFor,
  type PackageManager,
} from "./ci-engine.js";
import { addWorktree, listTree, readBlob } from "./git.js";
import { errorMessage, log, tail } from "./log.js";
import { runShell } from "./proc.js";

export const PACKAGE_MANAGERS: readonly PackageManager[] = [
  "pnpm",
  "npm",
  "yarn",
  "yarn-berry",
  "bun",
];

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Package manager of the checkout at `dir` (explicit override wins). */
export function packageManagerOf(dir: string, override?: PackageManager): PackageManager | null {
  if (override !== undefined) return override;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  return detectPackageManager({
    rootEntries: entries,
    packageJson: readJson(join(dir, "package.json")),
  });
}

const IGNORED_DIRS = /(^|\/)(node_modules|\.git)\//;

/** Repo paths of every `package.json` at `rev` (outside node_modules), sorted. */
export async function manifestPaths(repo: string, rev: string): Promise<string[]> {
  const tree = await listTree(repo, rev);
  return tree
    .filter(
      (e) => e.type === "blob" && (e.path === "package.json" || e.path.endsWith("/package.json")),
    )
    .map((e) => e.path)
    .filter((p) => !IGNORED_DIRS.test(p))
    .sort();
}

/** `path → text` of every package.json at `rev`. */
export async function readManifests(repo: string, rev: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of await manifestPaths(repo, rev)) {
    const text = await readBlob(repo, rev, path);
    if (text !== null) out[path] = text;
  }
  return out;
}

/** Fields of a manifest that decide what an install puts in node_modules. */
const INSTALL_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "workspaces",
  "overrides",
  "resolutions",
  "pnpm",
  "packageManager",
] as const;

function installProjection(text: string): string {
  try {
    const json: unknown = JSON.parse(text);
    if (json === null || typeof json !== "object" || Array.isArray(json)) return `raw:${text}`;
    const record = json as Record<string, unknown>;
    return JSON.stringify(INSTALL_FIELDS.map((f) => [f, record[f] ?? null]));
  } catch {
    return `raw:${text}`;
  }
}

const INSTALL_CONFIG_FILES = [
  ...LOCKFILE_NAMES,
  "pnpm-workspace.yaml",
  ".npmrc",
  ".yarnrc.yml",
  "bunfig.toml",
];

/**
 * True when base and head would install the same dependency graph: identical lockfiles and
 * install config at the root (both absent counts as identical) and identical dependency
 * fields in every package.json.
 */
export async function sameDependencyGraph(
  repo: string,
  base: string,
  head: string,
): Promise<boolean> {
  const [baseTree, headTree] = await Promise.all([listTree(repo, base), listTree(repo, head)]);
  const pick = (tree: typeof baseTree) => {
    const m = new Map<string, string>();
    for (const e of tree) {
      if (INSTALL_CONFIG_FILES.includes(e.path)) m.set(e.path, e.object);
    }
    return m;
  };
  const b = pick(baseTree);
  const h = pick(headTree);
  if (b.size !== h.size) return false;
  for (const [path, id] of b) if (h.get(path) !== id) return false;
  const [bm, hm] = await Promise.all([readManifests(repo, base), readManifests(repo, head)]);
  const keys = new Set([...Object.keys(bm), ...Object.keys(hm)]);
  for (const key of keys) {
    const x = bm[key];
    const y = hm[key];
    if (x === undefined || y === undefined) return false;
    if (installProjection(x) !== installProjection(y)) return false;
  }
  return true;
}

/**
 * Link every `node_modules` directory of the head checkout (root and workspace packages) into
 * `target` at the same relative location. Returns the linked relative dirs.
 */
export function linkNodeModules(
  headDir: string,
  target: string,
  manifests: readonly string[],
): string[] {
  const dirs = new Set<string>([""]);
  for (const m of manifests)
    dirs.add(m === "package.json" ? "" : m.slice(0, -"/package.json".length));
  const linked: string[] = [];
  for (const dir of [...dirs].sort()) {
    const from = join(headDir, dir, "node_modules");
    const to = join(target, dir, "node_modules");
    if (!existsSync(from) || existsSync(to)) continue;
    if (!existsSync(join(target, dir))) continue;
    symlinkSync(realpathSync(from), to, "dir");
    linked.push(dir === "" ? "node_modules" : `${dir}/node_modules`);
  }
  return linked;
}

export interface PreparedWorktree {
  dir: string;
  /** How dependencies were provided. */
  deps: "linked" | "installed" | "none" | "install-failed";
  notes: string[];
}

export interface PrepareOptions {
  repo: string;
  /** The head checkout whose node_modules may be reused (usually `repo`). */
  headDir: string;
  base: string;
  head: string;
  path: string;
  packageManager: PackageManager | null;
  /** Whether the commands to run need installed dependencies. */
  needDeps: boolean;
  installTimeoutMs?: number;
}

/** A clean worktree of `base` at `path`, with dependencies when `needDeps`. */
export async function prepareBaseWorktree(opts: PrepareOptions): Promise<PreparedWorktree> {
  const dir = await addWorktree(opts.repo, opts.path, opts.base);
  const notes: string[] = [];
  if (!opts.needDeps) return { dir, deps: "none", notes };
  const manifests = await manifestPaths(opts.repo, opts.base);
  if (manifests.length === 0) return { dir, deps: "none", notes };
  if (await sameDependencyGraph(opts.repo, opts.base, opts.head)) {
    const linked = linkNodeModules(opts.headDir, dir, manifests);
    log(`base worktree: dependency graph unchanged, linked ${linked.join(", ") || "nothing"}`);
    return { dir, deps: linked.length > 0 ? "linked" : "none", notes };
  }
  const pm = opts.packageManager ?? packageManagerOf(dir);
  if (pm === null) return { dir, deps: "none", notes: ["no package manager detected at base"] };
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const command = installCommand(pm, lockfileFor(pm, entries) !== null);
  log(`base worktree: dependencies differ from head, running ${command}`);
  try {
    const r = await runShell(command, {
      cwd: dir,
      timeoutMs: opts.installTimeoutMs ?? 15 * 60_000,
    });
    if (r.code !== 0) {
      notes.push(
        `installing base dependencies failed (${command}, exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${tail(r.stdout + r.stderr, 8)}`,
      );
      return { dir, deps: "install-failed", notes };
    }
  } catch (error) {
    notes.push(`installing base dependencies failed (${command}): ${errorMessage(error)}`);
    return { dir, deps: "install-failed", notes };
  }
  return { dir, deps: "installed", notes };
}
