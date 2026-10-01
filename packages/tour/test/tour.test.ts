import { Tour } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { estimateCallCostUsd } from "../src/budget.js";
import { FakeLlmClient, LlmError, type LlmRequest, type ScriptedResponse } from "../src/llm.js";
import { PROMPT_VERSION } from "../src/prompt.js";
import { createReviewer, type TourOutcome } from "../src/tour.js";
import {
  BEHAVIOR_STOP,
  breakingApiInput,
  CHANGE_ID,
  diffOf,
  FORMAT_DECL_HEAD_LINE,
  FORMAT_DECL_HUNK,
  file,
  fullChange,
  goodModelTour,
  HEAD_SHA,
  hunk,
  INTENT_STOP,
  PROOF_STOP,
  RISK_DECL_STOP,
  stop,
  UNCOVERED_STOP,
} from "./support/scenario.js";

const NOW = new Date("2026-10-01T12:34:56.000Z");
const opts = { now: () => NOW, newId: () => "tour_test_1", principalId: "reviewer-agent" };

function ok(outcome: TourOutcome): Extract<TourOutcome, { status: "ok" }> {
  if (outcome.status !== "ok") throw new Error(`expected ok, got failed: ${outcome.reason}`);
  return outcome;
}

function promptText(req: LlmRequest): string {
  return [req.system, ...req.messages.map((m) => m.content)].join("\n");
}

describe("reviewer.tour: happy path", () => {
  it("returns a schema-valid tour with provenance, cost and readability", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour(), costUsd: 0.03 }], {
      model: "anthropic/claude-sonnet-5-5",
    });
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));

    expect(Tour.safeParse(outcome.tour).success).toBe(true);
    expect(outcome.tour).toMatchObject({
      id: "tour_test_1",
      changeId: CHANGE_ID,
      headSha: HEAD_SHA,
      createdAt: NOW.toISOString(),
      generatedBy: {
        principalId: "reviewer-agent",
        model: "anthropic/claude-sonnet-5-5",
        promptVersion: PROMPT_VERSION,
        attempts: 1,
        costUsd: 0.03,
      },
    });
    expect(outcome.costUsd).toBe(0.03);
    expect(outcome.budgetExceeded).toBe(false);
    expect(outcome.tour.stops.map((s) => s.kind)).toEqual([
      "intent",
      "behavior",
      "risk",
      "proof",
      "uncovered",
    ]);
    expect(
      outcome.tour.stops.every((s) => ["proven", "unproven", "risk"].includes(s.verdict)),
    ).toBe(true);
    expect(outcome.diagnostics.postprocess?.riskStop.action).toBe("kept");
    expect(outcome.readability.estimatedReadSeconds).toBeGreaterThan(0);
  });

  it("sends one structured-output request tagged with the change id", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour() }]);
    await createReviewer(client, opts).tour(breakingApiInput());

    expect(client.requests).toHaveLength(1);
    const req = client.requests[0]!;
    expect(req.jsonSchema?.name).toBe("tour");
    expect(req.metadata).toMatchObject({
      change_id: CHANGE_ID,
      purpose: "tour",
      attempt: 1,
      prompt: PROMPT_VERSION,
    });
    expect(Object.keys(req.metadata).length).toBeLessThanOrEqual(5);
    // The model sees the plan, the evidence ids, the ranked candidates and numbered diff lines.
    const text = promptText(req);
    expect(text).toContain('id "public-api"');
    expect(text).toContain("<risk-candidates>\n1. src/format.ts head");
    expect(text).toContain(
      `+${FORMAT_DECL_HEAD_LINE} export function formatMoney(value: Money, options: FormatOptions): string {`,
    );
  });
});

