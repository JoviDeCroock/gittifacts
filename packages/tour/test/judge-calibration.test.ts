/**
 * The judge calibration set through the real judge (prompt, rendering, parsing, citation rule)
 * with a SCRIPTED model. What a real model answers is measured by scripts/calibrate-judge.ts; this
 * pins down what the platform does with each kind of answer:
 * - a properly cited concern stays a concern (Lane 2);
 * - an uncited or invalidly cited concern becomes unsure (Lane 1), never no-concern;
 * - no-concern and unsure are never touched.
 */
import { LlmJudgment } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm.js";
import { JUDGE_QUESTIONS, type JudgeOutcome, type JudgeQuestion } from "../src/schema.js";
import { createReviewer } from "../src/tour.js";
import {
  CALIBRATION_CASES,
  type CalibrationCase,
  calibrationPlan,
  passes,
  worstOutcome,
} from "./support/calibration.js";

const budget = { changeId: "chg_calibration", limitUsd: 5, spentUsd: 0 };

type Answer = { outcome: JudgeOutcome; rationale?: string; citations?: unknown[] };

/** Run one case with a model that answers `answers[q]` (default: no-concern, no citations). */
async function judgeWith(c: CalibrationCase, answers: Partial<Record<JudgeQuestion, Answer>>) {
  const client = new FakeLlmClient([
    {
      json: {
        judgments: JUDGE_QUESTIONS.map((question) => {
          const a = answers[question] ?? { outcome: "no-concern" };
          return {
            question,
            outcome: a.outcome,
            rationale: a.rationale ?? `${question}: scripted ${a.outcome}.`,
            citations: a.citations ?? [],
          };
        }),
      },
    },
  ]);
  const result = await createReviewer(client).judge({
    plan: calibrationPlan(c),
    diff: c.diff,
    ...(c.facts === undefined ? {} : { facts: c.facts }),
    budget,
  });
  for (const item of result.items) expect(LlmJudgment.safeParse(item).success).toBe(true);
  const byQuestion = Object.fromEntries(result.items.map((x) => [x.question, x])) as Record<
    JudgeQuestion,
    LlmJudgment
  >;
  return { result, byQuestion, prompt: client.requests[0]!.messages[0]!.content };
}

function citationOf(c: CalibrationCase, extra: Record<string, unknown> = {}) {
  const at = c.concernAt?.[0] ?? { file: c.diff.files[0]!.path, hunk: 1 };
  return {
    file: at.file,
    hunk: at.hunk,
    behavior: "Does something the plan does not ask for.",
    planBasis: "not-in-plan",
    planQuote: null,
    ...extra,
  };
}

const concernCases = CALIBRATION_CASES.filter((c) => c.expected !== "in-scope");

describe("judge calibration set", () => {
  it("has in-scope and concern cases, each valid against the domain schemas", () => {
    expect(CALIBRATION_CASES.length).toBeGreaterThanOrEqual(10);
    expect(CALIBRATION_CASES.filter((c) => c.expected === "in-scope").length).toBeGreaterThan(3);
    expect(concernCases.length).toBeGreaterThan(3);
    for (const c of concernCases) {
      for (const at of c.concernAt ?? []) {
        const file = c.diff.files.find((f) => f.path === at.file);
        expect(file?.hunks[at.hunk - 1], `${c.id}: ${at.file} hunk ${at.hunk}`).toBeDefined();
      }
    }
  });

  it("scores worst outcomes per label", () => {
    expect(passes("in-scope", "no-concern")).toBe(true);
    expect(passes("in-scope", "unsure")).toBe(true);
    expect(passes("in-scope", "concern")).toBe(false);
    expect(passes("hidden-behavior", "concern")).toBe(true);
    expect(passes("out-of-scope", "unsure")).toBe(false);
    expect(worstOutcome(["no-concern", "concern", "unsure"])).toBe("concern");
  });
});

