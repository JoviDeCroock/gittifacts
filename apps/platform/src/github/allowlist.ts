/**
 * Operator guard (DECISIONS 2026-10-03, "GitHub repo allowlist"): `GITHUB_REPO_ALLOWLIST` is a
 * comma-separated list of `owner/repo` names. When it is set, GitHub mode grades, mirrors,
 * backtests, redelivers and writes for those repositories only, whatever the installation covers
 * (an installation on "All repositories" of a real organization must not mirror or comment on
 * every repo). Installation bookkeeping (which repos an installation lists) is still recorded.
 * Unset or empty: every repository of an installation is in scope.
 */

type Env = Record<string, unknown>;

/** The allowed names, lowercased; null when no allowlist is configured. */
export function repoAllowlist(env: Env): Set<string> | null {
  const raw = env.GITHUB_REPO_ALLOWLIST;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return new Set(
    raw
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n !== ""),
  );
}

/** Is `owner/repo` in scope? Unknown names are out of scope whenever an allowlist is set. */
export function repoAllowed(env: Env, fullName: string | null | undefined): boolean {
  const list = repoAllowlist(env);
  if (list === null) return true;
  return typeof fullName === "string" && list.has(fullName.toLowerCase());
}