describe("reviewer.tour: validation and regeneration", () => {
  it("regenerates once with the validation errors and succeeds", async () => {
    const invalid = {
      stops: [{ kind: "risk", title: "", why: "x" }],
      leastConfident: [],
      notDone: ["n"],
    };
    const client = new FakeLlmClient([{ json: invalid }, { json: goodModelTour() }]);
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));

    expect(client.requests).toHaveLength(2);
    expect(outcome.tour.generatedBy.attempts).toBe(2);
    const retry = client.requests[1]!;
    expect(retry.metadata.attempt).toBe(2);
    expect(retry.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(retry.messages[1]!.content).toBe(JSON.stringify(invalid));
    const feedback = retry.messages[2]!.content;
    expect(feedback).toContain("stops.0.title");
    expect(feedback).toContain("leastConfident");
    // The original prompt is unchanged (same prefix: cache-friendly).
    expect(retry.messages[0]!.content).toBe(client.requests[0]!.messages[0]!.content);
  });

  it("treats non-JSON text as invalid and says so in the retry", async () => {
    const client = new FakeLlmClient([
      "Sure! Here is the tour you asked for.",
      { json: goodModelTour() },
    ]);
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));
    expect(outcome.tour.generatedBy.attempts).toBe(2);
    expect(client.requests[1]!.messages[2]!.content).toContain("not a JSON object");
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const client = new FakeLlmClient([`\`\`\`json\n${JSON.stringify(goodModelTour())}\n\`\`\``]);
    ok(await createReviewer(client, opts).tour(breakingApiInput()));
    expect(client.requests).toHaveLength(1);
  });

  it("rejects a model-written transform stop (reserved for the platform)", async () => {
    const bad = goodModelTour({ stops: [stop({ kind: "transform" as never, title: "Codemod" })] });
    const client = new FakeLlmClient([{ json: bad }, { json: bad }]);
    const outcome = await createReviewer(client, opts).tour(breakingApiInput());
    expect(outcome.status).toBe("failed");
  });

  it("fails after two invalid replies so the coordinator escalates", async () => {
    const client = new FakeLlmClient([{ json: { nope: true } }, { json: { stops: [] } }]);
    const outcome = await createReviewer(client, opts).tour(breakingApiInput());

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toMatch(/invalid after 2 attempt/);
    expect(outcome.budgetExceeded).toBe(false);
    expect(outcome.costUsd).toBeCloseTo(0.02);
    expect(client.requests).toHaveLength(2);
  });

  it("retries once after a transport error", async () => {
    const client = new FakeLlmClient([
      new LlmError("http", "AI Gateway HTTP 502", 502),
      { json: goodModelTour() },
    ]);
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));
    expect(outcome.tour.generatedBy.attempts).toBe(2);
    expect(client.requests[1]!.messages).toHaveLength(1);
  });

  it("refuses inputs for a different head instead of guessing", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour() }]);
    const input = breakingApiInput();
    const outcome = await createReviewer(client, opts).tour({
      ...input,
      change: { ...input.change, headSha: "c".repeat(40) },
    });
    expect(outcome.status).toBe("failed");
    expect(client.requests).toHaveLength(0);
  });
});

describe("reviewer.tour: post-processing through the reviewer", () => {
  it("downgrades a proven stop without evidence to unproven", async () => {
    const claim = stop({
      kind: "behavior",
      title: "Code style is unchanged",
      why: "Same output as before.",
      verdict: "proven",
    });
    const client = new FakeLlmClient([
      { json: goodModelTour({ stops: [INTENT_STOP, claim, RISK_DECL_STOP] }) },
    ]);
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));

    const s = outcome.tour.stops.find((x) => x.title === "Code style is unchanged");
    expect(s?.verdict).toBe("unproven");
    expect(outcome.diagnostics.postprocess?.downgraded).toEqual([
      expect.objectContaining({ stop: "Code style is unchanged", from: "proven", to: "unproven" }),
    ]);
    expect(outcome.tour.leastConfident.join(" ")).toContain("marked unproven");
  });

  it("removes unknown evidence ids (and a proof resting only on them is unproven)", async () => {
    const claim = stop({
      kind: "proof",
      title: "Snapshot tests pass",
      evidenceRefs: ["snapshots", "red-green "],
      verdict: "proven",
    });
    const ghost = stop({
      kind: "proof",
      title: "Lint is clean",
      evidenceRefs: ["eslint"],
      verdict: "proven",
    });
    const client = new FakeLlmClient([
      { json: goodModelTour({ stops: [RISK_DECL_STOP, claim, ghost] }) },
    ]);
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));

    const snap = outcome.tour.stops.find((x) => x.title === "Snapshot tests pass")!;
    expect(snap.evidenceRefs).toEqual(["red-green"]);
    expect(snap.verdict).toBe("proven");
    const lint = outcome.tour.stops.find((x) => x.title === "Lint is clean")!;
    expect(lint.evidenceRefs).toEqual([]);
    expect(lint.verdict).toBe("unproven");
    const ids = new Set(breakingApiInput().evidence.items.map((i) => i.id));
    for (const s of outcome.tour.stops)
      for (const r of s.evidenceRefs) expect(ids.has(r)).toBe(true);
    expect(outcome.tour.leastConfident.join(" ")).toContain("snapshots, eslint");
  });

  it("drops hunkRefs outside the diff and clamps partial overlaps", async () => {
    const s = stop({
      kind: "risk",
      title: "Rounding",
      verdict: "risk",
      hunkRefs: [
        { file: "src/money.ts", startLine: 1, endLine: 3, side: "head" }, // not in the diff
        { file: "src/format.ts", startLine: 200, endLine: 210, side: "head" }, // outside every hunk
        { file: "./src/format.ts", startLine: FORMAT_DECL_HEAD_LINE, endLine: 30, side: "head" }, // clamp to hunk end
      ],
    });
    const client = new FakeLlmClient([{ json: goodModelTour({ stops: [RISK_DECL_STOP, s] }) }]);
    const outcome = ok(await createReviewer(client, opts).tour(breakingApiInput()));

    const out = outcome.tour.stops.find((x) => x.title === "Rounding")!;
    const declEnd = FORMAT_DECL_HUNK.newStart + FORMAT_DECL_HUNK.newLines - 1;
    expect(out.hunkRefs).toEqual([
      { file: "src/format.ts", startLine: FORMAT_DECL_HEAD_LINE, endLine: declEnd, side: "head" },
    ]);
    expect(outcome.diagnostics.postprocess?.droppedHunkRefs.map((d) => d.reason)).toEqual([
      "unknown-file",
      "outside-hunks",
    ]);
    expect(outcome.tour.leastConfident.join(" ")).toContain("outside the diff");
  });
});

