import type { TourStop } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm.js";
import {
  canProve,
  capsForLane,
  collapseTransforms,
  estimateReadSeconds,
  orderStops,
  postprocessTour,
  READING_WPM,
  SECONDS_PER_STOP,
  tourWords,
} from "../src/postprocess.js";
import { rankHunks } from "../src/rank.js";
import type { ModelTour } from "../src/schema.js";
import { createReviewer } from "../src/tour.js";
import {
  BASE_SHA,
  breakingApiDiff,
  breakingApiEvidence,
  breakingApiInput,
  CHANGE_ID,
  classification,
  diffOf,
  file,
  goodModelTour,
  HEAD_SHA,
  hunk,
  INTENT_STOP,
  plan,
  RISK_DECL_STOP,
  signed,
  stop,
} from "./support/scenario.js";

function words(n: number, word = "word"): string {
  return Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");
}

// ---------------------------------------------------------------- transform collapse

const RENAMED = ["src/a.ts", "src/b.ts", "src/c.ts"];

function codemodInput() {
  const renamed = RENAMED.map((path) =>
    file(path, [
      hunk(3, 3, [
        [" ", "// unchanged context"],
        ["-", `import { oldName } from "./lib.js"; // ${path}`],
        ["+", `import { newName } from "./lib.js"; // CODEMOD-LINE ${path}`],
      ]),
    ]),
  );
  const feature = file("src/feature.ts", [
    hunk(10, 10, [
      [" ", "export function feature() {"],
      ["+", "  return newName(42);"],
      [" ", "}"],
    ]),
  ]);
  const diff = diffOf([...renamed, feature]);
  const transform: EvidenceItem = {
    id: "transform:rename",
    kind: "transform",
    status: "ok",
    transform: "rename-oldName",
    command: "node .platform/transforms/rename.mjs oldName newName",
    verified: true,
    files: RENAMED,
    mismatchedFiles: [],
  };
  const input = breakingApiInput({
    diff,
    evidence: signed([transform]),
    classification: classification(1, [{ code: "size.transform-excluded", lane: 0, message: "excluded" }]),
    plan: plan({ scopePaths: [] }),
  });
  return { input, transform };
}

describe("transform collapse", () => {
  it("collapses verified-transform files into one deterministic stop", () => {
    const { input } = codemodInput();
    const collapse = collapseTransforms(input.diff, input.evidence.items);
    expect([...collapse.paths]).toEqual(RENAMED);
    expect(collapse.stop).toMatchObject({ kind: "transform", verdict: "proven", evidenceRefs: ["transform:rename"] });
    expect(collapse.stop?.hunkRefs.map((r) => r.file)).toEqual(RENAMED);
    expect(collapse.stop?.title).toBe("Mechanical: rename-oldName reproduced 3 file(s)");
  });

  it("removes collapsed hunks from the model input and adds exactly one transform stop", async () => {
    const { input } = codemodInput();
    const tour: ModelTour = goodModelTour({
      stops: [
        stop({ kind: "intent", title: "Feature uses the new name", hunkRefs: [{ file: "src/feature.ts", startLine: 11, endLine: 11, side: "head" }] }),
      ],
    });
    const client = new FakeLlmClient([{ json: tour }]);
    const outcome = await createReviewer(client).tour(input);
    if (outcome.status !== "ok") throw new Error(outcome.reason);

    const prompt = client.requests[0]!.messages[0]!.content;
    expect(prompt).not.toContain("CODEMOD-LINE");
    expect(prompt).toContain("return newName(42);");
    expect(prompt).toContain("3 file(s) were reproduced byte-for-byte");
    const transforms = outcome.tour.stops.filter((s) => s.kind === "transform");
    expect(transforms).toHaveLength(1);
    expect(outcome.tour.stops.map((s) => s.kind)).toEqual(["intent", "transform"]);
    expect(outcome.diagnostics.collapsedFiles).toEqual(RENAMED);
  });

  it("does not collapse unverified or mismatched transforms", () => {
    const { input, transform } = codemodInput();
    const mismatched = { ...transform, mismatchedFiles: ["src/b.ts"] } as EvidenceItem;
    expect(collapseTransforms(input.diff, [mismatched]).stop).toBeNull();
    const unverified = { ...transform, verified: false } as EvidenceItem;
    expect(collapseTransforms(input.diff, [unverified]).stop).toBeNull();
    const errored = { ...transform, status: "error" } as EvidenceItem;
    expect(collapseTransforms(input.diff, [errored]).stop).toBeNull();
  });
});

