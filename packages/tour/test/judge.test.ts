import { type EvidenceItem, LlmJudgment } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { judgmentId, parseJudgments } from "../src/judge.js";
import { judgeFactsFrom } from "../src/judge-facts.js";
import { FakeLlmClient, LlmError } from "../src/llm.js";
import { JUDGE_PROMPT_VERSION } from "../src/prompt.js";
import { createReviewer } from "../src/tour.js";
import { breakingApiDiff, CHANGE_ID, diffOf, file, hunk, plan } from "./support/scenario.js";

const budget = { changeId: CHANGE_ID, limitUsd: 5, spentUsd: 0 };

function judge(client: FakeLlmClient, withPlan = true) {
  return createReviewer(client).judge({
    plan: withPlan ? plan() : null,
    diff: breakingApiDiff(),
    budget,
  });
}

function byQuestion(items: LlmJudgment[]) {
  return Object.fromEntries(items.map((i) => [i.question, i]));
}

describe("reviewer.judge", () => {
  it("returns one valid llm-judgment item per question", async () => {
    const client = new FakeLlmClient(
      [
        {
          json: {
            judgments: [
              {
                question: "scope-drift",
                outcome: "no-concern",
                rationale: "All four files are in scopePaths.",
                citations: [],
              },
              {
                question: "plan-conformance",
                outcome: "no-concern",
                rationale: "Both styles and README are done.",
                citations: [],
              },
              {
                question: "hidden-behavior-change",
                outcome: "concern",
                rationale: "src/format.ts:13 makes options required.",
                citations: [
                  {
                    file: "src/format.ts",
                    hunk: 1,
                    behavior: "Drops the zero-digit early return.",
                    planBasis: "not-in-plan",
                    planQuote: null,
                  },
                ],
              },
            ],
          },
          costUsd: 0.02,
        },
      ],
      { model: "anthropic/claude-sonnet-5-5" },
    );
    const result = await judge(client);

    expect(result.items).toHaveLength(3);
    for (const item of result.items) expect(LlmJudgment.safeParse(item).success).toBe(true);
    const q = byQuestion(result.items);
    expect(q["scope-drift"]).toMatchObject({
      id: judgmentId("scope-drift"),
      status: "ok",
      outcome: "no-concern",
    });
    expect(q["hidden-behavior-change"]).toMatchObject({
      outcome: "concern",
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(result).toMatchObject({ costUsd: 0.02, budgetExceeded: false });
    const req = client.requests[0]!;
    expect(req.jsonSchema?.name).toBe("judgments");
    expect(req.metadata).toMatchObject({
      change_id: CHANGE_ID,
      purpose: "judge",
      prompt: JUDGE_PROMPT_VERSION,
    });
    expect(req.messages[0]!.content).toContain("Questions (answer each exactly once)");
  });

  it("turns garbage into unsure for every question (never no-concern)", async () => {
    const result = await judge(new FakeLlmClient(["I think it looks fine overall!"]));
    expect(result.items.map((i) => [i.question, i.outcome, i.status])).toEqual([
      ["scope-drift", "unsure", "ok"],
      ["plan-conformance", "unsure", "ok"],
      ["hidden-behavior-change", "unsure", "ok"],
    ]);
    expect(result.items[0]!.rationale).toMatch(/not parseable/);
  });

  it("keeps valid answers, marks missing or malformed ones unsure, and takes the most severe duplicate", async () => {
    const result = await judge(
      new FakeLlmClient([
        {
          json: {
            judgments: [
              { question: "scope-drift", outcome: "no-concern", rationale: "fine" },
              {
                question: "scope-drift",
                outcome: "concern",
                rationale: "README rewrite goes beyond the examples.",
                citations: [
                  {
                    file: "README.md",
                    hunk: 1,
                    behavior: "Rewrites the whole README.",
                    planBasis: "goes-beyond",
                    planQuote: "README examples use the new signature",
                  },
                ],
              },
              { question: "plan-conformance", outcome: "maybe", rationale: "?" },
              { question: "made-up", outcome: "concern", rationale: "x" },
            ],
          },
        },
      ]),
    );
    const q = byQuestion(result.items);
    expect(q["scope-drift"]).toMatchObject({
      outcome: "concern",
      rationale: expect.stringMatching(
        /^README rewrite goes beyond the examples\. Cited: README\.md hunk 1/,
      ),
    });
    expect(q["plan-conformance"]).toMatchObject({ outcome: "unsure" });
    expect(q["hidden-behavior-change"]).toMatchObject({ outcome: "unsure" });
  });

  it("without a plan, asks only about hidden behavior and reports the plan questions as skipped", async () => {
    const client = new FakeLlmClient([
      {
        json: {
          judgments: [
            {
              question: "hidden-behavior-change",
              outcome: "no-concern",
              rationale: "Pure formatting.",
            },
          ],
        },
      },
    ]);
    const result = await judge(client, false);
    const q = byQuestion(result.items);
    // Skipped (ignored by the classifier), so a verified planless change can still reach Lane 0.
    expect(q["scope-drift"]).toMatchObject({
      status: "skipped",
      note: expect.stringMatching(/^Skipped because this change has no plan to compare it with\. /),
    });
    // Written for the reviewer reading the evidence page (UX review 2026-10-02, open item 5).
    expect(q["scope-drift"]?.note).not.toMatch(/not applicable|classifier/);
    expect(q["plan-conformance"]?.note).toBe(q["scope-drift"]?.note);
    expect(q["plan-conformance"]).toMatchObject({ status: "skipped" });
    expect(q["hidden-behavior-change"]).toMatchObject({ status: "ok", outcome: "no-concern" });
    const prompt = client.requests[0]!.messages[0]!.content;
    expect(prompt).toContain("No plan is attached");
    expect(prompt).not.toContain("scope-drift:");
  });

  it("reports budget exceeded explicitly instead of skipping silently", async () => {
    const client = new FakeLlmClient([{ json: { judgments: [] } }]);
    const result = await createReviewer(client).judge({
      plan: plan(),
      diff: breakingApiDiff(),
      budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0.5 },
    });
    expect(client.requests).toHaveLength(0);
    expect(result.budgetExceeded).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((i) => i.status === "error" && i.outcome === "unsure")).toBe(true);
    expect(result.items[0]!.note).toMatch(/budget exceeded/);
  });

  it("marks items errored when the call fails, and a 429 as budget exceeded", async () => {
    const failed = await judge(new FakeLlmClient([new LlmError("network", "socket hang up")]));
    expect(failed.budgetExceeded).toBe(false);
    expect(failed.items.every((i) => i.status === "error" && i.outcome === "unsure")).toBe(true);

    const limited = await judge(new FakeLlmClient([new LlmError("budget", "HTTP 429", 429)]));
    expect(limited.budgetExceeded).toBe(true);
  });

  it("shows verified-transform output after the hand-written hunks, labelled as reference", async () => {
    const client = new FakeLlmClient([{ json: { judgments: [] } }]);
    const diff = diffOf([
      file(
        "src/gen.ts",
        [
          hunk(1, 1, [
            ["-", "old GENERATED"],
            ["+", "new GENERATED"],
          ]),
        ],
        { transformVerified: true },
      ),
      file("src/real.ts", [hunk(1, 1, [["+", "export const real = 1;"]])]),
    ]);
    await createReviewer(client).judge({ plan: plan(), diff, budget });
    const prompt = client.requests[0]!.messages[0]!.content;
    // Hand-written hunks first; the transform's output after them, labelled, as reference.
    expect(prompt).toContain("export const real = 1;");
    expect(prompt).toContain("reproduced byte-for-byte by a verified transform");
    expect(prompt).toContain("cannot be cited");
    expect(prompt.indexOf("export const real = 1;")).toBeLessThan(prompt.indexOf("GENERATED"));
  });
});