describe.each(CALIBRATION_CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
  it("puts the plan before the diff in the prompt", async () => {
    const { prompt } = await judgeWith(c, {});
    const diffAt = prompt.indexOf("<diff>");
    for (const part of [
      `Title: ${c.plan.title}`,
      c.plan.intent,
      ...c.plan.acceptanceCriteria,
      ...c.plan.outOfScope,
      `Scope paths: ${c.plan.scopePaths.join(", ")}`,
    ]) {
      const at = prompt.indexOf(part);
      expect(at, part).toBeGreaterThanOrEqual(0);
      expect(at, part).toBeLessThan(diffAt);
    }
  });

  it("leaves no-concern and unsure answers alone", async () => {
    const { byQuestion } = await judgeWith(c, {
      "plan-conformance": { outcome: "unsure", rationale: "Cannot see the test run." },
    });
    expect(byQuestion["scope-drift"]).toMatchObject({ outcome: "no-concern", status: "ok" });
    expect(byQuestion["plan-conformance"]).toMatchObject({
      outcome: "unsure",
      rationale: "Cannot see the test run.",
    });
    expect(byQuestion["plan-conformance"].note).toBeUndefined();
  });

  it("downgrades an uncited concern to unsure (never lower), and says so", async () => {
    const { byQuestion } = await judgeWith(c, {
      "scope-drift": { outcome: "concern", rationale: "Looks broader than planned." },
      "hidden-behavior-change": {
        outcome: "concern",
        rationale: "Might change behavior.",
        citations: [{ file: "src/nowhere.ts", hunk: 1, planBasis: "not-in-plan", planQuote: null }],
      },
    });
    expect(byQuestion["scope-drift"]).toMatchObject({
      status: "ok",
      outcome: "unsure",
      rationale:
        "Concern downgraded to unsure: no hunk citation. Model's rationale: Looks broader than planned.",
      note: "concern downgraded to unsure: no hunk citation",
    });
    expect(byQuestion["hidden-behavior-change"]).toMatchObject({
      outcome: "unsure",
      note: expect.stringMatching(/src\/nowhere\.ts is not a reviewed file of the diff/),
    });
    expect(byQuestion["plan-conformance"].outcome).toBe("no-concern");
  });
});

describe.each(concernCases.map((c) => [c.id, c] as const))("%s (a concern case)", (_id, c) => {
  it("keeps a concern that cites the offending hunk, with the citation in the rationale", async () => {
    const at = c.concernAt![0]!;
    const { byQuestion } = await judgeWith(c, {
      "hidden-behavior-change": {
        outcome: "concern",
        rationale: "The diff does more than the plan states.",
        citations: [citationOf(c)],
      },
      "scope-drift": {
        outcome: "concern",
        rationale: "Goes beyond the intent.",
        citations: [
          citationOf(c, {
            planBasis: "goes-beyond",
            // Quoted with different case and punctuation: still the plan's sentence.
            planQuote: `${c.plan.acceptanceCriteria[0]!.toUpperCase()}.`,
          }),
        ],
      },
    });
    expect(byQuestion["hidden-behavior-change"]).toMatchObject({ outcome: "concern" });
    expect(byQuestion["hidden-behavior-change"].rationale).toContain(
      `Cited: ${at.file} hunk ${at.hunk} (`,
    );
    expect(byQuestion["hidden-behavior-change"].rationale).toContain("not mentioned by the plan");
    expect(byQuestion["hidden-behavior-change"].note).toBeUndefined();
    expect(byQuestion["scope-drift"]).toMatchObject({ outcome: "concern" });
    expect(byQuestion["scope-drift"].rationale).toContain("goes-beyond the plan:");
    const worst = worstOutcome(Object.values(byQuestion).map((x) => x.outcome));
    expect(passes(c.expected, worst)).toBe(true);
  });

  it.each([
    ["a hunk the file does not have", { hunk: 99 }, /has no hunk 99/],
    ["a file outside the diff", { file: "src/elsewhere.ts" }, /not a reviewed file/],
    [
      "contradicts without a plan quote",
      { planBasis: "contradicts", planQuote: null },
      /without the plan sentence/,
    ],
    [
      "a quote the plan does not contain",
      { planBasis: "goes-beyond", planQuote: "Rewrite the service in Rust and drop all tests" },
      /is not in the plan/,
    ],
    ["no planBasis", { planBasis: undefined }, /without file, hunk or planBasis/],
  ])("downgrades a concern citing %s to unsure", async (_what, extra, problem) => {
    const { byQuestion } = await judgeWith(c, {
      "hidden-behavior-change": {
        outcome: "concern",
        rationale: "Hidden change.",
        citations: [citationOf(c, extra)],
      },
    });
    const j = byQuestion["hidden-behavior-change"];
    expect(j.outcome).toBe("unsure");
    expect(j.rationale).toMatch(/^Concern downgraded to unsure: no valid citation \(/);
    expect(j.note).toMatch(problem);
  });

  it("keeps a concern when one of several citations is valid, noting the ignored ones", async () => {
    const { byQuestion } = await judgeWith(c, {
      "hidden-behavior-change": {
        outcome: "concern",
        rationale: "Hidden change.",
        citations: [citationOf(c, { hunk: 42 }), citationOf(c)],
      },
    });
    const j = byQuestion["hidden-behavior-change"];
    expect(j.outcome).toBe("concern");
    expect(j.note).toMatch(/^1 invalid citation\(s\) ignored: .*has no hunk 42/);
  });
});