describe("M3 acceptance: breaking-api tour leads its risks with the breaking export", () => {
  const distraction = stop({
    kind: "risk",
    title: "Large test rewrite",
    why: "The test file changed a lot.",
    hunkRefs: [{ file: "test/format.test.ts", startLine: 10, endLine: 20, side: "head" }],
    verdict: "risk",
  });

  function firstRisk(outcome: TourOutcome) {
    return ok(outcome).tour.stops.find((s) => s.kind === "risk")!;
  }

  function pointsAtDeclaration(s: {
    hunkRefs: Array<{ file: string; startLine: number; endLine: number; side: string }>;
  }) {
    return s.hunkRefs.some(
      (r) =>
        r.file === "src/format.ts" &&
        r.side === "head" &&
        r.startLine <= FORMAT_DECL_HEAD_LINE &&
        FORMAT_DECL_HEAD_LINE <= r.endLine,
    );
  }

  it("moves the model's own breaking-export stop ahead of a distraction", async () => {
    const tour = goodModelTour({
      stops: [INTENT_STOP, distraction, PROOF_STOP, RISK_DECL_STOP, UNCOVERED_STOP],
    });
    const outcome = await createReviewer(new FakeLlmClient([{ json: tour }]), opts).tour(
      breakingApiInput(),
    );

    const risk = firstRisk(outcome);
    expect(risk.title).toBe(RISK_DECL_STOP.title);
    expect(pointsAtDeclaration(risk)).toBe(true);
    expect(ok(outcome).diagnostics.postprocess?.riskStop).toMatchObject({
      action: "moved",
      reasonCode: "api.breaking",
    });
  });

  it("inserts a deterministic breaking-export stop when the model missed it", async () => {
    const tour = goodModelTour({
      stops: [distraction, INTENT_STOP, BEHAVIOR_STOP, UNCOVERED_STOP],
    });
    const outcome = await createReviewer(new FakeLlmClient([{ json: tour }]), opts).tour(
      breakingApiInput(),
    );

    const risk = firstRisk(outcome);
    expect(risk.title).toBe("Breaking export: formatMoney");
    expect(risk.verdict).toBe("risk");
    expect(risk.evidenceRefs).toEqual(["public-api"]);
    expect(pointsAtDeclaration(risk)).toBe(true);
    expect(risk.why).toContain(
      "function formatMoney(value: Money, options: FormatOptions): string",
    );
    // Order still holds: intent → behavior → risk (breaking export, then the distraction) → uncovered.
    expect(ok(outcome).tour.stops.map((s) => s.title)).toEqual([
      INTENT_STOP.title,
      BEHAVIOR_STOP.title,
      "Breaking export: formatMoney",
      distraction.title,
      UNCOVERED_STOP.title,
    ]);
    expect(ok(outcome).tour.leastConfident.join(" ")).toContain(
      "did not lead with the riskiest hunk",
    );
  });

  it("does not force a risk stop when no Lane-2 reason is anchored to the top hunk", async () => {
    const input = breakingApiInput();
    const tour = goodModelTour({ stops: [INTENT_STOP, distraction] });
    const outcome = await createReviewer(new FakeLlmClient([{ json: tour }]), opts).tour({
      ...input,
      classification: { ...input.classification, lane: 1, computedLane: 1, reasons: [] },
    });
    expect(firstRisk(outcome).title).toBe(distraction.title);
    expect(ok(outcome).diagnostics.postprocess?.riskStop.action).toBe("not-required");
  });
});

