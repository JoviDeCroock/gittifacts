import type { Change, LaneReason } from "@app/domain";
import { describe, expect, it } from "vitest";
import { familyLabel, foldChart, groupByLane, matchesFilter, noTourCopy, pct, reasonFamily, shadowProgress, triageChart, unroutedCopy } from "../src/lib/lanes.js";

type C = Pick<Change, "lane" | "computedLane" | "status" | "updatedAt"> & { id: string };
const c = (id: string, lane: C["lane"], computedLane: C["computedLane"], status: C["status"] = "awaiting-review", updatedAt = "2026-10-01T10:00:00Z"): C => ({
  id,
  lane,
  computedLane,
  status,
  updatedAt,
});

describe("groupByLane", () => {
  const changes = [
    c("shadowed", 1, 0),
    c("glance", 1, 1),
    c("full", 2, 2),
    c("running", null, null, "running"),
    c("full-old", 2, 2, "awaiting-review", "2026-09-01T10:00:00Z"),
    c("full-released", 2, 2, "released", "2026-10-01T12:00:00Z"),
  ];

  it("orders Lane 2, Lane 1, Lane 0 (shadow), then unrouted", () => {
    const groups = groupByLane(changes, false);
    expect(groups.map((g) => g.key)).toEqual(["lane2", "lane1", "lane0", "unrouted"]);
    expect(groups.find((g) => g.key === "lane0")?.shadow).toBe(true);
  });

  it("puts computed-Lane-0 changes in the Lane 0 group even when routed to Lane 1", () => {
    const lane0 = groupByLane(changes, false).find((g) => g.key === "lane0");
    expect(lane0?.items.map((i) => i.id)).toEqual(["shadowed"]);
  });

  it("sorts awaiting review first, then most recent", () => {
    const lane2 = groupByLane(changes, true).find((g) => g.key === "lane2");
    expect(lane2?.items.map((i) => i.id)).toEqual(["full", "full-old", "full-released"]);
    expect(groupByLane(changes, true).find((g) => g.key === "lane0")?.shadow).toBe(false);
  });

  it("omits empty groups", () => {
    expect(groupByLane([c("only", 1, 1)], false).map((g) => g.key)).toEqual(["lane1"]);
  });
});

describe("matchesFilter", () => {
  it("splits statuses into review, in flight and closed", () => {
    expect(matchesFilter("awaiting-review", "review")).toBe(true);
    expect(matchesFilter("rolling-out", "active")).toBe(true);
    expect(matchesFilter("reverted", "closed")).toBe(true);
    expect(matchesFilter("reverted", "active")).toBe(false);
    expect(matchesFilter("running", "all")).toBe(true);
  });
});

