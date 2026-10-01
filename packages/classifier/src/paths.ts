// The posix build: never consults process.platform/navigator, so matching is identical in Node,
// workerd and browsers.
import picomatch from "picomatch/posix";

export type PathMatcher = (path: string) => boolean;

const GLOB_OPTIONS = { dot: true } as const;

/** Everything under `.platform/` is platform policy/config (POLICY_PATH, CI_PATH, transforms). */
export const PLATFORM_GLOBS: readonly string[] = [".platform/**"];

/** Database migrations. Usually also a sensitive-path hit; reported separately. */
export const MIGRATION_GLOBS: readonly string[] = ["**/migrations/**", "**/migration/**"];

/** Package manifests that a `dependency-patch` change may touch. */
export const MANIFEST_GLOBS: readonly string[] = ["**/package.json"];

/** Lockfiles that a `dependency-patch` change may touch. */
export const LOCKFILE_GLOBS: readonly string[] = [
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
];

/**
 * Files that are never "source" for the purpose of accepting a skipped public-api or coverage
 * signal. Deliberately an allow-list: anything not listed (including unknown extensions, SVG and
 * config files) counts as source, so a skip is only accepted for docs/image/licence-only diffs.
 */
export const NON_SOURCE_GLOBS: readonly string[] = [
  "**/*.{md,mdx,markdown,txt,rst,adoc}",
  "**/*.{png,jpg,jpeg,gif,webp,avif,ico}",
  "**/{LICENSE,LICENCE,NOTICE,COPYING}",
];

/** Repo-relative path as git prints it: no leading "./" or "/". */
export function normalizePath(path: string): string {
  let p = path.trim();
  for (;;) {
    if (p.startsWith("./")) p = p.slice(2);
    else if (p.startsWith("/")) p = p.slice(1);
    else return p;
  }
}

/**
 * Compile globs (picomatch, `dot: true`) into one matcher.
 *
 * - A non-negated pattern `P` also matches `P/**`, so a directory written as `src/legacy` or
 *   `src/legacy/` covers the files under it (gitignore-like).
 * - A pattern that is empty or fails to compile cannot be evaluated. `onInvalid` decides what that
 *   means and must be the escalating choice for the caller: "match-all" for patterns that raise
 *   risk when they match (sensitive paths, outOfScope), "match-none" for patterns that lower risk
 *   when they match (scopePaths).
 */
export function compileGlobs(
  patterns: readonly string[],
  onInvalid: "match-all" | "match-none",
): PathMatcher {
  const matchers: PathMatcher[] = [];
  let invalid = false;
  for (const raw of patterns) {
    const pattern = normalizePath(raw);
    if (pattern === "") {
      invalid = true;
      continue;
    }
    try {
      matchers.push(picomatch(pattern, GLOB_OPTIONS));
      if (!pattern.startsWith("!")) {
        const dir = pattern.replace(/\/+$/, "");
        if (dir !== "" && !dir.endsWith("**")) matchers.push(picomatch(`${dir}/**`, GLOB_OPTIONS));
      }
    } catch {
      invalid = true;
    }
  }
  const matchAll = invalid && onInvalid === "match-all";
  return (path: string) => matchAll || matchers.some((m) => m(path));
}

/** Sorted, de-duplicated, capped list for messages: "a, b, c and 4 more". */
export function formatList(values: readonly string[], max = 8, empty = "(none)"): string {
  const unique = sortStrings([...new Set(values)]);
  if (unique.length === 0) return empty;
  const shown = unique.slice(0, max).join(", ");
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

/** Locale-independent string order (UTF-16 code units). Returns a new array. */
export function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
