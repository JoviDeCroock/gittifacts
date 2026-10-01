/**
 * Git plumbing for the runner. Every call runs `git -C <repo>` with credentials scrubbed from
 * the environment; the only call that ever sees the token is {@link fetchCommit}, and it passes
 * it to git through `GIT_CONFIG_*` env (never argv, never logged).
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";
import { type RunResult, run } from "./proc.js";

export class GitError extends Error {
  override readonly name = "GitError";
  constructor(
    message: string,
    readonly result: RunResult | null,
  ) {
    super(message);
  }
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isSha(value: string): boolean {
  return SHA_RE.test(value);
}

/** Config that keeps output machine-readable regardless of the user's/global git config. */
const BASE_CONFIG = [
  "-c",
  "safe.directory=*",
  "-c",
  "core.quotePath=true",
  "-c",
  "color.ui=never",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgSign=false",
];

export interface GitOptions {
  input?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Return non-zero results instead of throwing. */
  allowFail?: boolean;
}

export async function git(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<RunResult> {
  const result = await run("git", [...BASE_CONFIG, "-C", repo, ...args], {
    cwd: repo,
    echo: false,
    env: { GIT_PAGER: "cat", LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", ...opts.env },
    ...(opts.input === undefined ? {} : { input: opts.input }),
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });
  if (result.code !== 0 && !opts.allowFail) {
    throw new GitError(`git ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr.trim().slice(0, 2000)}`, result);
  }
  return result;
}

export async function gitText(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  return (await git(repo, args, opts)).stdout;
}

/** Full commit id for `rev`, or null when it does not name a commit available locally. */
export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  if (rev === "" || rev.startsWith("-") || /[\s\0]/.test(rev)) return null;
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true });
  const sha = r.stdout.trim();
  return r.code === 0 && isSha(sha) ? sha : null;
}

/**
 * Makes sure `sha` is present (with blobs). If it is missing, fetch it from `$GITTIFACTS_REMOTE`
 * using `$GITTIFACTS_TOKEN`. Returns the full sha.
 */
export async function ensureCommit(repo: string, sha: string): Promise<string> {
  const found = await resolveCommit(repo, sha);
  if (found !== null) return found;
  if (!isSha(sha)) throw new GitError(`${JSON.stringify(sha)} is not a known commit`, null);
  const remote = process.env.GITTIFACTS_REMOTE;
  if (remote === undefined || remote === "") {
    throw new GitError(`commit ${sha} is not available and $GITTIFACTS_REMOTE is not set`, null);
  }
  await fetchCommit(repo, remote, sha);
  const after = await resolveCommit(repo, sha);
  if (after === null) throw new GitError(`commit ${sha} is still missing after fetching it`, null);
  return after;
}

export async function fetchCommit(repo: string, remote: string, sha: string): Promise<void> {
  log(`fetching ${sha.slice(0, 12)} from the change's repository`);
  const token = process.env.GITTIFACTS_TOKEN;
  const env: Record<string, string> =
    token === undefined || token === ""
      ? {}
      : {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
        };
  // `--no-filter`: later commands run without credentials, so blobs must not be lazy.
  const r = await git(repo, ["fetch", "-q", "--no-tags", "--no-filter", "--depth=1", remote, sha], {
    env: { ...env, GIT_NO_LAZY_FETCH: undefined },
    allowFail: true,
    timeoutMs: 5 * 60_000,
  });
  if (r.code !== 0) {
    // stderr may echo the remote URL; never the token (it only lives in env).
    throw new GitError(`could not fetch ${sha}: ${r.stderr.trim().slice(0, 500)}`, r);
  }
}

/** Raw blob content of `path` at `rev`, or null when the path does not exist there. */
export async function readBlob(repo: string, rev: string, path: string): Promise<string | null> {
  const r = await git(repo, ["cat-file", "blob", `${rev}:${path}`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

/** Blob id of `path` at `rev`, or null when it is absent. */
export async function blobId(repo: string, rev: string, path: string): Promise<string | null> {
  const r = await git(repo, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { allowFail: true });
  const id = r.stdout.trim();
  return r.code === 0 && isSha(id) ? id : null;
}

export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

/** Every entry of the tree at `rev`, recursively (`git ls-tree -r -z`). */
export async function listTree(repo: string, rev: string, paths: readonly string[] = []): Promise<TreeEntry[]> {
  const out = await gitText(repo, ["ls-tree", "-r", "-z", "--full-tree", rev, "--", ...paths]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode = "", type = "", object = ""] = record.slice(0, tab).split(" ");
    entries.push({ mode, type, object, path: record.slice(tab + 1) });
  }
  return entries;
}

/** `git diff` text in the format `parseUnifiedDiff` expects. */
export async function unifiedDiff(repo: string, base: string, head: string, context = 0): Promise<string> {
  return gitText(repo, [
    "diff",
    `--unified=${context}`,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    base,
    head,
    "--",
  ]);
}

export interface NameStatus {
  status: string;
  path: string;
  oldPath: string | null;
}

/** `git diff --name-status -z -M base head`. */
export async function nameStatus(repo: string, base: string, head: string): Promise<NameStatus[]> {
  const out = await gitText(repo, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", base, head, "--"]);
  const parts = out.split("\0");
  const result: NameStatus[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++] ?? "";
    if (status === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[i++] ?? "";
      const to = parts[i++] ?? "";
      result.push({ status: status[0] ?? status, path: to, oldPath: from });
    } else {
      result.push({ status: status[0] ?? status, path: parts[i++] ?? "", oldPath: null });
    }
  }
  return result;
}

/** A detached worktree of `sha` at `path` (replacing whatever is there). */
export async function addWorktree(repo: string, path: string, sha: string): Promise<string> {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", "-q", "--detach", "--force", path, sha]);
  return path;
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", "--force", path], { allowFail: true });
  rmSync(path, { recursive: true, force: true });
  await git(repo, ["worktree", "prune"], { allowFail: true });
}

/** Absolute path of the top of the work tree containing `dir`. */
export async function topLevel(dir: string): Promise<string> {
  return (await gitText(dir, ["rev-parse", "--show-toplevel"])).trim();
}
