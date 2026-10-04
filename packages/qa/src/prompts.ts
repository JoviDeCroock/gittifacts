/**
 * Prompts for the three model calls. The model never sees the author's own summary of the change,
 * only the Plan's criteria, the changed file paths and what the browser showed.
 */
import type { PageSnapshot, QaCriterionInput } from "./types.js";

export const PROMPT_VERSION = "qa/1";

const DSL = `Steps (JSON objects {action, target?, value?}):
- goto: target = path on the app ("/settings")
- click: target = selector
- fill: target = selector, value = text to type
- press: value = key ("Enter", "Tab")
- select: target = <select> selector, value = option value
- wait: value = milliseconds (≤ 2000), only after something asynchronous
- expect_text: value = text that must appear; target = selector to look in (optional, default the page)
- expect_no_text: value = text that must NOT appear; target optional
- expect_visible: target = selector that must be visible
- expect_url: value = path fragment the URL must contain
Selectors: copy one from the page's element list, or write text=<visible text> for a button or link.`;

export const PLAN_SYSTEM = `You are a QA engineer testing a web app in a real browser against a Plan's acceptance criteria.
For each criterion, write a short script that would FAIL if the criterion were not met.
${DSL}
Rules:
- At most 10 steps per criterion. End with at least one expect_* step that checks the criterion itself.
- Use only selectors and texts you can see in the page snapshots. Never invent ids.
- Prefer short, exact expected texts that the criterion implies (e.g. a counter reading "1" after one click).
- If a criterion can't be checked in this browser (it needs a login, outside services, email, a server log,
  or is not about something visible), set "untestable" to a one-sentence reason and give no steps.
- Third-party requests are blocked during QA; criteria that depend on them are untestable.
Answer with JSON only: {"criteria":[{"index":0,"start":"/","steps":[...]}]}.`;

export const REPAIR_SYSTEM = `You are a QA engineer. A step of your browser script could not find its target.
Rewrite the REMAINING steps using only selectors and texts in the current page snapshot. Keep the
expectations that check the criterion; do not weaken them to make the script pass. If the page does not
offer a way to continue, set "giveUp" to the reason.
${DSL}
Answer with JSON only: {"steps":[...]} or {"steps":[],"giveUp":"..."}.`;

export const REVIEW_SYSTEM = `You review a QA run. For each criterion you get the steps that ran, which passed,
and what the page showed at the end. Say whether the evidence shows the criterion is met:
- "pass": the steps exercised the criterion and its expectations held.
- "fail": the evidence shows the criterion is NOT met (wrong text, an error, a broken page).
- "couldnt-test": the steps don't really check the criterion, or the run could not get far enough.
Be strict: if in doubt between pass and anything else, do not say pass.
Answer with JSON only: {"verdicts":[{"index":0,"verdict":"pass","reason":"one sentence"}]}.`;

export function renderSnapshot(s: PageSnapshot): string {
  const els = s.elements
    .map(
      (e) =>
        `  ${e.role}${e.type ? `[${e.type}]` : ""} "${e.name}" → ${e.selector}${e.value ? ` (value "${e.value}")` : ""}`,
    )
    .join("\n");
  return `URL ${s.url} — title "${s.title}"\nText: ${s.text}\nElements:\n${els || "  (none)"}`;
}

export function planPrompt(input: {
  criteria: Array<QaCriterionInput & { index: number }>;
  pages: PageSnapshot[];
  changedFiles: string[];
}): string {
  const criteria = input.criteria.map((c) => `${c.index}. ${c.text}`).join("\n");
  const files = input.changedFiles.slice(0, 60).join("\n") || "(unknown)";
  const pages = input.pages.map(renderSnapshot).join("\n\n");
  return `Acceptance criteria:\n${criteria}\n\nFiles the change touched:\n${files}\n\nPages as the browser sees them now:\n${pages}`;
}

export function repairPrompt(input: {
  criterion: string;
  done: string[];
  failed: string;
  remaining: string;
  page: PageSnapshot;
}): string {
  return `Criterion: ${input.criterion}\nSteps that ran:\n${input.done.join("\n") || "(none)"}\nFailed step: ${input.failed}\nRemaining steps: ${input.remaining}\n\nCurrent page:\n${renderSnapshot(input.page)}`;
}

export function reviewPrompt(
  rows: Array<{
    index: number;
    text: string;
    steps: string[];
    finalText: string;
    errors: string[];
    verdict: string;
  }>,
): string {
  return rows
    .map(
      (r) =>
        `Criterion ${r.index}: ${r.text}\nSteps:\n${r.steps.join("\n") || "(none)"}\nRunner's verdict: ${r.verdict}\nErrors: ${r.errors.join("; ") || "none"}\nPage text at the end: ${r.finalText}`,
    )
    .join("\n\n");
}
