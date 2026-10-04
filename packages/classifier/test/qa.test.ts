import { EvidenceItem, type QaRun, type QaVerdict } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { raiseForQa } from "../src/index.js";
import { codes, gateOf, green, mutate, policy, raisedCodes, run, withItems } from "./helpers.js";

function qa(verdicts: QaVerdict[], over: Partial<QaRun> = {}): QaRun {
  return EvidenceItem.parse({
    id: "qa-run",
    kind: "qa-run",
    status: "ok",
    runId: "qa_1",
    trigger: "platform",
    requestedBy: "hu_1",
    app: {
      source: "private-preview",
      snapshotStep: "build",
      origin: "https://q-c-01234567-pv.resynapse.dev",
    },
    model: "m",
    promptVersion: "qa/1",
    criteria: verdicts.map((verdict, index) => ({
      index,
      text: `criterion ${index}`,
      source: "plan",
      verdict,
      reason: "r",
      steps: [],
      consoleErrors: 0,
      networkErrors: 0,
    })),
    artifacts: [],
    blockedOrigins: [],
    usage: { wallMs: 1, browserMs: 1, llmCalls: 1, inputTokens: 1, outputTokens: 1, llmUsd: 0 },
    ...over,
  }) as QaRun;
}

const lane0 = () =>
  mutate(green(), (d) => {
    d.policy = policy({ lane0Enabled: true });
  });

describe("qa-run in classify", () => {
  it("absent: QA was not requested, nothing raised, the gate passes", () => {
    const r = run(lane0());
    expect(r.lane).toBe(0);
    expect(codes(r).some((c) => c.startsWith("qa."))).toBe(false);
    expect(gateOf(r, "qa")).toMatchObject({
      passed: true,
      detail: "QA was not requested (optional).",
    });
  });

  it("all pass: qa.passed at Lane 0 and the lane stays 0 (never lowers, never raises)", () => {
    const r = run(withItems(lane0(), qa(["pass", "pass"])));
    expect(r.lane).toBe(0);
    expect(codes(r)).toContain("qa.passed");
  });

  it("a failed criterion → Lane 2; couldn't test → Lane 1; errored → Lane 1", () => {
    expect(run(withItems(lane0(), qa(["pass", "fail"]))).lane).toBe(2);
    expect(raisedCodes(run(withItems(lane0(), qa(["pass", "couldnt-test"]))))).toEqual([
      "qa.couldnt-test",
    ]);
    expect(run(withItems(lane0(), qa([])))).toMatchObject({ lane: 1 });
    const errored = run(
      withItems(lane0(), qa([], { status: "error", note: "Browser Run answered 503" })),
    );
    expect(raisedCodes(errored)).toEqual(["signal.error.qa"]);
    expect(gateOf(errored, "qa").passed).toBeNull();
  });
});

describe("raiseForQa", () => {
  it("raises a stored Lane 0 classification on failure and marks the qa gate failed", () => {
    const before = run(lane0());
    const after = raiseForQa(before, qa(["fail"]));
    expect(after).toMatchObject({ lane: 2, computedLane: 2 });
    expect(after.reasons.find((r) => r.code === "qa.failed")?.message).toContain('"criterion 0"');
    expect(gateOf(after, "qa").passed).toBe(false);
  });

  it("never lowers: a pass on a Lane 2 change keeps Lane 2, and a later pass keeps an earlier failure", () => {
    const lane2 = raiseForQa(run(lane0()), qa(["fail"]));
    const again = raiseForQa(lane2, qa(["pass"]));
    expect(again.lane).toBe(2);
    expect(again.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(["qa.failed", "qa.passed"]),
    );
  });

  it("ends shadow mode when it raises the computed lane, and leaves it when everything passed", () => {
    const shadowed = run(
      mutate(green(), (d) => {
        d.policy = policy({ lane0Enabled: false });
      }),
    ); // computed 0, routed 1
    expect(shadowed.shadow).toBe(true);
    expect(raiseForQa(shadowed, qa(["pass"]))).toMatchObject({ lane: 1, shadow: true });
    const raised = raiseForQa(shadowed, qa(["couldnt-test"]));
    expect(raised).toMatchObject({ lane: 1, computedLane: 1, shadow: false });
    expect(raised.reasons.some((r) => r.code === "shadow.lane0-disabled")).toBe(false);
  });

  it("adds the qa gate to a classification stored before the gate existed", () => {
    const old = run(lane0());
    const legacy = { ...old, checklist: old.checklist.filter((e) => e.gate !== "qa") };
    expect(raiseForQa(legacy, qa(["pass"])).checklist.filter((e) => e.gate === "qa")).toHaveLength(
      1,
    );
  });
});
