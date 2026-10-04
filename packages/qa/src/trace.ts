/**
 * Traceability: does an assertion check what its criterion SAYS? Deterministic, no model (user
 * decision 2026-10-04). Only traced assertions decide pass / fail; an untraced one is still run and,
 * if it doesn't hold, reported as a note ("also observed: …").
 *
 * The rule, from the criterion's text alone:
 * - **numbers**: every number the assertion expects must appear in the criterion, compared as
 *   values (`€100.00` = `100`; "three" = `3`). A number the criterion never mentions doesn't trace.
 * - **text** (`expect_text`, `expect_no_text`): the expected text is one of the criterion's quoted
 *   strings (or inside one), or every word of it (3+ letters, not a stop word, singular/plural
 *   alike) appears in the criterion — and its numbers pass the number rule.
 * - **counts** (`expect_count`): the count is a number of the criterion.
 * - **elements and URLs** (`expect_visible`, `expect_url`): at least one word of the selector or
 *   path (split on non-letters) appears in the criterion.
 */
import type { Step } from "./script.js";

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  no: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  twenty: 20,
  hundred: 100,
  once: 1,
  twice: 2,
};
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "then",
  "than",
  "from",
  "into",
  "onto",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "its",
  "it's",
  "but",
  "not",
  "all",
  "any",
  "each",
  "when",
  "after",
  "before",
  "shows",
  "show",
  "page",
  "text",
  "data",
  "testid",
  "nth",
  "type",
  "div",
  "span",
  "button",
  "input",
  "class",
  "role",
  "name",
]);

/** Numbers in a text, as values ("€1,234.50" → 1234.5; "three" → 3). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, "")));
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = NUMBER_WORDS[w];
    if (n !== undefined && w !== "no") out.push(n);
  }
  return out.filter((n) => Number.isFinite(n));
}

const stem = (w: string) =>
  w.length > 4 && w.endsWith("ies")
    ? `${w.slice(0, -3)}y`
    : w.length > 3 && w.endsWith("s") && !w.endsWith("ss")
      ? w.slice(0, -1)
      : w;

/** Content words (3+ letters, no stop words, singular), lowercased. */
export function wordsIn(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((w) => w.length >= 3 && !STOP.has(w) && NUMBER_WORDS[w] === undefined)
    .map(stem);
}

/** Quoted strings of a criterion ('…', "…", “…”, ‘…’, `…`). */
export function quotesIn(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"|'([^']{2,})'|“([^”]+)”|‘([^’]+)’|`([^`]+)`/g)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim())
    .filter(Boolean);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface Trace {
  traced: boolean;
  /** Why not, for the note. */
  why?: string;
}

/** Whether an expectation step traces to `criterion` (actions are not subject to the rule). */
export function traceStep(criterion: string, s: Pick<Step, "action" | "target" | "value">): Trace {
  const nums = new Set(numbersIn(criterion));
  const words = new Set(wordsIn(criterion));
  const numbersOk = (v: string): Trace => {
    const missing = numbersIn(v).filter((n) => !nums.has(n));
    return missing.length === 0
      ? { traced: true }
      : { traced: false, why: `${missing.join(", ")} is not in the criterion` };
  };
  switch (s.action) {
    case "expect_text":
    case "expect_no_text": {
      const v = s.value ?? "";
      const n = numbersOk(v);
      if (!n.traced) return n;
      if (quotesIn(criterion).some((q) => norm(q).includes(norm(v)) || norm(v).includes(norm(q))))
        return { traced: true };
      const vw = wordsIn(v);
      const missing = vw.filter((w) => !words.has(w));
      if (vw.length === 0 && numbersIn(v).length === 0)
        return { traced: false, why: "it expects nothing the criterion names" };
      return missing.length === 0
        ? { traced: true }
        : { traced: false, why: `"${missing.join(" ")}" is not in the criterion` };
    }
    case "expect_count": {
      const n = Number(s.value);
      return Number.isFinite(n) && nums.has(n)
        ? { traced: true }
        : { traced: false, why: `the count ${s.value ?? "?"} is not in the criterion` };
    }
    case "expect_visible":
    case "expect_url": {
      const subject = s.action === "expect_url" ? (s.value ?? s.target ?? "") : (s.target ?? "");
      return wordsIn(subject).some((w) => words.has(w))
        ? { traced: true }
        : { traced: false, why: `"${subject}" names nothing in the criterion` };
    }
    default:
      return { traced: true };
  }
}