describe("reviewer.judge with the platform's verified facts", () => {
  const twoFiles = () =>
    diffOf([
      file("src/gen.ts", [
        hunk(1, 1, [
          ["-", "old GENERATED"],
          ["+", "new GENERATED"],
        ]),
      ]),
      file("src/real.ts", [hunk(1, 1, [["+", "export const real = 1;"]])]),
    ]);

  it("hides the files a verified transform reproduced and states both facts", async () => {
    const client = new FakeLlmClient([{ json: { judgments: [] } }]);
    await createReviewer(client).judge({
      plan: plan(),
      diff: twoFiles(),
      budget,
      facts: {
        transforms: [
          {
            name: "gen.mjs",
            command: "node .platform/transforms/gen.mjs",
            files: ["./src/gen.ts"],
          },
        ],
        publicApi: "none",
      },
    });
    const prompt = client.requests[0]!.messages[0]!.content;
    expect(prompt).toContain("export const real = 1;");
    expect(prompt).toContain("they are not hand-written hunks and cannot be cited");
    expect(prompt).toContain("<verified>");
    expect(prompt).toMatch(
      /Transform gen\.mjs .* reproduced these head files byte for byte: \.\/src\/gen\.ts/,
    );
    expect(prompt).toContain("the public API is unchanged");
    expect(prompt).toContain("not the author's claims");
  });

  it("without facts (or with none) the prompt is the one it always was", async () => {
    const a = new FakeLlmClient([{ json: { judgments: [] } }]);
    const b = new FakeLlmClient([{ json: { judgments: [] } }]);
    await createReviewer(a).judge({ plan: plan(), diff: twoFiles(), budget });
    await createReviewer(b).judge({
      plan: plan(),
      diff: twoFiles(),
      budget,
      facts: { transforms: [], publicApi: null },
    });
    const pa = a.requests[0]!.messages[0]!.content;
    expect(pa).not.toContain("<verified>");
    expect(pa).toContain("GENERATED");
    expect(b.requests[0]!.messages[0]!.content).toBe(pa);
  });

  it("a transform output that doesn't fit whole is listed by path only", async () => {
    const client = new FakeLlmClient([{ json: { judgments: [] } }]);
    const big = Array.from(
      { length: 400 },
      (_, i) => ["+", `export const GENERATED_${i} = ${i};`] as ["+", string],
    );
    const diff = diffOf([
      file("src/gen.ts", [hunk(1, 1, big)]),
      file("src/real.ts", [hunk(1, 1, [["+", "export const real = 1;"]])]),
    ]);
    await createReviewer(client, { diffTokenBudget: { judge: 600 } }).judge({
      plan: plan(),
      diff,
      budget,
      facts: {
        transforms: [{ name: "gen", command: "node gen.mjs", files: ["src/gen.ts"] }],
        publicApi: null,
      },
    });
    const prompt = client.requests[0]!.messages[0]!.content;
    expect(prompt).not.toContain("GENERATED_");
    expect(prompt).toContain(
      "reproduced byte-for-byte by a verified transform are not shown: src/gen.ts",
    );
  });

  it("a concern citing only the transform's output is not a concern (it becomes unsure)", async () => {
    const client = new FakeLlmClient([
      {
        json: {
          judgments: [
            {
              question: "hidden-behavior-change",
              outcome: "concern",
              rationale: "gen.ts changes a constant.",
              citations: [
                {
                  file: "src/gen.ts",
                  hunk: 1,
                  behavior: "changes a constant",
                  planBasis: "not-in-plan",
                  planQuote: null,
                },
              ],
            },
          ],
        },
      },
    ]);
    const out = await createReviewer(client).judge({
      plan: plan(),
      diff: twoFiles(),
      budget,
      facts: {
        transforms: [{ name: "gen", command: "node gen.mjs", files: ["src/gen.ts"] }],
        publicApi: null,
      },
    });
    expect(out.items.find((i) => i.question === "hidden-behavior-change")?.outcome).toBe("unsure");
  });

  it("a renamed file is hidden only when the transform also names its old path", async () => {
    const client = new FakeLlmClient([{ json: { judgments: [] } }]);
    const diff = diffOf([
      file("src/new.ts", [hunk(1, 1, [["+", "RENAMED BODY"]])], { previousPath: "src/old.ts" }),
    ]);
    await createReviewer(client).judge({
      plan: plan(),
      diff,
      budget,
      facts: {
        transforms: [{ name: "t", command: "node t.mjs", files: ["src/new.ts"] }],
        publicApi: null,
      },
    });
    expect(client.requests[0]!.messages[0]!.content).toContain("RENAMED BODY");
  });
});

