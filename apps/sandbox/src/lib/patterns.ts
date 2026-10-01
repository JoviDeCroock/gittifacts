/** Path classification shared by the evidence commands. Paths are repo-relative POSIX. */
import { matchGlob } from "@app/evidence";

/** vitest/jest default test file patterns. */
export const TEST_FILE_GLOBS = [
  "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/__tests__/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
];

const IGNORED = /(^|\/)(node_modules|\.git|dist|coverage|\.stryker-tmp)\//;

export function isTestFile(path: string): boolean {
  if (IGNORED.test(path)) return false;
  return TEST_FILE_GLOBS.some((g) => matchGlob(g, path));
}

/** Directories whose non-test files are test support (helpers, fixtures, mocks). */
const TEST_SUPPORT_DIR = /(^|\/)(test|tests|__tests__|__mocks__|__fixtures__|spec)\//;

/** Files overlaid from head onto base for red/green: tests and their support files. */
export function isTestSupportFile(path: string): boolean {
  if (IGNORED.test(path)) return false;
  return isTestFile(path) || TEST_SUPPORT_DIR.test(path);
}

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Production source whose changed lines coverage and mutation testing measure: code files that
 * are not tests, test support, declarations, tool configs or platform files.
 */
export function isMeasuredSource(path: string): boolean {
  if (!CODE_EXT.test(path)) return false;
  if (path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts")) return false;
  if (IGNORED.test(path)) return false;
  if (path.startsWith(".platform/") || path.startsWith(".github/")) return false;
  if (isTestSupportFile(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/\.config\.[cm]?[jt]s$/.test(base) || /^\..*rc\.[cm]?[jt]s$/.test(base)) return false;
  return true;
}

/** Restrict a `path → lines` map to measured source files. */
export function measuredChangedLines(
  changed: Readonly<Record<string, readonly number[]>>,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [path, lines] of Object.entries(changed)) {
    if (isMeasuredSource(path) && lines.length > 0) out[path] = [...lines];
  }
  return out;
}

/** Collapse sorted line numbers into inclusive [start, end] ranges. */
export function lineRanges(lines: readonly number[]): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const l of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && l === last[1] + 1) last[1] = l;
    else ranges.push([l, l]);
  }
  return ranges;
}