describe("triageChart", () => {
  const reasons: LaneReason[] = [
    { code: "size.small", lane: 0, message: "small" },
    { code: "api.breaking", lane: 2, message: "breaking", evidenceRef: "public-api" },
    { code: "signal.missing.mutation", lane: 1, message: "no mutation run" },
  ];

  it("sorts rows by forced lane and marks the decisive ones", () => {
    const chart = triageChart(reasons, 2, 2);
    expect(chart.rows.map((r) => r.reason.code)).toEqual(["api.breaking", "signal.missing.mutation", "size.small"]);
    expect(chart.rows.filter((r) => r.decisive).map((r) => r.reason.code)).toEqual(["api.breaking"]);
    expect(chart.rows.find((r) => r.reason.code === "signal.missing.mutation")?.unknown).toBe(true);
    expect(chart.shadowRaised).toBe(false);
  });

  it("separates the shadow-mode raise from the evidence", () => {
    const chart = triageChart(
      [
        { code: "proof.red-green", lane: 0, message: "proven" },
        { code: "shadow.lane0-disabled", lane: 1, message: "shadow" },
      ],
      0,
      1,
    );
    expect(chart.rows).toHaveLength(1);
    expect(chart.computedLane).toBe(0);
    expect(chart.routedLane).toBe(1);
    expect(chart.shadowRaised).toBe(true);
    expect(chart.rows[0]?.decisive).toBe(false);
  });

  it("derives lanes from reasons when the server sends none", () => {
    const chart = triageChart(reasons, null, null);
    expect(chart.computedLane).toBe(2);
    expect(chart.routedLane).toBe(2);
  });

  it("maps codes to families", () => {
    expect(reasonFamily("deps.install-script")).toBe("dependencies");
    expect(reasonFamily("merge-queue.resolution-novel-lines")).toBe("resolution");
    expect(reasonFamily("merge-queue.resolution-outside-hunks")).toBe("resolution");
    expect(familyLabel("merge-queue.resolution-novel-lines")).toBe("Conflict resolution");
    expect(reasonFamily("merge-queue.quarantined-test")).toBe("other");
    expect(reasonFamily("signal.error.coverage")).toBe("missing");
    expect(reasonFamily("whatever")).toBe("other");
  });

  it("names every family the live classifier sends (no row reads 'Other')", () => {
    const live = ["ci.passed", "budget.ok", "evidence.verified", "dependency.none", "migration.none", "red-green.not-required", "tour.failed", "informational.ok", "resolution.semantic", "lane0.enabled"];
    for (const code of live) expect(familyLabel(code), code).not.toBe("Other");
    expect(reasonFamily("dependency.none")).toBe("dependencies");
    expect(reasonFamily("red-green.proven")).toBe("proof");
    expect(reasonFamily("signal.skip-accepted.mutation")).toBe("mutation");
  });

  it("labels a missing or failed measurement by what was not measured", () => {
    expect(familyLabel("signal.missing.test-run")).toBe("Test run missing");
    expect(familyLabel("signal.error.llm-judgment")).toBe("Model judgment failed");
    expect(familyLabel("signal.error.something-new")).toBe("Missing measurement");
    const chart = triageChart([{ code: "signal.error.screenshots", lane: 1, message: "Screenshots errored." }], 1, 1);
    expect(chart.rows[0]?.label).toBe("Screenshots failed");
    expect(chart.rows[0]?.unknown).toBe(true);
  });
});

describe("shadowProgress", () => {
  it("is collecting until the minimum sample count is reached", () => {
    const p = shadowProgress({ samples: 18, agreed: 18, ratio: null, needed: 7, threshold: 0.95, eligibleToEnableLane0: false });
    expect(p.state).toBe("collecting");
    expect(p.detail).toContain("7 more reviews");
  });

  it("estimates the agreeing reviews still needed below the threshold", () => {
    const p = shadowProgress({ samples: 44, agreed: 41, ratio: 41 / 44, needed: 0, threshold: 0.95, eligibleToEnableLane0: false });
    expect(p.state).toBe("below");
    // (0.95*44 - 41) / 0.05 = 16 more agreeing reviews
    expect(p.detail).toContain("about 16 more");
  });

  it("is eligible at or above the threshold", () => {
    const p = shadowProgress({ samples: 61, agreed: 59, ratio: 59 / 61, needed: 0, threshold: 0.95, eligibleToEnableLane0: true });
    expect(p.state).toBe("eligible");
    expect(p.headline).toBe("96.7% agreement");
  });

  it("formats percentages", () => {
    expect(pct(0.95)).toBe("95%");
    expect(pct(0.9318, 1)).toBe("93.2%");
    expect(pct(1, 1)).toBe("100%");
  });
});

describe("unroutedCopy", () => {
  it("never calls an open change closed", () => {
    for (const status of ["awaiting-push", "running", "failing", "awaiting-review"] as const) {
      const copy = unroutedCopy(status, "chg_1");
      expect(copy.title).toBe("Not routed yet");
      expect(copy.line).not.toMatch(/closed/);
    }
    expect(unroutedCopy("failing", "chg_1").line).toMatch(/pushes a fix/);
  });
  it("closed changes and the bootstrap are not routed, each with its own reason", () => {
    expect(unroutedCopy("abandoned", "chg_1")).toEqual({ title: "Not routed", line: "This change closed before a lane was computed." });
    expect(unroutedCopy("merged", "bs-abc").line).toMatch(/first change/);
  });
});