describe("judgeFactsFrom (signed evidence → facts)", () => {
  const base = {
    status: "ok" as const,
    producer: "test",
    producerVersion: "1",
    subject: { sha: "b".repeat(40) },
  };
  it("keeps only verified, fully matching transforms and an ok public-API diff", () => {
    const items = [
      {
        ...base,
        id: "transform:a",
        kind: "transform",
        transform: "a",
        command: "node a",
        verified: true,
        files: ["src/a.ts"],
        mismatchedFiles: [],
      },
      {
        ...base,
        id: "transform:b",
        kind: "transform",
        transform: "b",
        command: "node b",
        verified: false,
        files: ["src/b.ts"],
        mismatchedFiles: [],
      },
      {
        ...base,
        id: "transform:c",
        kind: "transform",
        transform: "c",
        command: "node c",
        verified: true,
        files: ["src/c.ts"],
        mismatchedFiles: ["src/c.ts"],
      },
      { ...base, id: "public-api", kind: "public-api", classification: "none", packages: [] },
    ] as unknown as EvidenceItem[];
    expect(judgeFactsFrom(items)).toEqual({
      transforms: [{ name: "a", command: "node a", files: ["src/a.ts"] }],
      publicApi: "none",
    });
    const errored = items.map((i) => ({ ...i, status: "error" })) as unknown as EvidenceItem[];
    expect(judgeFactsFrom(errored)).toEqual({ transforms: [], publicApi: null });
  });
});

