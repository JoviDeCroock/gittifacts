/**
 * nextSteps follow the milestones the current head already passed (journey 10: `wait` answered
 * reached with a step to wait for the same milestone again).
 */
import type { Change } from "@app/domain";
import { describe, expect, it } from "vitest";
import { changeNextSteps, type PlanData, planNextSteps, type ReviewBrief } from "../src/index.js";
import { change, HEAD, SHA } from "./support/fake-backend.js";

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

const review = (over: Partial<ReviewBrief> = {}): ReviewBrief => ({
  decision: "request-changes",
  comment: "Handle the empty list too.",
  headSha: HEAD,
  reviewer: { id: "hu_2", name: "Grace", kind: "human" },
  withdrawn: null,
  ...over,
});

describe("changeNextSteps after a human sent the change back", () => {
  const sentBack = change({ status: "awaiting-push", headSha: HEAD });

  it("changes requested: quote the comment, push a new head, then ask again", () => {
    const steps = changeNextSteps(sentBack, [], [review({ headSha: SHA }), review()]);
    expect(steps[0]).toMatchObject({
      title: `Changes requested on ${HEAD.slice(0, 7)} by Grace: address the comment`,
      why: "Handle the empty list too.",
    });
    expect(steps.map((s) => s.call)).toEqual([
      undefined,
      'refresh_push_token({ changeId: "chg_1" })',
      'request_review({ changeId: "chg_1" })',
    ]);
    // Never the "nothing pushed yet" step of a fresh change.
    expect(steps.some((s) => s.why?.includes("Nothing has been pushed"))).toBe(false);
  });

  it("without the reviews (wait_for_change): read them in get_change_status first", () => {
    expect(changeNextSteps(sentBack)[0]).toMatchObject({
      title: expect.stringContaining("Changes requested"),
      call: 'get_change_status({ changeId: "chg_1" })',
    });
  });

  it("nothing pushed yet is still a push, not a request for changes", () => {
    const fresh = changeNextSteps(change({ status: "awaiting-push", headSha: null }));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.why).toContain("Nothing has been pushed yet");
  });

  it("rejected: says who and why, and offers a new change", () => {
    const steps = changeNextSteps(
      change({ status: "rejected" }),
      [],
      [review({ decision: "reject", comment: "Not this way." })],
    );
    expect(steps[0]).toMatchObject({
      title: "Rejected by Grace: this change ended",
      why: "Not this way.",
      call: expect.stringMatching(/^start_change\(/),
    });
  });

  it("a withdrawn approval of the current head comes first", () => {
    const withdrawn = { at: "2026-10-01T00:03:00.000Z", reason: "qa-failed" };
    const steps = changeNextSteps(
      change({ status: "awaiting-review" }),
      [],
      [review({ decision: "approve", comment: null, withdrawn })],
    );
    expect(steps[0]).toMatchObject({
      title: expect.stringContaining("approval by Grace was withdrawn (qa-failed)"),
      call: 'get_qa({ changeId: "chg_1" })',
    });
    expect(steps.at(-1)?.call).toMatch(/^request_review\(/);
  });
});

describe("planNextSteps", () => {
  const plan: PlanData = {
    id: "plan_1",
    repoId: "repo_1",
    title: "Rate limit logins",
    intent: "Stop credential stuffing on /login.",
    acceptanceCriteria: ["429 on the 6th try"],
    outOfScope: [],
    riskDeclarations: [],
    scopePaths: ["src/**"],
    affectedRoutes: [],
    status: "draft",
    authorId: "ag_1",
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    supersedes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const url = "https://gittifacts.test/plans/plan_1";

  it("the author's draft: hand the page to a person, check back, or withdraw", () => {
    const steps = planNextSteps(plan, "ag_1", url);
    expect(steps[0]?.title).toContain(url);
    expect(steps.map((s) => s.call?.split("(")[0])).toEqual([
      undefined,
      "get_plan",
      "withdraw_plan",
    ]);
  });

  it("someone else's draft offers no withdraw", () => {
    const steps = planNextSteps(plan, "ag_2", url);
    expect(steps.some((s) => s.call?.startsWith("withdraw_plan("))).toBe(false);
  });

  it("approved: start the change from it", () => {
    const [step] = planNextSteps({ ...plan, status: "approved", approvedBy: "hu_2" }, "ag_1", url);
    expect(step?.call).toBe(
      'start_change({ repoId: "repo_1", planId: "plan_1", title: "Rate limit logins", category: "feature" })',
    );
  });

  it("rejected or withdrawn: draft a new one; superseded: list the approved ones", () => {
    const rejected = {
      ...plan,
      status: "rejected" as const,
      rejectedBy: "hu_2",
      rejectionReason: "Too broad",
    };
    expect(planNextSteps(rejected, "ag_1", url)[0]).toMatchObject({
      title: expect.stringMatching(/^Rejected/),
      why: "Too broad",
      call: expect.stringMatching(/^create_plan\(/),
    });
    const withdrawn = { ...rejected, rejectedBy: "ag_1" };
    expect(planNextSteps(withdrawn, "ag_1", url)[0]?.title).toMatch(/^Withdrawn by its author/);
    expect(planNextSteps({ ...plan, status: "superseded" }, "ag_1", url)[0]?.call).toBe(
      'list_plans({ repoId: "repo_1", status: "approved" })',
    );
  });
});
