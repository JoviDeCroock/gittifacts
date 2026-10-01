/**
 * git with the platform token, without leaking it: the `Authorization` header is passed through
 * git's environment-config (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`, git ≥ 2.31), so it is neither in
 * argv (visible in `ps`) nor written to `.git/config`. Credentials embedded in a remote URL are
 * moved into the header and stripped from the URL git records.
 */
import type { GitResult, GitRunner } from "./io.js";

export type GitAuth =
  | { scheme: "Bearer"; token: string }
  | { scheme: "Basic"; username: string; password: string };

export function authHeader(auth: GitAuth): string {
  if (auth.scheme === "Bearer") return `Authorization: Bearer ${auth.token}`;
  return `Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

export function gitAuthEnv(auth: GitAuth | null): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (!auth) return env;
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: authHeader(auth),
  };
}

/** Splits `https://user:secret@host/repo.git` into a clean URL and Basic credentials. */
export function splitRemote(remote: string): { url: string; auth: GitAuth | null } {
  let u: URL;
  try {
    u = new URL(remote);
  } catch {
    return { url: remote, auth: null };
  }
  if (!u.username && !u.password) return { url: remote, auth: null };
  const auth: GitAuth | null = u.password
    ? {
        scheme: "Basic",
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      }
    : { scheme: "Bearer", token: decodeURIComponent(u.username) };
  u.username = "";
  u.password = "";
  return { url: u.toString(), auth };
}

export function clone(
  git: GitRunner,
  opts: { url: string; dir: string; cwd: string; auth: GitAuth | null },
): Promise<GitResult> {
  return git(["clone", "--", opts.url, opts.dir], { cwd: opts.cwd, env: gitAuthEnv(opts.auth) });
}