describe("parseJudgments", () => {
  it("accepts a bare array too", () => {
    const out = parseJudgments(
      { text: JSON.stringify([{ question: "scope-drift", outcome: "concern", rationale: "x" }]) },
      ["scope-drift"],
    );
    expect(out.get("scope-drift")?.outcome).toBe("concern");
  });
});

describe("parseJudgments with citations", () => {
  it("reads unreadable citations as none, keeping the outcome", () => {
    const out = parseJudgments(
      {
        json: {
          judgments: [
            { question: "scope-drift", outcome: "no-concern", rationale: "x", citations: null },
            {
              question: "plan-conformance",
              outcome: "concern",
              rationale: "y",
              citations: "hunk 2",
            },
          ],
        },
        text: "",
      },
      ["scope-drift", "plan-conformance"],
    );
    expect(out.get("scope-drift")).toEqual({
      outcome: "no-concern",
      rationale: "x",
      citations: [],
    });
    expect(out.get("plan-conformance")).toEqual({
      outcome: "concern",
      rationale: "y",
      citations: [],
    });
  });

  it("pools the citations of a repeated concern", () => {
    const c = (hunk: number) => ({ file: "a.ts", hunk, planBasis: "not-in-plan", planQuote: null });
    const out = parseJudgments(
      {
        json: [
          { question: "scope-drift", outcome: "concern", rationale: "first", citations: [c(1)] },
          { question: "scope-drift", outcome: "concern", rationale: "second", citations: [c(2)] },
        ],
        text: "",
      },
      ["scope-drift"],
    );
    expect(out.get("scope-drift")).toEqual({
      outcome: "concern",
      rationale: "first",
      citations: [c(1), c(2)],
    });
  });
});
