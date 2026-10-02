/**
 * Every docs quality gate over the content tree. `src/check.ts` is the CLI; the vitest suite
 * asserts the same list is empty.
 */
import { staleGenerated } from "../../generate/index.js";
import { CONTENT_DIR, loadPages, type Page } from "../content.js";
import { extract } from "./extract.js";
import { anchorsBySlug, checkLinks } from "./links.js";
import type { Problem } from "./problem.js";
import { checkSamples } from "./samples.js";
import { checkStyle } from "./style.js";

/**
 * Problems the checks find in text that other packages own and that docs only quote. Each one is
 * reported as a warning until its source is fixed; matching is exact on file + message.
 */
export const KNOWN_ISSUES: readonly { file: string; message: string; why: string }[] = [
  {
    file: "reference/errors.md",
    message: "capabilities(…) is not an MCP tool",
    why: "packages/conventions fixFor('insufficient-scope') suggests capabilities({}); the MCP tool is whoami (capabilities is GET /api/v1/capabilities).",
  },
];

export interface CheckResult {
  problems: Problem[];
  known: Problem[];
  pages: number;
}

export function checkPages(pages: readonly Page[]): Problem[] {
  const anchors = anchorsBySlug(pages);
  return pages.flatMap((page) => {
    const x = extract(page);
    return [...checkLinks(page, x, anchors), ...checkSamples(page, x), ...checkStyle(page, x)];
  });
}

export async function runChecks(contentDir: string = CONTENT_DIR): Promise<CheckResult> {
  const pages = loadPages(contentDir);
  const all = checkPages(pages);
  const { stale, orphaned } = await staleGenerated(contentDir);
  for (const file of stale) {
    all.push({
      file,
      line: 1,
      rule: "generated",
      message: "stale: run pnpm --filter @app/docs generate",
    });
  }
  for (const file of orphaned) {
    all.push({
      file,
      line: 1,
      rule: "generated",
      message: "no generator writes this page any more; delete it",
    });
  }
  const isKnown = (p: Problem) =>
    KNOWN_ISSUES.some((k) => k.file === p.file && k.message === p.message);
  return {
    problems: all.filter((p) => !isKnown(p)),
    known: all.filter(isKnown),
    pages: pages.length,
  };
}