describe("noTourCopy", () => {
  const ch = (status: Parameters<typeof noTourCopy>[0]["status"], extra: Partial<Parameters<typeof noTourCopy>[0]> = {}) => ({
    id: "chg_1",
    status,
    lane: null,
    laneReasons: [],
    ...extra,
  });
  it("titles a failing change's section by what it holds; the chip and decision bar already say checks failed", () => {
    const copy = noTourCopy(ch("failing"), "failed");
    expect(copy.title).toBe("What failed");
    expect(copy.title).not.toMatch(/checks fail/i);
    expect(copy.showDiff).toBe(false);
  });
  it("follows the change and its latest run", () => {
    expect(noTourCopy(ch("awaiting-push")).title).toBe("Waiting for the first push");
    // Sent back by a reviewer: there is a head, and the author is pushing a new one.
    expect(noTourCopy(ch("awaiting-push", { headSha: "abc1234" })).body).not.toMatch(/not pushed/);
    expect(noTourCopy(ch("awaiting-push", { headSha: "abc1234" })).showDiff).toBe(true);
    expect(noTourCopy(ch("awaiting-review"), "queued").title).toBe("The walkthrough is not written yet");
    expect(noTourCopy(ch("awaiting-review", { laneReasons: [{ code: "tour.failed" }] }), "passed").showDiff).toBe(true);
    expect(noTourCopy(ch("merged", { id: "bs-abc" })).title).toMatch(/first change/);
    expect(noTourCopy(ch("merged", { lane: 0 })).title).toMatch(/auto-merged/);
  });
  it("covers every branch: running, review, the closed fallbacks", () => {
    expect(noTourCopy(ch("running")).title).toBe("The walkthrough is not written yet");
    expect(noTourCopy(ch("awaiting-review"), "passed")).toMatchObject({
      title: "The reviewer agent is writing the walkthrough",
      showDiff: true,
    });
    expect(noTourCopy(ch("awaiting-review", { laneReasons: [{ code: "tour.failed" }] })).title).toBe(
      "No walkthrough: the reviewer agent could not write one",
    );
    expect(noTourCopy(ch("merged", { lane: 1 }))).toEqual({
      title: "No walkthrough for this change",
      body: "It was decided without a walkthrough. The diff and the signed evidence are the record.",
      showDiff: true,
    });
    expect(noTourCopy(ch("merged", { lane: 2, laneReasons: [{ code: "tour.failed" }] })).title).toBe(
      "No walkthrough: the reviewer agent could not write one",
    );
    expect(noTourCopy(ch("failing"), "failed").body).toMatch(/pushes a fix/);
  });
});

describe("foldChart", () => {
  const r = (code: string, lane: 0 | 1 | 2): LaneReason => ({ code, lane, message: code });
  it("puts the deciding reasons first, then the raising ones, and folds the passing checks", () => {
    const chart = triageChart([r("tests.passed", 0), r("scope.drift", 1), r("api.breaking", 2), r("coverage.ok", 0), r("deps.added", 2)], null, null);
    const { shown, passing } = foldChart(chart.rows);
    expect(shown.map((x) => x.reason.code)).toEqual(["api.breaking", "deps.added", "scope.drift"]);
    expect(passing.map((x) => x.reason.code)).toEqual(["tests.passed", "coverage.ok"]);
  });
  it("never folds a missing measurement into passed", () => {
    const { shown, passing } = foldChart(triageChart([r("coverage.missing", 0), r("tests.passed", 0)], null, null).rows);
    expect(shown.map((x) => x.reason.code)).toEqual(["coverage.missing"]);
    expect(passing.map((x) => x.reason.code)).toEqual(["tests.passed"]);
  });
});
