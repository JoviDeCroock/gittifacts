/**
 * Deterministic platform ids for GitHub objects, so a webhook finds its repo and Change without a
 * lookup table. GitHub's numeric ids are stable across renames; names are not.
 */

/** The platform Repo row of a GitHub repository. */
export const repoIdFor = (githubRepoId: number): string => `gh-${githubRepoId}`;

/** The Artifacts mirror of a GitHub repository (the repo's `artifactsName`). */
export const mirrorNameFor = (githubRepoId: number): string => `ghm-${githubRepoId}`;

/** The Change that grades pull request `number` (one Change per PR, every head). */
export const changeIdFor = (githubRepoId: number, number: number): string =>
  `gh-${githubRepoId}-${number}`;

/** Branch in the mirror holding a pull request's current head. */
export const headBranchFor = (number: number): string => `gittifacts/pr/${number}`;

/** The principal a GitHub account authors Changes as (never signs in, never approves). */
export const principalIdFor = (githubUserId: number): string => `gh-u-${githubUserId}`;

export const isGithubMirrorName = (name: string): boolean => /^ghm-\d+$/.test(name);

/** `gh-<repoId>-<number>` → its parts, or null. */
export function parseChangeId(id: string): { githubRepoId: number; number: number } | null {
  const m = /^gh-(\d+)-(\d+)$/.exec(id);
  return m === null ? null : { githubRepoId: Number(m[1]), number: Number(m[2]) };
}
