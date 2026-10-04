/**
 * `get-change-status --human` is a readable summary (journey 10: "Status running, Lane -", a
 * STEPS column of raw JSON, no preview URL). The JSON output is unchanged.
 */
import { describe, expect, it } from "vitest";
import { makeStyle, renderHuman } from "../src/human.js";
import { changeStatusView } from "../src/views.js";

const SHA = "9c3d3a6d4da739669e3215c5df821a9a0e4f2eb5";

function status(over: Record<string, unknown> = {}, change: Record<string, unknown> = {}) {
  return {
    change: {
      id: "bs-cughqreo8qybycwotaah",
      repoId: "cughqreo8qybycwotaah",
      planId: null,
      title: "Bootstrap: first CI run and preview",
      category: "chore",
      status: "released",
      lane: null,
      computedLane: null,
      laneReasons: [],
      baseSha: SHA,
      headSha: SHA,
      ...change,
    },
    runs: [
      {
        id: "run-bs-cughqreo8qybycwotaah-9c3d3a6d4da7",
        headSha: SHA,
        status: "passed",
        steps: [
          { name: "install", kind: "user", status: "passed", logRef: "ci-logs/r/install.log" },
          { name: "test", kind: "user", status: "passed", logRef: null },
        ],
      },
    ],
    classification: null,
    previewUrl: "https://p-bs-cughqreo8qybycwotaah-pv.resynapse.dev",
    nextSteps: [{ title: "Start your first Change", command: "gittifacts start-change" }],
    ...over,
  };
}

describe("get-change-status --human", () => {
  it("a green bootstrap: status, no lane by design, the preview, and the steps as a table", () => {
    const text = renderHuman(changeStatusView(status()), { style: makeStyle(false), width: 100 });
    expect(text).toMatch(/Status: +released \(the first CI run passed\)/);
    expect(text).toMatch(/Lane: +none \(the first Change is never classified\)/);
    expect(text).toMatch(/Preview: +https:\/\/p-bs-cughqreo8qybycwotaah-pv\.resynapse\.dev/);
    expect(text).toMatch(/STEP\s+KIND\s+STATUS\s+LOG/);
    expect(text).toMatch(/install\s+user\s+✓ passed\s+ci-logs\/r\/install\.log/);
    expect(text).not.toContain('{"name"');
    expect(text).toContain("$ gittifacts start-change");
  });

  it("a graded change: the lane with its meaning and the reasons that raised it", () => {
    const view = changeStatusView(
      status(
        {
          previewUrl: null,
          classification: {
            lane: 2,
            computedLane: 2,
            shadow: true,
            blocked: false,
            requiresHumanApproval: true,
            reasons: [
              { code: "policy.changed", lane: 2, message: ".platform/** changed" },
              { code: "size.small", lane: 0, message: "small diff" },
            ],
          },
        },
        { id: "chg_1", status: "awaiting-review", lane: 2, computedLane: 2, planId: "plan_1" },
      ),
    );
    expect(view).toMatchObject({
      status: "awaiting-review (waiting for a human review)",
      lane: "Full review (Lane 2); auto-merge is calibrating on this repo",
      preview: "not up yet",
      plan: "plan_1",
      raisedBy: [{ lane: 2, code: "policy.changed", why: ".platform/** changed" }],
    });
  });

  it("nothing pushed yet", () => {
    const view = changeStatusView(
      status({ runs: [], previewUrl: null }, { id: "chg_2", status: "awaiting-push", headSha: null }),
    );
    expect(view).toMatchObject({ head: "nothing pushed yet", latestRun: "no run yet", preview: "-" });
  });
});
