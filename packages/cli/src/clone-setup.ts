/**
 * A local clone wired to its Change, so plain `git push` works (DECISIONS 2026-10-11):
 *
 * - `remote.origin.url` is the current Change's fork (repointed by start-change and ship);
 * - `remote.origin.push` is `HEAD:refs/heads/<branch>`, so `git push` targets the fork's branch
 *   whatever the local branch is called, and the local branch tracks it;
 * - `credential.<origin>.helper` runs `gittifacts git-credential`, which asks refresh_push_token
 *   for a fresh token on every push. Tokens never land in `.git/config` or argv;
 * - `.gittifacts.json` (which Change, no secrets) is ignored through `.git/info/exclude`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { shellQuote } from "./calls.js";
import { PROJECT_FILE, type ProjectConfig, writeProject } from "./config.js";
import { splitRemote } from "./git.js";
import type { CliIo, SelfCommand } from "./io.js";
import { TARBALL_PATH } from "./self-update.js";
import { isRecord } from "./tools/schema.js";

/** Artifacts refuses chunked request bodies; git chunks anything over http.postBuffer. */
export const POST_BUFFER = "524288000";

export interface PushRemote {
  url: string;
  username: string;
  token: string;
  expiresAt: string;
  branch: string;
}

/** Validates a `remote` from start_change / refresh_push_token / create_project (external input). */
export function parsePushRemote(v: unknown): PushRemote | null {
  if (!isRecord(v)) return null;
  const { url, username, token, expiresAt, branch } = v;
  if (typeof url !== "string" || typeof token !== "string" || token === "") return null;
  return {
    url: splitRemote(url).url,
    username: typeof username === "string" && username !== "" ? username : "x",
    token,
    expiresAt: typeof expiresAt === "string" ? expiresAt : "",
    branch: typeof branch === "string" && branch !== "" ? branch : "main",
  };
}

/** Runs git in `cwd`; trimmed stdout, or null when git failed. */
export async function gitOut(
  io: CliIo,
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  const r = await io.git(args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" } });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function workTreeRoot(io: CliIo, cwd: string): Promise<string | null> {
  return gitOut(io, cwd, ["rev-parse", "--show-toplevel"]);
}

/** `https://h:1/x.git` → `https://h:1`; null when not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Artifacts Basic auth wants the token without its `?expires=<unix>` suffix. */
export function basicPassword(token: string): string {
  const i = token.indexOf("?expires=");
  return i < 0 ? token : token.slice(0, i);
}

/**
 * The helper git runs (`!…` is a shell snippet; git appends get/store/erase). It prefers this
 * bundle by absolute path and falls back to the host's tarball when that file is gone (an npx
 * cache cleaned up), so the clone keeps working after the npx run that set it up.
 */
export function helperCommand(self: SelfCommand, host: string): string {
  const npx = `npx -y ${shellQuote(`${host}${TARBALL_PATH}`)} git-credential`;
  if (self.script === null) return `!${npx}`;
  const script = shellQuote(self.script);
  return [
    `!f() { if [ -f ${script} ]; then N=${shellQuote(self.node)}; [ -x "$N" ] || N=node;`,
    `"$N" ${script} git-credential "$@"; else ${npx} "$@"; fi; }; f`,
  ].join(" ");
}

function excludeProjectFile(gitDir: string): void {
  const file = join(gitDir, "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === `/${PROJECT_FILE}` || l.trim() === PROJECT_FILE))
    return;
  mkdirSync(join(gitDir, "info"), { recursive: true });
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(
    file,
    `${sep}# gittifacts: which Change this clone pushes to (no secrets)\n/${PROJECT_FILE}\n`,
  );
}

export interface CloneWiring {
  /** The work tree root. */
  dir: string;
  host: string;
  /** Where `git push` goes: the Change's fork (no credentials in it). */
  pushUrl: string;
  branch: string;
  /** More origins the helper is installed for (the platform host, for its read-only /git/ proxy). */
  readOrigins?: string[];
}

export interface WiringResult {
  remote: "origin";
  url: string;
  branch: string;
  credentialHelper: string[];
}

function runner(io: CliIo, dir: string) {
  return async (...args: string[]) => {
    const r = await io.git(args, { cwd: dir, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
}

/**
 * Installs `gittifacts git-credential` for each origin (local config), sets http.postBuffer and
 * ignores `.gittifacts.json`. Returns the origins. Throws on a git failure.
 */
export async function installHelper(
  io: CliIo,
  dir: string,
  host: string,
  candidates: readonly (string | null)[],
): Promise<string[]> {
  const git = runner(io, dir);
  await git("config", "--local", "http.postBuffer", POST_BUFFER);
  const helper = helperCommand(io.self, host);
  const origins = candidates.filter((o, i, all): o is string => o !== null && all.indexOf(o) === i);
  for (const origin of origins) {
    const key = `credential.${origin}.helper`;
    await gitOut(io, dir, ["config", "--local", "--unset-all", key]);
    // An empty helper first resets the list, so a global keychain helper can't answer (or
    // store) a token that expires within the hour.
    await git("config", "--local", "--add", key, "");
    await git("config", "--local", "--add", key, helper);
  }
  const gitDir = await git("rev-parse", "--absolute-git-dir");
  if (isAbsolute(gitDir)) excludeProjectFile(gitDir);
  return origins;
}

/** Points `origin` at the fork and installs the credential helper. Throws on a git failure. */
export async function wireClone(io: CliIo, w: CloneWiring): Promise<WiringResult> {
  const git = runner(io, w.dir);
  const hasOrigin = (await gitOut(io, w.dir, ["remote", "get-url", "origin"])) !== null;
  await git("remote", hasOrigin ? "set-url" : "add", "origin", w.pushUrl);
  await git("config", "--local", "remote.origin.push", `HEAD:refs/heads/${w.branch}`);
  const local = await gitOut(io, w.dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (local) {
    await git("config", "--local", `branch.${local}.remote`, "origin");
    await git("config", "--local", `branch.${local}.merge`, `refs/heads/${w.branch}`);
  }
  const origins = await installHelper(io, w.dir, w.host, [
    originOf(w.pushUrl),
    ...(w.readOrigins ?? []),
  ]);
  return { remote: "origin", url: w.pushUrl, branch: w.branch, credentialHelper: origins };
}

/** Records the Change in `.gittifacts.json` and wires the clone to its fork. */
export async function adoptChange(
  io: CliIo,
  opts: {
    /** The git work tree. */
    dir: string;
    /** Where `.gittifacts.json` lives (usually the same directory). */
    projectDir: string;
    config: ProjectConfig;
    changeId: string;
    remote: { url: string; branch: string };
  },
): Promise<WiringResult> {
  const config: ProjectConfig = {
    ...opts.config,
    remote: opts.remote.url,
    changeId: opts.changeId,
    branch: opts.remote.branch,
  };
  writeProject(opts.projectDir, config);
  return wireClone(io, {
    dir: opts.dir,
    host: config.host,
    pushUrl: opts.remote.url,
    branch: opts.remote.branch,
    // A clone of the platform's /git/ proxy keeps fetching through it with the login token.
    ...(config.cloneUrl ? { readOrigins: [originOf(config.host) ?? config.host] } : {}),
  });
}
