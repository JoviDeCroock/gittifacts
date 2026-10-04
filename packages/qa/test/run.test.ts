import { EvidenceItem } from "@app/evidence";
import { FakeLlmClient } from "@app/tour";
import { describe, expect, it } from "vitest";
import { criteriaFor, type QaRunInput, runQa } from "../src/index.js";
import { type FakeAppOptions, FakeBrowser, MemorySink } from "./fake-browser.js";

const CRITERIA = [
  "Clicking Increment raises the counter by one",
  "Typing a name greets the person",
];

function input(over: Partial<QaRunInput> = {}): QaRunInput {
  return {
    runId: "qa_t",
    trigger: "platform",
    requestedBy: "hu_1",
    origin: "https://q-c-01234567-pv.resynapse.dev",
    snapshotStep: "build",
    criteria: criteriaFor({ acceptanceCriteria: CRITERIA }),
    routes: ["/"],
    changedFiles: ["public/index.html"],
    ...over,
  };
}

const goodPlan = {
  criteria: [
    {
      index: 0,
      start: "/",
      steps: [
        { action: "click", target: "#inc" },
        { action: "expect_text", target: "#n", value: "1" },
      ],
    },
    {
      index: 1,
      start: "/",
      steps: [
        { action: "fill", target: "#who", value: "Ada" },
        { action: "expect_text", target: "#hello", value: "Hello Ada" },
      ],
    },
  ],
};
const passReview = {
  verdicts: [
    { index: 0, verdict: "pass", reason: "ok" },
    { index: 1, verdict: "pass", reason: "ok" },
  ],
};

async function go(responses: unknown[], app: FakeAppOptions = {}, over: Partial<QaRunInput> = {}) {
  const browser = new FakeBrowser(app);
  const sink = new MemorySink();
  const llm = new FakeLlmClient(
    responses.map((json) => (json instanceof Error ? json : { json })),
    { defaultCostUsd: 0.001 },
  );
  let t = 0;
  const item = await runQa(input(over), {
    browser,
    llm,
    artifacts: sink,
    now: () => (t += 50),
    metadata: { change_id: "c" },
  });
  EvidenceItem.parse(item); // the signed item's schema
  return { item, browser, sink, llm, verdicts: item.criteria.map((c) => c.verdict) };
}