describe("reviewer.tour: budget", () => {
  it("does not call the model when spent + estimate exceeds the limit", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour() }]);
    const outcome = await createReviewer(client, opts).tour(
      breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0.45 } }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.budgetExceeded).toBe(true);
    expect(outcome.costUsd).toBe(0);
    expect(client.requests).toHaveLength(0);
    if (outcome.status === "failed") expect(outcome.reason).toMatch(/budget exceeded/);
  });

  it("refuses when the remaining budget cannot pay for the prompt itself", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour() }], {
      model: "anthropic/claude-haiku-4-5",
    });
    // Haiku output reserve is 6000 × $5/M = $0.03; leave a sliver above that.
    const outcome = await createReviewer(client, opts).tour(
      breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: 0.031, spentUsd: 0 } }),
    );
    expect(outcome).toMatchObject({ status: "failed", budgetExceeded: true });
    expect(client.requests).toHaveLength(0);
  });

  it("reports budgetExceeded when a call's actual cost overshoots, but keeps the paid-for tour", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour(), costUsd: 0.9 }], {
      model: "anthropic/claude-sonnet-5-5",
    });
    const outcome = await createReviewer(client, opts).tour(
      breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0 } }),
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.budgetExceeded).toBe(true);
    expect(outcome.costUsd).toBe(0.9);
  });

  it("stops before regenerating when the first call used up the budget", async () => {
    const client = new FakeLlmClient(
      [{ json: { junk: 1 }, costUsd: 0.45 }, { json: goodModelTour() }],
      {
        model: "anthropic/claude-sonnet-5-5",
      },
    );
    const outcome = await createReviewer(client, opts).tour(
      breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0 } }),
    );
    expect(outcome).toMatchObject({ status: "failed", budgetExceeded: true, costUsd: 0.45 });
    expect(client.requests).toHaveLength(1);
    if (outcome.status === "failed") expect(outcome.reason).toMatch(/before regenerating/);
  });

  it("treats a gateway 429 as budget exceeded", async () => {
    const client = new FakeLlmClient([
      new LlmError("budget", "AI Gateway HTTP 429: spend limit", 429),
    ]);
    const outcome = await createReviewer(client, opts).tour(breakingApiInput());
    expect(outcome).toMatchObject({ status: "failed", budgetExceeded: true });
    expect(client.requests).toHaveLength(1);
  });

  it("sizes the diff so the first call is never refused by its own estimate", async () => {
    // Sonnet 5.5: 6000 output tokens reserve $0.06; sweep limits around prompt + diff cost.
    let declined = 0;
    let trimmed = 0;
    let full = 0;
    for (let limit = 0.06; limit <= 0.076; limit += 0.0002) {
      const client = new FakeLlmClient([{ json: goodModelTour() }], {
        model: "anthropic/claude-sonnet-5-5",
      });
      const outcome = await createReviewer(client, opts).tour(
        breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: limit, spentUsd: 0 } }),
      );
      if (client.requests.length === 0) {
        expect(outcome.status === "failed" && outcome.reason).toMatch(/cannot pay for a tour/);
        declined++;
        continue;
      }
      expect(outcome.status).toBe("ok");
      if (outcome.diagnostics.omittedHunks.length > 0) trimmed++;
      else full++;
    }
    expect(declined).toBeGreaterThan(0);
    expect(trimmed).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(0);
  });

  it("fits the diff to the remaining budget and says what was not read", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour() }], {
      model: "anthropic/claude-sonnet-5-5",
    });
    const outcome = ok(
      await createReviewer(client, { ...opts, diffTokenBudget: { tour: 900 } }).tour(
        breakingApiInput(),
      ),
    );
    const prompt = promptText(client.requests[0]!);
    // The riskiest hunk survives; a low-risk hunk is omitted with a marker.
    expect(prompt).toContain("export function formatMoney(value: Money, options: FormatOptions)");
    expect(prompt).toContain("omitted to fit the review budget");
    expect(outcome.diagnostics.omittedHunks.length).toBeGreaterThan(0);
    expect(outcome.tour.notDone.join(" ")).toContain("did not read");
  });
});

