/**
 * The judge's citation rule. A "concern" raises a Change to Lane 2, so it must say where and why:
 * a hunk of the diff the model was shown, and the plan sentence that hunk contradicts or goes
 * beyond (or the statement that the plan does not mention it). A concern without one valid
 * citation is downgraded to "unsure" (Lane 1): never lower, and never to "no-concern". The
 * downgrade is written into the judgment's rationale and note so it can be audited.
 *
 * "no-concern" and "unsure" answers are never touched: the rule only ever narrows how far a model
 * can raise, it cannot lower anything else.
 */
import type { ChangeDiff, Plan } from "@app/domain";
import { baseRange, findFile, headRange } from "./diff.js";
import { type JudgeOutcome, LenientModelCitation, type PlanBasis } from "./schema.js";

export interface CitationContext {
  /** The diff the model reviewed (verified-transform files already removed). */
  diff: ChangeDiff;
  /** Whether hunk `index` (0-based) of `path` was shown to the model (not omitted). */
  shown: (path: string, index: number) => boolean;
  plan: Plan | null;
}

export type CitationProblem =
  | "malformed"
  | "unknown-file"
  | "unknown-hunk"
  | "hunk-not-shown"
  | "missing-plan-quote"
  | "quote-not-in-plan";

export interface CheckedCitation {
  /** The diff's (head) path. */
  file: string;
  /** 1-based, as shown in `@@ hunk N`. */
  hunk: number;
  /** e.g. "head 20-27 · base 20-21". */
  lines: string;
  behavior: string | null;
  planBasis: PlanBasis;
  planQuote: string | null;
}

export type CitationCheck =
  | { ok: true; citation: CheckedCitation }
  | { ok: false; problem: CitationProblem; detail: string };

export interface CitedAnswer {
  outcome: JudgeOutcome;
  rationale: string;
  /** Raw citations as the model sent them. */
  citations: readonly unknown[];
}

export interface RuledAnswer {
  outcome: JudgeOutcome;
  rationale: string;
  /** Audit note: why a concern was downgraded, or which citations were ignored. */
  note?: string;
  citations: CheckedCitation[];
  downgraded: boolean;
}

function words(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** The plan as quotable lines (labels included, so a quote that keeps the label still matches). */
export function planLines(plan: Plan): string[] {
  return [
    `Title: ${plan.title}`,
    `Intent: ${plan.intent}`,
    ...plan.acceptanceCriteria.map((c) => `Acceptance criteria: ${c}`),
    ...plan.outOfScope.map((c) => `Out of scope: ${c}`),
    ...plan.riskDeclarations.map((r) => `Declared risks: ${r.area}: ${r.description}`),
    `Scope paths: ${plan.scopePaths.join(", ")}`,
    `Affected routes: ${plan.affectedRoutes.join(", ")}`,
  ];
}

/** Share of a long quote's words that must appear in one plan line (light paraphrase, elisions). */
const QUOTE_WORD_OVERLAP = 0.75;
const MIN_FUZZY_QUOTE_WORDS = 4;

/**
 * True when `quote` comes from the plan: word for word (ignoring case and punctuation) within one
 * plan line, or, for quotes of four or more words, with at least 75% of its words in one line.
 */
export function quoteInPlan(quote: string, plan: Plan): boolean {
  const q = words(quote);
  if (q.length === 0) return false;
  const needle = ` ${q.join(" ")} `;
  for (const line of planLines(plan)) {
    const l = words(line);
    if (` ${l.join(" ")} `.includes(needle)) return true;
    if (q.length >= MIN_FUZZY_QUOTE_WORDS) {
      const set = new Set(l);
      const hits = q.filter((w) => set.has(w)).length;
      if (hits / q.length >= QUOTE_WORD_OVERLAP) return true;
    }
  }
  return false;
}

function linesLabel(h: ChangeDiff["files"][number]["hunks"][number]): string {
  const head = headRange(h);
  const base = baseRange(h);
  const parts: string[] = [];
  if (head) parts.push(`head ${head.startLine}-${head.endLine}`);
  if (base) parts.push(`base ${base.startLine}-${base.endLine}`);
  return parts.join(" · ");
}

function short(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The path a model meant: models sometimes copy the whole rendered file header
 * (`=== src/auth.ts (modified, +2 -1) ===`) instead of the path inside it.
 */
export function citedPath(file: string): string {
  const header = /^=+\s*(.+?)(?:\s+\([^()]*\))?\s*=*\s*$/.exec(file.trim());
  return header?.[1] ?? file.trim();
}

/** Check one citation against the diff the model was shown and the plan. */
export function checkCitation(raw: unknown, ctx: CitationContext): CitationCheck {
  const parsed = LenientModelCitation.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: "malformed",
      detail: "a citation without file, hunk or planBasis",
    };
  }
  const c = parsed.data;
  const file = findFile(ctx.diff, citedPath(c.file));
  if (file === undefined) {
    return {
      ok: false,
      problem: "unknown-file",
      detail: `${short(c.file, 120)} is not a reviewed file of the diff`,
    };
  }
  const hunk = file.hunks[c.hunk - 1];
  if (hunk === undefined) {
    return {
      ok: false,
      problem: "unknown-hunk",
      detail: `${file.path} has no hunk ${c.hunk} (it has ${file.hunks.length})`,
    };
  }
  if (!ctx.shown(file.path, c.hunk - 1)) {
    return {
      ok: false,
      problem: "hunk-not-shown",
      detail: `${file.path} hunk ${c.hunk} was omitted from the prompt, so the model did not read it`,
    };
  }
  const quote = c.planQuote === null || c.planQuote === undefined ? "" : c.planQuote.trim();
  // Without a plan there is nothing to quote: every behavior is "not in the plan".
  if (ctx.plan !== null && c.planBasis !== "not-in-plan") {
    if (quote === "") {
      return {
        ok: false,
        problem: "missing-plan-quote",
        detail: `${file.path} hunk ${c.hunk}: "${c.planBasis}" without the plan sentence it refers to`,
      };
    }
    if (!quoteInPlan(quote, ctx.plan)) {
      return {
        ok: false,
        problem: "quote-not-in-plan",
        detail: `${file.path} hunk ${c.hunk}: "${short(quote, 160)}" is not in the plan`,
      };
    }
  }
  return {
    ok: true,
    citation: {
      file: file.path,
      hunk: c.hunk,
      lines: linesLabel(hunk),
      behavior: c.behavior === undefined || c.behavior === "" ? null : c.behavior,
      planBasis: ctx.plan === null ? "not-in-plan" : c.planBasis,
      planQuote: ctx.plan === null || c.planBasis === "not-in-plan" || quote === "" ? null : quote,
    },
  };
}

