import { describe, expect, it } from "vitest";
import { groupLaneReasons, orderLaneReasons } from "../src/lane-reasons.js";
import type { LaneReason } from "../src/model.js";

const r = (code: string, lane: 0 | 1 | 2): LaneReason => ({ code, lane, message: code });

describe("groupLaneReasons", () => {
  it("puts the reasons that set the lane first and folds the passing checks", () => {
    const reasons = [r("api.none", 0), r("plan.missing", 1), r("ci.failed", 2), r("size.ok", 0), r("tests.failing", 2)];
    const g = groupLaneReasons(reasons);
    expect(g.lane).toBe(2);
    expect(g.deciding.map((x) => x.code)).toEqual(["ci.failed", "tests.failing"]);
    expect(g.raising.map((x) => x.code)).toEqual(["plan.missing"]);
    expect(g.passing.map((x) => x.code)).toEqual(["api.none", "size.ok"]);
    expect(orderLaneReasons(reasons).map((x) => x.code)).toEqual([
      "ci.failed",
      "tests.failing",
      "plan.missing",
      "api.none",
      "size.ok",
    ]);
  });

  it("has nothing deciding for an all-clear Lane 0 Change", () => {
    const g = groupLaneReasons([r("api.none", 0)]);
    expect(g).toMatchObject({ lane: 0, deciding: [], raising: [] });
    expect(groupLaneReasons([]).lane).toBe(0);
  });
});
