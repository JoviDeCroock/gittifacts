/**
 * The reviewer against the real, pure classifier (its fixture scenarios), not hand-written
 * classifications: the M3 acceptance for breaking-api, and the judge's interaction with planless
 * Lane 0.
 */
import { classify } from "@app/classifier";
import { breakingApi, codemodRename } from "@app/classifier/test/scenarios";
import type { LlmJudgment } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm.js";
import { createReviewer } from "../src/tour.js";
import {
  BASE_SHA,
  breakingApiDiff,
  CHANGE_ID,
  diffOf,
  FORMAT_DECL_HEAD_LINE,
  file,
  goodModelTour,
  HEAD_SHA,
  hunk,
  INTENT_STOP,
  signed,
  stop,
  UNCOVERED_STOP,
} from "./support/scenario.js";

type Input = ReturnType<typeof breakingApi>["input"];
const run = (i: Input) => classify(i.evidence, i.policy, i.plan, i.diffStats, i.change, i.context);
const budget = { changeId: CHANGE_ID, limitUsd: 5, spentUsd: 0 };

describe("M3 acceptance with the real classifier: breaking-api", () => {
  it("the tour lists the breaking export as its riskiest stop", async () => {
    const scenario = breakingApi();
    const classification = run(scenario.input);
    expect(classification.computedLane).toBe(2);
    expect(
      classification.reasons.find((r) => r.code === "api.breaking")?.evidenceRef,
    ).toBeDefined();

    // The model leads with a large-but-harmless test hunk and never mentions the export.
    const distraction = stop({
      kind: "risk",
      title: "Test file rewritten",
      why: "Many assertions changed.",
      hunkRefs: [{ file: "test/format.test.ts", startLine: 10, endLine: 30, side: "head" }],
      verdict: "risk",
    });
    const client = new FakeLlmClient([
      { json: goodModelTour({ stops: [distraction, INTENT_STOP, UNCOVERED_STOP] }) },
    ]);
    const outcome = await createReviewer(client).tour({
      change: {
        id: CHANGE_ID,
        title: "Let formatMoney() render currency symbols",
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
      },
      plan: scenario.input.plan,
      diff: breakingApiDiff(),
      evidence: signed(scenario.input.evidence?.items ?? []),
      classification,
      budget,
    });
    if (outcome.status !== "ok") throw new Error(outcome.reason);

    const riskiest = outcome.tour.stops.find((s) => s.kind === "risk");
    expect(riskiest?.title).toBe("Breaking export: formatMoney");
    expect(riskiest?.verdict).toBe("risk");
    expect(
      riskiest?.hunkRefs.some(
        (r) =>
          r.file === "src/format.ts" &&
          r.startLine <= FORMAT_DECL_HEAD_LINE &&
          FORMAT_DECL_HEAD_LINE <= r.endLine,
      ),
    ).toBe(true);
    // And the tour itself does not lower the lane: classify again with tourStatus ok.
    const after = run({
      ...scenario.input,
      context: { ...scenario.input.context, tourStatus: "ok" },
    });
    expect(after.computedLane).toBe(2);
  });
});

describe("judge × classifier", () => {
  function planless() {
    const scenario = codemodRename({ lane0Enabled: true });
    const input: Input = {
      ...scenario.input,
      plan: null,
      policy: { ...scenario.input.policy, planlessLane0: ["verified-transform"] },
    };
    return input;
  }

  const diff = diffOf([
    file("src/format.ts", [
      hunk(1, 1, [
        ["-", "requireCurrency(x)"],
        ["+", "toCurrencyCode(x)"],
      ]),
    ]),
  ]);

  it("a planless verified transform stays Lane 0 after the judge runs without a plan", async () => {
    const input = planless();
    expect(run(input).computedLane).toBe(0);

    const client = new FakeLlmClient([
      {
        json: {
          judgments: [
            {
              question: "hidden-behavior-change",
              outcome: "no-concern",
              rationale: "Rename only.",
            },
          ],
        },
      },
    ]);
    const judged = await createReviewer(client).judge({ plan: null, diff, budget });
    const items = [...(input.evidence?.items ?? []), ...judged.items];
    const result = run({ ...input, evidence: { items } });
    expect(result.computedLane).toBe(0);
    expect(result.reasons.map((r) => r.code)).not.toContain("llm.unsure");
  });

  it("but a concern from the judge still raises it", async () => {
    const input = planless();
    const client = new FakeLlmClient([
      {
        json: {
          judgments: [
            {
              question: "hidden-behavior-change",
              outcome: "concern",
              rationale: "src/format.ts:1 changes error handling.",
              citations: [
                {
                  file: "src/format.ts",
                  hunk: 1,
                  behavior: "Swaps requireCurrency for toCurrencyCode, which does not throw.",
                  planBasis: "not-in-plan",
                  planQuote: null,
                },
              ],
            },
          ],
        },
      },
    ]);
    const judged = await createReviewer(client).judge({ plan: null, diff, budget });
    const items: LlmJudgment[] = judged.items;
    const result = run({
      ...input,
      evidence: { items: [...(input.evidence?.items ?? []), ...items] },
    });
    expect(result.computedLane).toBe(2);
    expect(result.reasons.map((r) => r.code)).toContain("llm.concern");
  });

  it("an uncited concern is downgraded to unsure: Lane 1, never Lane 0", async () => {
    const input = planless();
    const client = new FakeLlmClient([
      {
        json: {
          judgments: [
            {
              question: "hidden-behavior-change",
              outcome: "concern",
              rationale: "Something feels off.",
              citations: [],
            },
          ],
        },
      },
    ]);
    const judged = await createReviewer(client).judge({ plan: null, diff, budget });
    const result = run({
      ...input,
      evidence: { items: [...(input.evidence?.items ?? []), ...judged.items] },
    });
    expect(result.computedLane).toBe(1);
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("llm.unsure");
    expect(codes).not.toContain("llm.concern");
    expect(result.reasons.find((r) => r.code === "llm.unsure")?.message).toMatch(
      /Concern downgraded to unsure: no hunk citation/,
    );
  });

  it("garbage from the judge raises a planned change to at least Lane 1 (unsure)", async () => {
    const scenario = codemodRename({ lane0Enabled: true });
    expect(run(scenario.input).computedLane).toBe(0);
    const judged = await createReviewer(new FakeLlmClient(["lgtm!!"])).judge({
      plan: scenario.input.plan,
      diff,
      budget,
    });
    const result = run({
      ...scenario.input,
      evidence: { items: [...(scenario.input.evidence?.items ?? []), ...judged.items] },
    });
    expect(result.computedLane).toBe(1);
    expect(result.reasons.filter((r) => r.code === "llm.unsure")).toHaveLength(3);
  });
});
