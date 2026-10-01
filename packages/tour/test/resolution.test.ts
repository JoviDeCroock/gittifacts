/** The platform's "Conflict resolution" stop (merge queue). */
import { Tour, type TourStop } from "@app/domain";
import type { ConflictResolution, EvidenceItem } from "@app/evidence";
import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "../src/llm.js";
import {
  canProve,
  capsForLane,
  placeResolutionStop,
  postprocessTour,
  resolutionStopFor,
} from "../src/postprocess.js";
import { rankHunks } from "../src/rank.js";
import { createReviewer } from "../src/tour.js";
import {
  breakingApiDiff,
  breakingApiEvidence,
  breakingApiInput,
  classification,
  FORMAT_DECL_HEAD_LINE,
  goodModelTour,
  signed,
  stop,
} from "./support/scenario.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

function resolution(overrides: Partial<ConflictResolution> = {}): ConflictResolution {
  return {
    id: "conflict-resolution",
    kind: "conflict-resolution",
    status: "ok",
    upstreamChanges: [{ changeId: "chg_upstream_symbols", sha: "c".repeat(40), planId: "plan_up" }],
    conflictHunks: [
      { file: "src/format.ts", startLine: FORMAT_DECL_HEAD_LINE, endLine: FORMAT_DECL_HEAD_LINE },
      { file: "src/not-in-diff.ts", startLine: 1, endLine: 3 },
    ],
    resolutionDiff: "diff --git a/src/format.ts b/src/format.ts\n",
    truncated: false,
    touchesOutsideConflictHunks: false,
    novelLines: 0,
    semanticConflictWith: null,
    rationale: "Kept the upstream doc comment and the change's new signature.",
    resolver: {
      model: "anthropic/claude-sonnet-5",
      principalId: "system:resolver",
      promptVersion: "resolver-2026-10-01.1",
    },
    attempts: 1,
    ...overrides,
  };
}

const withResolution = (r: ConflictResolution, extra: EvidenceItem[] = []): EvidenceItem[] => [
  ...breakingApiEvidence(),
  r,
  ...extra,
];

describe("resolutionStopFor", () => {
  it("is null without a conflict-resolution item", () => {
    expect(resolutionStopFor(breakingApiDiff(), breakingApiEvidence())).toBeNull();
  });

  it("within the hunks and the merged tree's tests pass: proven, citing the resolution and tests", () => {
    const s = resolutionStopFor(breakingApiDiff(), withResolution(resolution()))!;
    expect(s.kind).toBe("resolution");
    expect(s.verdict).toBe("proven");
    expect(s.title).toBe("Conflict resolution against 1 upstream change");
    expect(s.evidenceRefs).toEqual(["conflict-resolution", "test-run"]);
    // Refs are checked against the diff: the file outside it is dropped.
    expect(s.hunkRefs).toEqual([
      {
        file: "src/format.ts",
        startLine: FORMAT_DECL_HEAD_LINE,
        endLine: FORMAT_DECL_HEAD_LINE,
        side: "head",
      },
    ]);
    expect(s.why).toContain("chg_upstream_symbols (cccccccccccc)");
    expect(s.why).toContain("system:resolver");
    expect(s.why).toContain("only replaced the conflict hunks");
    expect(s.why).toContain("The merged tree's tests pass.");
    expect(s.why).toContain("Resolver's rationale");
  });

  it("is only unproven when no test run on the merged tree passed", () => {
    const failing = breakingApiEvidence().map((i) =>
      i.kind === "test-run" ? { ...i, failed: 1 } : i,
    );
    const s = resolutionStopFor(breakingApiDiff(), [...failing, resolution()])!;
    expect(s.verdict).toBe("unproven");
    expect(s.evidenceRefs).toEqual(["conflict-resolution"]);
    const quarantined: EvidenceItem = {
      id: "quarantine",
      kind: "quarantine",
      status: "ok",
      tests: [
        {
          id: "q1",
          file: "test/format.test.ts",
          name: "q1",
          flakeRate: 0.2,
          quarantinedAt: "2026-10-01T08:00:00.000Z",
        },
      ],
      inAffectedSet: ["q1"],
    };
    expect(
      resolutionStopFor(breakingApiDiff(), withResolution(resolution(), [quarantined]))!.verdict,
    ).toBe("unproven");
  });

  it("edits outside the conflict hunks are a risk, and their lines come first", () => {
    const s = resolutionStopFor(
      breakingApiDiff(),
      withResolution(
        resolution({
          touchesOutsideConflictHunks: true,
          outsideHunks: [{ file: "src/index.ts", startLine: 5, endLine: 5 }],
        }),
      ),
    )!;
    expect(s.verdict).toBe("risk");
    expect(s.why).toContain("OUTSIDE the conflict hunks");
    expect(s.hunkRefs[0]).toEqual({ file: "src/index.ts", startLine: 5, endLine: 5, side: "head" });
  });

  it("a semantic conflict names the culprit and is a risk", () => {
    const s = resolutionStopFor(
      breakingApiDiff(),
      withResolution(
        resolution({
          conflictHunks: [],
          touchesOutsideConflictHunks: true,
          semanticConflictWith: "chg_upstream_symbols",
          failingTests: ["test/format.test.ts > formatMoney > code style"],
        }),
      ),
    )!;
    expect(s.verdict).toBe("risk");
    expect(s.title).toBe("Conflict resolution: semantic conflict with chg_upstream_symbols");
    expect(s.why).toContain("the resolver blamed chg_upstream_symbols");
    expect(s.why).toContain("test/format.test.ts > formatMoney > code style");
  });

  it("a failed resolution is a risk", () => {
    const s = resolutionStopFor(
      breakingApiDiff(),
      withResolution(
        resolution({ status: "error", note: "output invalid twice", conflictHunks: [] }),
      ),
    )!;
    expect(s.verdict).toBe("risk");
    expect(s.title).toBe("Conflict resolution failed");
    expect(s.why).toContain("output invalid twice");
  });

  it("the resolution item can never prove a stop by itself", () => {
    expect(canProve(resolution())).toBe(false);
  });
});

