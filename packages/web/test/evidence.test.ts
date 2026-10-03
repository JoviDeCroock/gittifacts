import type { LaneReason } from "@app/domain";
import { describe, expect, it } from "vitest";
import { unmeasuredEffect } from "../src/lib/evidence.js";

const r = (code: string, lane: LaneReason["lane"], evidenceRef?: string): LaneReason => ({ code, lane, message: code, evidenceRef });

describe("unmeasuredEffect", () => {
  it("says a missing measurement raised the lane only when a reason anchored to it did", () => {
    const reasons = [r("plan.missing", 1), r("signal.missing.coverage", 1, "coverage")];
    expect(unmeasuredEffect("coverage", reasons)).toBe("Unknown counts as risk: this forces at least Lane 1.");
    expect(unmeasuredEffect("agent-trace", reasons)).toBe("It did not raise this change's lane.");
  });
  it("names a skip the policy accepts", () => {
    expect(unmeasuredEffect("mutation", [r("signal.skip-accepted.mutation", 0, "mutation")])).toMatch(/policy accepts this skip/);
  });
  it("before classification it can only say the gap can raise the lane", () => {
    expect(unmeasuredEffect("coverage", [])).toBe("Unknown counts as risk, so it can raise the lane.");
  });
});
