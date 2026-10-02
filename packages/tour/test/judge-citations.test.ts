import { describe, expect, it } from "vitest";
import { applyCitationRule, checkCitation, quoteInPlan } from "../src/judge-citations.js";
import { FakeLlmClient } from "../src/llm.js";
import {
  buildJudgeUserPrompt,
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM_PROMPT,
  PROMPT_VERSION,
} from "../src/prompt.js";
import { JUDGE_JSON_SCHEMA } from "../src/schema.js";
import { createReviewer } from "../src/tour.js";
import { CALIBRATION_CASES, calibrationPlan } from "./support/calibration.js";
import { breakingApiDiff, CHANGE_ID, diffOf, file, hunk, plan } from "./support/scenario.js";

const p = plan();
const ctx = (overrides: Partial<Parameters<typeof checkCitation>[1]> = {}) => ({
  diff: breakingApiDiff(),
  plan: p,
  shown: () => true,
  ...overrides,
});
const cite = (extra: Record<string, unknown> = {}) => ({
  file: "src/format.ts",
  hunk: 1,
  behavior: "Changes the signature.",
  planBasis: "not-in-plan",
  planQuote: null,
  ...extra,
});

describe("quoteInPlan", () => {
  it("accepts plan sentences word for word, ignoring case, punctuation and labels", () => {
    expect(quoteInPlan("parseMoney still parses the code style", p)).toBe(true);
    expect(quoteInPlan("“PARSEMONEY still parses the code style.”", p)).toBe(true);
    expect(quoteInPlan("Out of scope: Locale-aware formatting via Intl", p)).toBe(true);
    expect(quoteInPlan("Let formatMoney() render currency symbols", p)).toBe(true);
    expect(quoteInPlan("src/format.ts", p)).toBe(true);
  });

  it("tolerates light paraphrase and elisions in longer quotes", () => {
    expect(quoteInPlan("Give formatMoney an options parameter … update every caller", p)).toBe(
      true,
    );
  });

  it("rejects sentences the plan does not contain, and inexact short quotes", () => {
    expect(quoteInPlan("Cache every response for an hour", p)).toBe(false);
    expect(quoteInPlan("symbols render", p)).toBe(false);
    expect(quoteInPlan("", p)).toBe(false);
  });
});

describe("checkCitation", () => {
  it("accepts a shown hunk, canonicalizes a/ b/ prefixes and string hunk numbers", () => {
    const r = checkCitation(cite({ file: "b/src/format.ts", hunk: "hunk 2" }), ctx());
    expect(r).toMatchObject({ ok: true, citation: { file: "src/format.ts", hunk: 2 } });
  });

  it("accepts the whole rendered file header as the file (seen live with Kimi K2.7 Code)", () => {
    const r = checkCitation(cite({ file: "=== src/format.ts (modified, +12 -9) ===" }), ctx());
    expect(r).toMatchObject({ ok: true, citation: { file: "src/format.ts", hunk: 1 } });
    expect(checkCitation(cite({ file: "=== src/other.ts (added) ===" }), ctx())).toMatchObject({
      ok: false,
      problem: "unknown-file",
    });
  });

  it("rejects a hunk that was omitted from the prompt (the model never read it)", () => {
    const r = checkCitation(cite(), ctx({ shown: (_path, index) => index !== 0 }));
    expect(r).toMatchObject({ ok: false, problem: "hunk-not-shown" });
  });

  it("without a plan only the hunk is checked: there is nothing to quote", () => {
    const r = checkCitation(
      cite({ planBasis: "contradicts", planQuote: null }),
      ctx({ plan: null }),
    );
    expect(r).toMatchObject({ ok: true, citation: { planBasis: "not-in-plan", planQuote: null } });
    const bad = checkCitation(cite({ hunk: 9 }), ctx({ plan: null }));
    expect(bad).toMatchObject({ ok: false, problem: "unknown-hunk" });
  });
});