// ---------------------------------------------------------------- caps & read time

describe("word and stop caps", () => {
  it("keeps a lane-1 tour within 450 words and 7 stops, and says what it dropped", async () => {
    const long = (i: number, kind: ModelTour["stops"][number]["kind"]) =>
      stop({ kind, title: `Stop ${i} ${kind}`, why: words(150, `w${i}_`), verdict: "unproven" });
    const tour: ModelTour = {
      stops: [
        long(1, "intent"),
        long(2, "behavior"),
        long(3, "risk"),
        long(4, "proof"),
        long(5, "risk"),
        long(6, "proof"),
        long(7, "other"),
        long(8, "other"),
        long(9, "uncovered"),
        long(10, "behavior"),
      ],
      leastConfident: [words(80, "lc"), words(80, "lc2"), words(80, "lc3"), words(80, "lc4")],
      notDone: [words(80, "nd")],
    };
    const input = breakingApiInput({ classification: classification(1) });
    const outcome = await createReviewer(new FakeLlmClient([{ json: tour }])).tour(input);
    if (outcome.status !== "ok") throw new Error(outcome.reason);

    const { stops, leastConfident, notDone } = outcome.tour;
    expect(stops.length).toBeLessThanOrEqual(7);
    expect(tourWords(stops, leastConfident, notDone)).toBeLessThanOrEqual(450);
    expect(outcome.readability.words).toBe(tourWords(stops, leastConfident, notDone));
    expect(outcome.readability.estimatedReadSeconds).toBeLessThan(180);
    expect(outcome.readability.withinPhoneTarget).toBe(true);
    // Must-keep stops survive: the first intent, the first risk, the first uncovered.
    expect(stops.map((s) => s.title)).toEqual(
      expect.arrayContaining(["Stop 1 intent", "Stop 3 risk", "Stop 9 uncovered"]),
    );
    expect(notDone.join(" ")).toContain("Omitted for length");
    expect(leastConfident.length).toBeLessThanOrEqual(3);
    expect(outcome.diagnostics.postprocess?.shortenedStops.length).toBeGreaterThan(0);
    expect(stops.find((s) => s.title === "Stop 1 intent")?.why).toMatch(/…$/);
  });

  it("gives lane 2 more room (900 words, 12 stops)", () => {
    expect(capsForLane(2)).toEqual({ lane: 2, maxStops: 12, maxWords: 900 });
    expect(capsForLane(1)).toEqual({ lane: 1, maxStops: 7, maxWords: 450 });
    expect(capsForLane(0)).toEqual({ lane: 0, maxStops: 7, maxWords: 450 });
  });

  it("leaves a tour that already fits untouched", async () => {
    const outcome = await createReviewer(new FakeLlmClient([{ json: goodModelTour() }])).tour(breakingApiInput());
    if (outcome.status !== "ok") throw new Error(outcome.reason);
    expect(outcome.diagnostics.postprocess?.shortenedStops).toEqual([]);
    expect(outcome.tour.stops.map((s) => s.why)).toEqual(goodModelTour().stops.map((s) => s.why));
  });
});

describe("estimatedReadSeconds", () => {
  it("is words at 180 wpm plus 3 seconds per stop, rounded up", () => {
    expect(READING_WPM).toBe(180);
    expect(SECONDS_PER_STOP).toBe(3);
    expect(estimateReadSeconds(180, 0)).toBe(60);
    expect(estimateReadSeconds(450, 7)).toBe(171);
    expect(estimateReadSeconds(1, 1)).toBe(4);
  });

  it("is reported on the outcome and matches the final tour", async () => {
    const outcome = await createReviewer(new FakeLlmClient([{ json: goodModelTour() }])).tour(breakingApiInput());
    if (outcome.status !== "ok") throw new Error(outcome.reason);
    const { stops, leastConfident, notDone } = outcome.tour;
    const w = tourWords(stops, leastConfident, notDone);
    expect(outcome.readability).toMatchObject({
      words: w,
      stops: stops.length,
      estimatedReadSeconds: Math.ceil((w / 180) * 60 + stops.length * 3),
    });
  });
});