describe("runQa", () => {
  it("passes criteria whose expectations held, with screenshots per step, thumbs and a replay", async () => {
    const { item, sink, llm } = await go([goodPlan, passReview]);
    expect(item.criteria.map((c) => c.verdict)).toEqual(["pass", "pass"]);
    expect(item.criteria[0]?.before).toBe("c0-before.jpg");
    expect(item.criteria[0]?.steps.map((s) => s.shot)).toEqual(["c0-s1.jpg", "c0-s2.jpg"]);
    expect([...sink.items.keys()]).toEqual(
      expect.arrayContaining(["c0-thumb.jpg", "c1-thumb.jpg", "replay.gif"]),
    );
    expect(item.usage).toMatchObject({ llmCalls: 2, llmUsd: 0.002 });
    expect(item.blockedOrigins).toEqual(["https://fonts.example"]);
    // The planner saw the page and the criteria, never anything else about the change.
    expect(llm.requests[0]?.messages[0]?.content).toContain(
      "Clicking Increment raises the counter",
    );
    expect(llm.requests[0]?.messages[0]?.content).toContain("#inc");
  });

  it("fails a criterion whose expectation doesn't hold (the app's bug), and the review can't undo it", async () => {
    const review = {
      verdicts: [
        { index: 0, verdict: "pass", reason: "looks fine" },
        { index: 1, verdict: "pass", reason: "ok" },
      ],
    };
    const { item } = await go([goodPlan, review], { bug: "no-increment" });
    expect(item.criteria[0]).toMatchObject({ verdict: "fail" });
    expect(item.criteria[0]?.reason).toContain('"1" not found');
    expect(item.criteria[1]?.verdict).toBe("pass");
  });

  it("the review may cast doubt on a pass (→ couldn't test), never make a fail on its own, never raise", async () => {
    const review = {
      verdicts: [
        { index: 0, verdict: "couldnt-test", reason: "checks the wrong element" },
        { index: 1, verdict: "fail", reason: "greeting is wrong" },
      ],
    };
    const { verdicts, item } = await go([goodPlan, review]);
    // A "fail" from the review alone is doubt, not a failure: the browser's expectations held.
    expect(verdicts).toEqual(["couldnt-test", "couldnt-test"]);
    expect(item.criteria[1]?.reason).toContain("review: greeting is wrong");
  });

  it("repairs a step whose target is missing once, then runs the new steps", async () => {
    const plan = {
      criteria: [
        {
          index: 0,
          start: "/",
          steps: [
            { action: "click", target: "#plus" },
            { action: "expect_text", target: "#n", value: "1" },
          ],
        },
      ],
    };
    const repair = {
      steps: [
        { action: "click", target: "text=Increment" },
        { action: "expect_text", target: "#n", value: "1" },
      ],
    };
    const { item } = await go(
      [plan, repair, { verdicts: [] }],
      {},
      { criteria: criteriaFor({ acceptanceCriteria: [CRITERIA[0] as string] }) },
    );
    expect(item.criteria[0]).toMatchObject({ verdict: "pass" });
    expect(item.criteria[0]?.steps.map((s) => [s.action, s.target, s.ok])).toEqual([
      ["click", "#plus", false],
      ["click", "text=Increment", true],
      ["expect_text", "#n", true],
    ]);
  });

  it("couldn't test: untestable, a missing script, no expectation, and a model that failed", async () => {
    const plan = {
      criteria: [
        { index: 0, start: "/", steps: [], untestable: "needs a login" },
        { index: 1, start: "/", steps: [{ action: "fill", target: "#who", value: "Ada" }] },
      ],
    };
    const { verdicts, item } = await go([plan, { verdicts: [] }]);
    expect(verdicts).toEqual(["couldnt-test", "couldnt-test"]);
    expect(item.criteria[0]?.reason).toContain("needs a login");
    expect(item.criteria[1]?.reason).toContain("checked nothing");
    const failed = await go([new Error("gateway 503")]);
    expect(failed.verdicts).toEqual(["couldnt-test", "couldnt-test"]);
    expect(failed.item.criteria[0]?.reason).toContain("gateway 503");
  });

  it("a page answering 500 is a fail, not a couldn't-test", async () => {
    const { item } = await go([goodPlan], { status500: true });
    // Explore can't open the app, so there is no plan; nothing passes.
    expect(item.criteria.every((c) => c.verdict !== "pass")).toBe(true);
  });

  it("stops at the time budget: the rest is couldn't test, never pass", async () => {
    const { item } = await go(
      [goodPlan, passReview],
      { costMs: 100_000 },
      { limits: { browserMs: 250 } },
    );
    expect(item.criteria.some((c) => c.reason.includes("browser budget"))).toBe(true);
    expect(item.criteria.every((c) => c.verdict !== "pass")).toBe(true);
  });

  it("criteria beyond the limit are couldn't test", async () => {
    const many = criteriaFor({ acceptanceCriteria: ["a", "b", "c"] });
    const { item } = await go(
      [{ criteria: [] }],
      {},
      { criteria: many, limits: { maxCriteria: 2 } },
    );
    expect(item.criteria).toHaveLength(3);
    expect(item.criteria[2]?.reason).toContain("limit of 2 criteria");
  });
});

describe("runQa without a Plan (smoke)", () => {
  it("passes when every route loads without uncaught errors, with no model call", async () => {
    const { item, llm } = await go([], {}, { criteria: criteriaFor(null) });
    expect(item.criteria).toMatchObject([{ source: "smoke", verdict: "pass" }]);
    expect(llm.requests).toHaveLength(0);
  });

  it("fails on an uncaught page error or a route that doesn't load", async () => {
    expect((await go([], { bug: "throws" }, { criteria: criteriaFor(null) })).verdicts).toEqual([
      "fail",
    ]);
    const missing = await go([], {}, { criteria: criteriaFor(null), routes: ["/", "/gone"] });
    expect(missing.verdicts).toEqual(["fail"]);
    expect(missing.item.criteria[0]?.reason).toContain("/gone");
  });
});
