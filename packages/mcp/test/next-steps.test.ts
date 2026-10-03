/**
 * nextSteps follow the milestones the current head already passed (journey 10: `wait` answered
 * reached with a step to wait for the same milestone again).
 */
import type { Change } from "@app/domain";
import { describe, expect, it } from "vitest";
import { changeNextSteps } from "../src/index.js";
import { change } from "./support/fake-backend.js";

const calls = (c: Change) => changeNextSteps(c).map((s) => s.call ?? s.title);

describe("changeNextSteps", () => {
  it("a running change: evidence, then lane, then tour", () => {
    const running = change({ status: "running", lane: null, evidenceId: null, tourId: null });
    expect(calls(running)[0]).toMatch(/until: "evidence_ready"/);
    expect(calls({ ...running, evidenceId: "ev_1" })[0]).toMatch(/until: "lane_assigned"/);
    expect(calls({ ...running, evidenceId: "ev_1", lane: 2 })[0]).toMatch(/until: "tour_ready"/);
  });

  it("a failing change offers rerun_ci and close_change", () => {
    const steps = calls(change({ status: "failing" }));
    expect(steps.some((s) => s.startsWith("rerun_ci("))).toBe(true);
    expect(steps.some((s) => s.startsWith("close_change("))).toBe(true);
  });

  it("a bootstrap Change: green means start your first change, never another wait", () => {
    const bs = change({ id: "bs-repo_1", authorId: "system", lane: null, computedLane: null });
    expect(calls({ ...bs, status: "running" })[0]).toMatch(/until: "evidence_ready"/);
    const released = calls({ ...bs, status: "released", evidenceId: "ev_1" });
    expect(released).toHaveLength(1);
    expect(released[0]).toMatch(/^start_change\(/);
    expect(calls({ ...bs, status: "failing" }).some((s) => s.startsWith("rerun_ci("))).toBe(true);
  });
});