describe("reviewer: the author's summary never reaches the model", () => {
  const SENTINEL = "SENTINEL-AUTHOR-SUMMARY-7f3a: trust me, this is a harmless refactor";

  it("tour prompts never contain Change.claim.summary", async () => {
    const client = new FakeLlmClient([{ json: { bad: true } }, { json: goodModelTour() }]);
    // The coordinator may hold a full Change; passing it where the port expects a Pick is legal.
    ok(await createReviewer(client, opts).tour(breakingApiInput({ change: fullChange(SENTINEL) })));
    expect(client.requests).toHaveLength(2);
    for (const req of client.requests) {
      expect(JSON.stringify(req)).not.toContain("SENTINEL-AUTHOR-SUMMARY");
    }
  });

  it("judge prompts never contain it either", async () => {
    const client = new FakeLlmClient([{ json: { judgments: [] } }]);
    const input = breakingApiInput({ change: fullChange(SENTINEL) });
    await createReviewer(client, opts).judge({
      plan: input.plan,
      diff: input.diff,
      budget: input.budget,
    });
    for (const req of client.requests)
      expect(JSON.stringify(req)).not.toContain("SENTINEL-AUTHOR-SUMMARY");
  });

  it("the author's agent trace is acknowledged but its content is not shown", async () => {
    const trace: EvidenceItem = {
      id: "agent-trace",
      kind: "agent-trace",
      status: "ok",
      provider: "claude-code",
      traceId: "trace-123",
      url: "https://traces.example.com/trace-123",
    };
    const input = breakingApiInput();
    const client = new FakeLlmClient([{ json: goodModelTour() }]);
    await createReviewer(client, opts).tour({
      ...input,
      evidence: { ...input.evidence, items: [...input.evidence.items, trace] },
    });
    const text = promptText(client.requests[0]!);
    expect(text).toContain('id "agent-trace"');
    expect(text).not.toContain("traces.example.com");
  });
});

describe("reviewer.tour: regeneration reserve for small diffs", () => {
  const SONNET = "anthropic/claude-sonnet-5";
  /** A scripted reply that costs the worst case the reviewer estimated for this request. */
  const worstCase =
    (json: unknown): ScriptedResponse =>
    (req: LlmRequest) => ({
      json,
      costUsd: estimateCallCostUsd(
        SONNET,
        req.system + req.messages.map((m) => m.content).join("\n"),
        req.maxTokens,
      ),
    });

  it("at the default $0.50, a worst-case first call still leaves room for the regeneration", async () => {
    const client = new FakeLlmClient([worstCase({ junk: true }), worstCase(goodModelTour())], {
      model: SONNET,
    });
    const outcome = await createReviewer(client, opts).tour(
      breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0.05 } }),
    );
    expect(outcome.diagnostics.regenerationReserved).toBe(true);
    expect(outcome.diagnostics.omittedHunks).toEqual([]);
    expect(client.requests).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "ok", budgetExceeded: false });
    expect(outcome.costUsd).toBeLessThan(0.45);
  });

  it("whenever a regeneration was reserved it is never refused, even at worst-case cost", async () => {
    let reserved = 0;
    let trimmedToReserve = 0;
    let notReserved = 0;
    for (let limit = 0.06; limit <= 0.2; limit += 0.002) {
      const client = new FakeLlmClient([worstCase({ junk: true }), worstCase(goodModelTour())], {
        model: SONNET,
      });
      const outcome = await createReviewer(client, opts).tour(
        breakingApiInput({ budget: { changeId: CHANGE_ID, limitUsd: limit, spentUsd: 0 } }),
      );
      if (!outcome.diagnostics.regenerationReserved) {
        notReserved++;
        continue;
      }
      reserved++;
      if (outcome.diagnostics.omittedHunks.length > 0) trimmedToReserve++;
      expect(client.requests).toHaveLength(2);
      expect(outcome.status).toBe("ok");
      expect(outcome.budgetExceeded).toBe(false);
    }
    expect(reserved).toBeGreaterThan(0);
    expect(trimmedToReserve).toBeGreaterThan(0);
    expect(notReserved).toBeGreaterThan(0);
  });

  it("does not reserve for large diffs (keeps the whole-budget fit)", async () => {
    const big = diffOf([
      file("src/big.ts", [
        hunk(
          1,
          1,
          Array.from(
            { length: 1200 },
            (_, i) =>
              ["+", `export const value${i} = computeSomething(${i}, "padding text");`] as [
                "+",
                string,
              ],
          ),
        ),
      ]),
    ]);
    const client = new FakeLlmClient([{ json: goodModelTour({ stops: [INTENT_STOP] }) }], {
      model: SONNET,
    });
    const outcome = await createReviewer(client, opts).tour(
      breakingApiInput({ diff: big, budget: { changeId: CHANGE_ID, limitUsd: 0.5, spentUsd: 0 } }),
    );
    expect(outcome.diagnostics.regenerationReserved).toBe(false);
    expect(outcome.status).toBe("ok");
  });
});