describe("placement", () => {
  const r: TourStop = {
    kind: "resolution",
    title: "R",
    why: "w",
    hunkRefs: [],
    evidenceRefs: [],
    verdict: "risk",
  };
  const s = (kind: TourStop["kind"]): TourStop => ({ ...r, kind, title: kind });

  it("goes right after the riskiest stop", () => {
    const out = placeResolutionStop([s("intent"), s("risk"), s("proof"), s("risk")], r);
    expect(out.map((x) => x.title)).toEqual(["intent", "risk", "R", "proof", "risk"]);
  });

  it("without a risk stop it starts the risk/proof section", () => {
    const out = placeResolutionStop([s("intent"), s("behavior"), s("proof"), s("uncovered")], r);
    expect(out.map((x) => x.title)).toEqual(["intent", "behavior", "R", "proof", "uncovered"]);
    expect(placeResolutionStop([s("intent")], r).map((x) => x.title)).toEqual(["intent", "R"]);
  });

  it("is never dropped by the stop cap", () => {
    const diff = breakingApiDiff();
    const evidence = withResolution(resolution());
    const many = Array.from({ length: 12 }, (_, i) =>
      stop({ kind: "other", title: `Other ${i}`, why: "Filler." }),
    );
    const post = postprocessTour({
      model: goodModelTour({ stops: many }),
      diff,
      evidence,
      reasons: [],
      ranking: rankHunks({ diff, evidence, plan: null }),
      transformStop: null,
      resolutionStop: resolutionStopFor(diff, evidence),
      caps: capsForLane(1),
    });
    expect(post.stops).toHaveLength(7);
    expect(post.stops.some((x) => x.kind === "resolution")).toBe(true);
  });
});

describe("in a generated tour", () => {
  it("adds the stop after the riskiest stop, tells the model, and validates as a Tour", async () => {
    const client = new FakeLlmClient([{ json: goodModelTour() }]);
    const reviewer = createReviewer(client, {
      now: () => NOW,
      newId: () => "tour_res_1",
      principalId: "reviewer-agent",
    });
    const input = breakingApiInput({
      evidence: signed(withResolution(resolution({ touchesOutsideConflictHunks: true }))),
      classification: classification(2, [
        {
          code: "api.breaking",
          lane: 2,
          message: "Public API has breaking changes: formatMoney.",
          evidenceRef: "public-api",
        },
        {
          code: "resolution.outside-conflict",
          lane: 1,
          message: "The conflict resolution edited lines outside the conflict hunks.",
          evidenceRef: "conflict-resolution",
        },
      ]),
    });
    const out = await reviewer.tour(input);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const kinds = out.tour.stops.map((x) => x.kind);
    const firstRisk = kinds.indexOf("risk");
    expect(kinds[firstRisk + 1]).toBe("resolution");
    expect(out.tour.stops[firstRisk + 1]?.verdict).toBe("risk");
    expect(Tour.safeParse(out.tour).success).toBe(true);
    const prompt = client.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("The platform adds one stop for the resolution itself");
    expect(prompt).toContain("EDITS OUTSIDE the conflict hunks");
    // Lane 2 allows 12 stops; the platform's resolution stop takes one.
    expect(prompt).toContain("At most 11 stops");
  });
});