/** One line per citation, for the rationale (the classifier shows its first ~280 characters). */
export function formatCitation(c: CheckedCitation): string {
  const what = c.behavior === null ? "" : `: ${short(c.behavior, 240)}`;
  const basis =
    c.planBasis === "not-in-plan"
      ? "not mentioned by the plan"
      : `${c.planBasis} the plan: "${short(c.planQuote ?? "", 240)}"`;
  return `${c.file} hunk ${c.hunk} (${c.lines})${what} (${basis})`;
}

const MAX_LISTED_PROBLEMS = 4;

/**
 * Apply the citation rule to one answer. Only "concern" is affected: with at least one valid
 * citation it stays a concern (the valid citations are appended to the rationale); without one it
 * becomes "unsure", with the reason in front of the model's rationale and in the note.
 */
export function applyCitationRule(answer: CitedAnswer, ctx: CitationContext): RuledAnswer {
  if (answer.outcome !== "concern") {
    return {
      outcome: answer.outcome,
      rationale: answer.rationale,
      citations: [],
      downgraded: false,
    };
  }
  const valid: CheckedCitation[] = [];
  const problems: string[] = [];
  for (const raw of answer.citations) {
    const r = checkCitation(raw, ctx);
    if (r.ok) valid.push(r.citation);
    else problems.push(r.detail);
  }
  const listed =
    problems.slice(0, MAX_LISTED_PROBLEMS).join("; ") +
    (problems.length > MAX_LISTED_PROBLEMS
      ? `; +${problems.length - MAX_LISTED_PROBLEMS} more`
      : "");
  if (valid.length === 0) {
    const why =
      answer.citations.length === 0 ? "no hunk citation" : `no valid citation (${listed})`;
    const note = `concern downgraded to unsure: ${why}`;
    return {
      outcome: "unsure",
      rationale: `Concern downgraded to unsure: ${why}. Model's rationale: ${answer.rationale}`,
      note,
      citations: [],
      downgraded: true,
    };
  }
  const out: RuledAnswer = {
    outcome: "concern",
    rationale: `${answer.rationale} Cited: ${valid.map(formatCitation).join("; ")}.`,
    citations: valid,
    downgraded: false,
  };
  if (problems.length > 0) out.note = `${problems.length} invalid citation(s) ignored: ${listed}`;
  return out;
}