// ---------------------------------------------------------------- ordering & proof rules

describe("ordering", () => {
  it("orders intent → behavior → risk/proof → other → transform → uncovered", () => {
    const k = (kind: TourStop["kind"], title: string = kind): TourStop => ({
      kind,
      title,
      why: "w",
      hunkRefs: [],
      evidenceRefs: [],
      verdict: "unproven",
    });
    const ordered = orderStops([
      k("uncovered"),
      k("proof", "proof-a"),
      k("other"),
      k("transform"),
      k("risk", "risk-a"),
      k("behavior"),
      k("intent"),
      k("risk", "risk-b"),
      k("proof", "proof-b"),
    ]);
    expect(ordered.map((s) => s.title)).toEqual([
      "intent",
      "behavior",
      "risk-a",
      "proof-a",
      "risk-b",
      "proof-b",
      "other",
      "transform",
      "uncovered",
    ]);
  });
});

describe("proof rules", () => {
  const items = breakingApiEvidence();

  it("only ok, non-judgment, passing evidence can prove", () => {
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(canProve(byId.get("red-green")!)).toBe(true);
    expect(canProve({ ...byId.get("red-green")!, verdict: "not-proven" } as EvidenceItem)).toBe(false);
    expect(canProve({ ...byId.get("test-run")!, failed: 2 } as EvidenceItem)).toBe(false);
    expect(canProve({ ...byId.get("coverage")!, status: "error" } as EvidenceItem)).toBe(false);
    const judgment: EvidenceItem = {
      id: "llm-judgment:scope-drift",
      kind: "llm-judgment",
      status: "ok",
      question: "scope-drift",
      outcome: "no-concern",
      rationale: "fine",
      model: "m",
    };
    expect(canProve(judgment)).toBe(false);
  });

  function run(model: ModelTour, evidence: EvidenceItem[] = items) {
    const diff = breakingApiDiff();
    return postprocessTour({
      model,
      diff,
      evidence,
      reasons: [],
      ranking: rankHunks({ diff, evidence, plan: null }),
      transformStop: null,
      caps: capsForLane(2),
    });
  }

  it("downgrades proven stops citing only errored evidence or model judgments", () => {
    const errored = items.map((i) => (i.id === "coverage" ? ({ ...i, status: "error", note: "lcov missing" } as EvidenceItem) : i));
    const result = run(
      goodModelTour({ stops: [stop({ kind: "proof", title: "Coverage proves it", evidenceRefs: ["coverage"], verdict: "proven" })] }),
      errored,
    );
    expect(result.stops[0]).toMatchObject({ verdict: "unproven", evidenceRefs: ["coverage"] });
    expect(result.report.downgraded[0]?.reason).toMatch(/cannot prove/);
  });

  it("never proves an uncovered stop and never changes a risk verdict", () => {
    const result = run(
      goodModelTour({
        stops: [
          stop({ kind: "uncovered", title: "U", evidenceRefs: ["red-green"], verdict: "proven" }),
          stop({ kind: "risk", title: "R", evidenceRefs: ["nope"], verdict: "risk" }),
        ],
      }),
    );
    expect(result.stops.find((s) => s.title === "U")?.verdict).toBe("unproven");
    expect(result.stops.find((s) => s.title === "R")?.verdict).toBe("risk");
  });

  it("keeps platform notes even when the model fills its lists", () => {
    const result = run(
      goodModelTour({
        stops: [INTENT_STOP, stop({ title: "X", evidenceRefs: ["ghost"], verdict: "proven" }), RISK_DECL_STOP],
        leastConfident: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      }),
    );
    expect(result.leastConfident).toHaveLength(5);
    expect(result.leastConfident.at(-1)).toMatch(/^Platform checks: /);
    expect(result.report.droppedListEntries).toBe(6);
  });
});

describe("tour binding", () => {
  it("binds the tour to the diff's head and the change id", async () => {
    const outcome = await createReviewer(new FakeLlmClient([{ json: goodModelTour() }])).tour(breakingApiInput());
    if (outcome.status !== "ok") throw new Error(outcome.reason);
    expect(outcome.tour.headSha).toBe(HEAD_SHA);
    expect(outcome.tour.changeId).toBe(CHANGE_ID);
    expect(BASE_SHA).not.toBe(HEAD_SHA);
  });
});
