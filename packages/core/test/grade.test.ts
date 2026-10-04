import { SCENARIOS, type ScenarioName } from "@app/classifier/test/scenarios";
import { describe, expect, it } from "vitest";
import { gradeChange, memoryGradeDeps } from "../src/index.js";
import { gradeSetup, reviewer } from "./support.js";

const NAMES = Object.keys(SCENARIOS) as ScenarioName[];

describe("gradeChange reproduces the classifier scenarios", () => {
  for (const name of NAMES) {
    it(name, async () => {
      const s = SCENARIOS[name]();
      const { input, opts } = gradeSetup(s);
      const { deps, state } = memoryGradeDeps(opts);
      const out = await gradeChange(input, deps);
      if (out.status !== "graded") throw new Error("not graded");
      expect(out.verdict).toMatchObject({
        lane: s.expected.lane,
        computedLane: s.expected.computedLane,
        shadow: s.expected.shadow,
        blocked: s.expected.blocked,
        requiresHumanApproval: s.expected.requiresHumanApproval,
        preliminary: false,
      });
      const final = state.verdicts.at(-1);
      const codes = final?.reasons.map((r) => r.code) ?? [];
      for (const code of s.expected.includes) expect(codes).toContain(code);
      for (const code of s.expected.excludes) expect(codes).not.toContain(code);
      // A tour for every lane >= 1 (and shadowed Lane 0): the verdict is published twice.
      expect(state.tours).toHaveLength(out.verdict.lane >= 1 ? 1 : 0);
      expect(state.verdicts[0]?.preliminary).toBe(out.verdict.lane >= 1);
    });
  }
});

describe("gradeChange stages", () => {
  it("runs the stages the native workflow replays, in order", async () => {
    const { input, opts } = gradeSetup(SCENARIOS["pure-bugfix-with-regression-test"]());
    const { deps, state } = memoryGradeDeps({
      ...opts,
      hooks: { publishEvidence: async () => {} },
    });
    await gradeChange(input, deps);
    expect(state.stages).toEqual([
      "evidence",
      "judge",
      "evidence-note",
      "classify",
      "tour",
      "reclassify",
    ]);
  });

  it("Lane 0 on a host that cannot merge is label-ready, and the verdict says why", async () => {
    const s = SCENARIOS["pure-bugfix-with-regression-test"]({ lane0Enabled: true });
    const caps = { ...gradeSetup(s).input.capabilities, canMerge: false, supportsNotes: false };
    const { input, opts } = gradeSetup(s, { capabilities: caps });
    const { deps, state } = memoryGradeDeps(opts);
    const out = await gradeChange(input, deps);
    if (out.status !== "graded") throw new Error("not graded");
    expect(out.verdict.lane).toBe(0);
    expect(out.verdict.action).toBe("label-ready");
    expect(out.verdict.degradations.map((d) => d.capability)).toEqual([
      "canMerge",
      "supportsNotes",
    ]);
    expect(state.verdicts.at(-1)?.degradations).toHaveLength(2);
    expect(state.stages).not.toContain("evidence-note");
  });

  it("Lane 0 merges natively; without auto-merge it asks for a review", async () => {
    const s = SCENARIOS["pure-bugfix-with-regression-test"]({ lane0Enabled: true });
    for (const [allowed, action] of [
      [true, "merge"],
      [false, "request-review"],
    ] as const) {
      const { input, opts } = gradeSetup(s, { autoMergeAllowed: allowed });
      const out = await gradeChange(input, memoryGradeDeps(opts).deps);
      expect(out.status === "graded" && out.verdict.action).toBe(action);
    }
  });

  it("a failed judge is an errored signal (unknown → escalate), never a pass", async () => {
    const s = SCENARIOS["pure-bugfix-with-regression-test"]({ lane0Enabled: true });
    const { input, opts } = gradeSetup(s);
    const { deps, state } = memoryGradeDeps({
      ...opts,
      reviewer: reviewer({ judgeError: new Error("model down") }),
    });
    const out = await gradeChange(input, deps);
    expect(state.stages).toContain("judge-failed");
    expect(state.evidence?.items.some((i) => i.kind === "llm-judgment" && i.status === "error"));
    expect(out.status === "graded" && out.verdict.lane).toBeGreaterThan(0);
  });

  it("the judge gets the signed evidence's facts: the verified transform and the public-API diff", async () => {
    const s = SCENARIOS["codemod-rename"]({ lane0Enabled: true });
    const { input, opts } = gradeSetup(s);
    const r = reviewer();
    const { deps } = memoryGradeDeps({ ...opts, reviewer: r });
    await gradeChange(input, deps);
    const facts = r.judged[0]?.facts;
    expect(facts?.transforms.map((t) => t.files.length > 0)).toEqual([true]);
    expect(facts?.publicApi).toBe("none");
  });

  it("a failed tour reclassifies to Lane 2", async () => {
    const { input, opts } = gradeSetup(SCENARIOS["breaking-api"]());
    const { deps } = memoryGradeDeps({ ...opts, reviewer: reviewer({ tour: "failed" }) });
    const out = await gradeChange(input, deps);
    expect(out.status === "graded" && out.verdict).toMatchObject({ lane: 2, tourStatus: "failed" });
  });

  it("a host step can stop grading after the evidence is sealed", async () => {
    const { input, opts } = gradeSetup(SCENARIOS["new-dependency"]());
    const { deps, state } = memoryGradeDeps({
      ...opts,
      hooks: { afterEvidence: async () => ({ stop: true }) },
    });
    const out = await gradeChange(input, deps);
    expect(out.status).toBe("stopped");
    expect(state.verdicts).toHaveLength(0);
    expect(state.stages).toEqual(["evidence"]);
  });
});
