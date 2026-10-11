/**
 * Style lint: pages stay short (≤ 300 lines), prose has no filler words, no paragraph runs past
 * four sentences, and getting-started pages and guides keep to a word budget. Code, inline code,
 * link targets, tables and `<details>` folds are not counted as visible prose.
 */
import type { Page } from "../content.js";
import type { Extracted } from "./extract.js";
import type { Problem } from "./problem.js";

export const MAX_LINES = 300;
export const MAX_SENTENCES = 4;

/** Visible prose words per page, by section (docs/ux-review/docs-audit-2026-10-03.md, rule 5). */
export const WORD_BUDGET: readonly { section: string; max: number }[] = [
  { section: "get-started", max: 400 },
  { section: "guides", max: 700 },
];

/** Words a reader sees before opening any fold: paragraphs and list items outside `<details>`. */
export function visibleWords(x: Extracted): number {
  return x.paragraphs
    .filter((p) => !p.folded)
    .reduce(
      (n, p) =>
        n +
        p.text
          .replace(/`code`/g, " ")
          .split(/\s+/)
          .filter((w) => /\w/.test(w)).length,
      0,
    );
}

const FILLER = /\b(simply|just|easily|obviously|basically|of course|clearly)\b/i;

/**
 * Retired user-facing terms (DECISIONS 2026-10-04, "User-facing terms"): hand-written prose must use
 * the replacement. Machine names in code spans (`tour_ready`, `get_tour`, `shadow`) are not prose.
 */
export const BANNED_TERMS: readonly { term: RegExp; use: string }[] = [
  { term: /\bpush grants?\b/i, use: "push token" },
  { term: /\bbootstrap Changes?\b/i, use: "first Change" },
  { term: /\b(async )?glance\b/i, use: "quick review (Lane 1)" },
  { term: /\bshadow[- ]mode\b/i, use: "calibrating (on gittifacts) or report-only (on GitHub)" },
  { term: /\btours?\b/i, use: "walkthrough" },
  { term: /\bdeploy trains?\b/i, use: "deploy batch" },
  { term: /\bunclaimed projects?\b/i, use: "unclaimed repo" },
];

/** Sentences in plain prose. Abbreviations and versions don't end one; a capital or digit starts one. */
export function sentences(text: string): string[] {
  const cleaned = text
    .replace(/\b(e\.g|i\.e|etc|vs|cf|approx)\./gi, "$1")
    .replace(/(\d)\.(\d)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return [];
  return cleaned.split(/(?<=[.!?])\s+(?=["“(`*[]?[A-Z0-9])/).filter((s) => s.trim() !== "");
}

export function checkStyle(page: Page, x: Extracted): Problem[] {
  const problems: Problem[] = [];
  const lines = page.raw.split("\n").length;
  if (lines > MAX_LINES) {
    problems.push({
      file: page.file,
      line: 1,
      rule: "length",
      message: `${lines} lines; split the page (max ${MAX_LINES})`,
    });
  }
  const budget = WORD_BUDGET.find(
    (b) => page.section === b.section || page.section.startsWith(`${b.section}/`),
  );
  if (budget !== undefined && !page.fm.generated) {
    const words = visibleWords(x);
    if (words > budget.max) {
      problems.push({
        file: page.file,
        line: 1,
        rule: "length",
        message: `${words} words of visible prose (max ${budget.max}): fold edge cases into <details> or move them to a concept or reference page`,
      });
    }
  }
  for (const p of x.paragraphs) {
    if (!page.fm.generated) {
      for (const b of BANNED_TERMS) {
        const hit = b.term.exec(p.text);
        if (hit !== null) {
          problems.push({
            file: page.file,
            line: p.line,
            rule: "style",
            message: `retired term "${hit[0]}": say "${b.use}"`,
          });
        }
      }
    }
    const filler = FILLER.exec(p.text);
    if (filler !== null) {
      problems.push({
        file: page.file,
        line: p.line,
        rule: "style",
        message: `filler word "${filler[1]}"`,
      });
    }
    const n = sentences(p.text).length;
    if (n > MAX_SENTENCES) {
      problems.push({
        file: page.file,
        line: p.line,
        rule: "style",
        message: `paragraph of ${n} sentences (max ${MAX_SENTENCES}): split it or make it a list`,
      });
    }
  }
  return problems;
}