describe("applyCitationRule", () => {
  it("never touches no-concern or unsure, even with junk citations", () => {
    for (const outcome of ["no-concern", "unsure"] as const) {
      const r = applyCitationRule({ outcome, rationale: "r", citations: [{ junk: true }] }, ctx());
      expect(r).toMatchObject({ outcome, rationale: "r", downgraded: false });
      expect(r.note).toBeUndefined();
    }
  });

  it("downgrades a concern without a valid citation to unsure, never further", () => {
    const r = applyCitationRule(
      { outcome: "concern", rationale: "r", citations: [{ junk: true }] },
      ctx(),
    );
    expect(r).toMatchObject({ outcome: "unsure", downgraded: true });
    expect(r.note).toMatch(/^concern downgraded to unsure: no valid citation \(a citation without/);
  });
});

describe("judge without a plan", () => {
  const diff = diffOf([
    file("src/a.ts", [
      hunk(1, 1, [
        ["-", "x(1)"],
        ["+", "x(2)"],
      ]),
    ]),
  ]);
  const run = (citations: unknown[]) =>
    createReviewer(
      new FakeLlmClient([
        {
          json: {
            judgments: [
              { question: "hidden-behavior-change", outcome: "concern", rationale: "r", citations },
            ],
          },
        },
      ]),
    ).judge({ plan: null, diff, budget: { changeId: CHANGE_ID, limitUsd: 5, spentUsd: 0 } });

  it("keeps a concern citing a hunk (no plan quote needed)", async () => {
    const out = await run([
      { file: "src/a.ts", hunk: 1, planBasis: "not-in-plan", planQuote: null },
    ]);
    const j = out.items.find((x) => x.question === "hidden-behavior-change");
    expect(j).toMatchObject({ outcome: "concern", status: "ok" });
    // The plan questions stay skipped (ignored by the classifier), as before.
    expect(out.items.filter((x) => x.status === "skipped")).toHaveLength(2);
  });

  it("downgrades an uncited one to unsure", async () => {
    const out = await run([]);
    const j = out.items.find((x) => x.question === "hidden-behavior-change");
    expect(j).toMatchObject({
      outcome: "unsure",
      note: "concern downgraded to unsure: no hunk citation",
    });
  });
});

describe("judge prompt", () => {
  const c = CALIBRATION_CASES[0]!;
  const planned = buildJudgeUserPrompt({
    plan: calibrationPlan(c),
    diffText: "=== src/app.ts (modified, +2 -0) ===",
    questions: ["scope-drift", "plan-conformance", "hidden-behavior-change"],
  });

  it("has its own version, separate from the tour's", () => {
    expect(JUDGE_PROMPT_VERSION).toMatch(/^judge-\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(PROMPT_VERSION).toMatch(/^tour-/);
  });

  it("states what a concern is, what is not, and requires a citation", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('"concern" means one of these, and nothing else');
    expect(JUDGE_SYSTEM_PROMPT).toContain("tests for the new behavior, types, imports and exports");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Every concern needs at least one citation");
    expect(JUDGE_SYSTEM_PROMPT).toContain('the number N from "@@ hunk N"');
    expect(JUDGE_SYSTEM_PROMPT).toContain("copied word for word from <plan>");
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'A concern without a valid citation is downgraded to "unsure"',
    );
  });

  it("puts title, intent, criteria, out-of-scope and scope paths before the diff", () => {
    const diffAt = planned.indexOf("<diff>");
    expect(planned.indexOf("The approved plan comes first")).toBe(0);
    for (const part of [
      "Title: Add GET /version",
      "Intent: Add GET /version returning the deployed version",
      "Acceptance criteria:",
      "Outside a deployment (no VERSION binding)",
      "Out of scope:",
      "Scope paths: src/app.ts, test/version.test.ts",
    ]) {
      expect(planned.indexOf(part), part).toBeGreaterThan(0);
      expect(planned.indexOf(part), part).toBeLessThan(diffAt);
    }
    // The citation checklist comes last, after the questions.
    expect(planned.indexOf('Before you answer "concern"')).toBeGreaterThan(
      planned.indexOf("Questions (answer each exactly once)"),
    );
  });

  it("without a plan asks only about hidden behavior and asks for not-in-plan citations", () => {
    const planless = buildJudgeUserPrompt({
      plan: null,
      diffText: "",
      questions: ["hidden-behavior-change"],
    });
    expect(planless).toContain("No plan is attached to this change.");
    expect(planless).toContain('planBasis "not-in-plan" and planQuote null');
    expect(planless).not.toContain("scope-drift:");
    expect(planless).not.toContain('Before you answer "concern"');
  });

  it("asks for citations in the structured output (every field required for strict mode)", () => {
    const schema = JUDGE_JSON_SCHEMA as {
      properties: {
        judgments: { items: { required: string[]; properties: Record<string, never> } };
      };
    };
    const judgment = schema.properties.judgments.items;
    expect(judgment.required).toEqual(["question", "outcome", "rationale", "citations"]);
    const citation = (
      judgment.properties.citations as unknown as {
        items: { required: string[]; additionalProperties: boolean };
      }
    ).items;
    expect(citation.required).toEqual(["file", "hunk", "behavior", "planBasis", "planQuote"]);
    expect(citation.additionalProperties).toBe(false);
    expect(JSON.stringify(JUDGE_JSON_SCHEMA)).toContain('"not-in-plan"');
  });
});
