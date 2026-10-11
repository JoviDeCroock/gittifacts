import { type Lane, NextStep } from "@app/domain";
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_RECONNECT,
  NEXT_STEP_EVENTS,
  type NextStepContexts,
  type NextStepEvent,
  nextStepsFor,
} from "../src/index.js";
import { expectValidCall } from "./helpers.js";

type Case = { [E in NextStepEvent]: [E, NextStepContexts[E]] }[NextStepEvent];

const lanes: [Lane, boolean][] = [
  [0, true],
  [0, false],
  [1, false],
  [2, false],
];

const cases: Case[] = [
  [
    "project_created",
    {
      projectId: "rep_1",
      changeId: "chg_1",
      claimUrl: "https://h/claim/x",
      claimed: false,
      anonymous: { mcpUrl: "https://h/mcp" },
    },
  ],
  [
    "project_created",
    {
      projectId: "rep_1",
      changeId: "chg_1",
      remoteUrl: "https://git.example/r.git",
      previewUrl: "https://p.preview.example",
      claimUrl: "https://h/claim/x",
      claimed: false,
    },
  ],
  ["project_created", { projectId: "rep_1", claimed: true }],
  [
    "project_created",
    {
      projectId: "rep_1",
      changeId: "bs-rep_1",
      firstChange: {
        changeId: "chg_2",
        remote: { url: "https://git.example/task-chg_2.git", branch: "main" },
      },
      previewUrl: "https://p-bs-rep_1.preview.example",
      claimed: true,
    },
  ],
  ["project_created", { projectId: "rep_1", claimed: false, claimUrl: null, previewUrl: null }],
  ["project_created", { projectId: "rep_1", changeId: "bs-rep_1", claimed: true, imported: true }],
  [
    "project_created",
    {
      projectId: "rep_1",
      changeId: "bs-rep_1",
      claimUrl: "https://h/claim/x",
      claimed: false,
      samplePlan: { planId: "plan_s1", title: "Add GET /version", url: "https://h/plans/plan_s1" },
    },
  ],
  [
    "change_started",
    { changeId: "chg_1", remote: { url: "https://git.example/task-chg_1.git", branch: "main" } },
  ],
  ["push_received", { changeId: "chg_1", headSha: "a".repeat(40) }],
  ["push_received", { changeId: "chg_1" }],
  [
    "ci_failed",
    {
      changeId: "chg_1",
      step: "test",
      logTail:
        "FAIL test/app.test.ts > GET / > returns json\nAssertionError: expected 500 to be 200",
    },
  ],
  [
    "ci_failed",
    {
      changeId: "chg_1",
      step: "install",
      logTail: "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile",
    },
  ],
  ["ci_failed", { changeId: "chg_1", step: "custom-e2e", command: "pnpm run e2e" }],
  ["ci_failed", { changeId: "chg_1", step: "evidence:coverage", logTail: "x".repeat(2000) }],
  ["evidence_ready", { changeId: "chg_1", ciPassed: true }],
  ["evidence_ready", { changeId: "chg_1", ciPassed: false }],
  ...lanes.map(
    ([lane, lane0Enabled]): Case => [
      "lane_assigned",
      {
        changeId: "chg_1",
        lane,
        lane0Enabled,
        reasons: [{ code: "api.additive", lane: 1, message: "additive export" }],
      },
    ],
  ),
  ["tour_ready", { changeId: "chg_1", lane: 1 }],
  ["merged", { changeId: "chg_1", repoId: "rep_1", rollout: true }],
  ["merged", { changeId: "chg_1", repoId: "rep_1", rollout: false }],
  [
    "reverted",
    { changeId: "chg_1", repoId: "rep_1", revertChangeId: "chg_2", reason: "error rate +4%" },
  ],
  ["reverted", { changeId: "chg_1", repoId: "rep_1" }],
];

describe("nextStepsFor", () => {
  it("has a case for every event", () => {
    expect(new Set(cases.map(([e]) => e))).toEqual(new Set(NEXT_STEP_EVENTS));
  });

  it.each(cases.map((c, i) => [`${c[0]} #${i}`, c] as const))(
    "%s: every step is valid and actionable",
    (_n, [event, ctx]) => {
      const steps = nextStepsFor(event, ctx as never);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(() => NextStep.parse(step)).not.toThrow();
        expect(step.call ?? step.command, JSON.stringify(step)).toBeDefined();
        if (step.call !== undefined) expectValidCall(step.call);
        for (const v of Object.values(step)) expect(v).not.toBeUndefined();
      }
    },
  );

  it("waits for the first CI after create_project and hands the claim link to a human", () => {
    const steps = nextStepsFor("project_created", {
      projectId: "rep_1",
      changeId: "chg_1",
      claimUrl: "https://h/claim/x",
      claimed: false,
    });
    expect(steps[0]?.call).toBe(
      'wait_for_change({ changeId: "chg_1", until: "evidence_ready", timeoutSec: 50 })',
    );
    expect(steps.at(-1)?.why).toContain("https://h/claim/x");
    expect(
      nextStepsFor("project_created", { projectId: "rep_1", claimed: true }).some((s) =>
        s.title.includes("claim"),
      ),
    ).toBe(false);
  });

  it("says when an unclaimed project expires and that its token is the Bearer token", () => {
    const steps = nextStepsFor("project_created", {
      projectId: "rep_1",
      claimUrl: "https://h/claim/x",
      claimed: false,
      expiresAt: "2026-10-09T00:00:00.000Z",
    });
    const claim = steps.at(-1)?.why ?? "";
    expect(claim).toContain("deleted at 2026-10-09T00:00:00.000Z");
    expect(claim).toContain("Bearer token for this repo only");
  });

  it("tells an anonymous caller to reconnect with the token first (eval m-20261002-073146-qzvw)", () => {
    const ctx = {
      projectId: "rep_1",
      changeId: "bs-rep_1",
      claimUrl: "https://h/claim/x",
      claimed: false,
      anonymous: { mcpUrl: "https://h/mcp" },
    };
    const [first] = nextStepsFor("project_created", ctx);
    expect(first?.title).toBe("Reconnect to https://h/mcp with Authorization: Bearer <token>");
    expect(first?.why).toContain(ANONYMOUS_RECONNECT);
    expect(first?.why).toContain("MCP server: https://h/mcp");
    expect(first?.call).toBe("whoami({})");
    // An authenticated caller has nothing to reconnect.
    const { anonymous: _a, ...authed } = ctx;
    expect(nextStepsFor("project_created", authed)[0]?.title).not.toMatch(/Reconnect/);
  });

  it("leads a template repo down the golden path: claim, approve the sample plan, build, review, merge", () => {
    const samplePlan = {
      planId: "plan_s1",
      title: "Add GET /version",
      url: "https://h/plans/plan_s1",
    };
    const steps = nextStepsFor("project_created", {
      projectId: "rep_1",
      changeId: "bs-rep_1",
      claimUrl: "https://h/claim/x",
      claimed: false,
      samplePlan,
    });
    // The first CI run stays first (the CLI, /start and journey 10 rely on it).
    expect(steps[0]?.call).toBe(
      'wait_for_change({ changeId: "bs-rep_1", until: "evidence_ready", timeoutSec: 50 })',
    );
    const lead = steps.slice(1, 8).map((s) => s.call ?? s.command);
    expect(lead[0]).toBe("whoami({})");
    expect(steps[1]?.why).toContain("https://h/claim/x");
    expect(lead.slice(1)).toEqual([
      'get_plan({ planId: "plan_s1" })',
      'start_change({ repoId: "rep_1", planId: "plan_s1", title: "Add GET /version", category: "feature" })',
      'git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>',
      'wait_for_change({ changeId: "<changeId from start_change>", until: "lane_assigned", timeoutSec: 50 })',
      'request_review({ changeId: "<changeId from start_change>" })',
      'wait_for_change({ changeId: "<changeId from start_change>", until: "merged", timeoutSec: 50 })',
    ]);
    expect(steps[2]?.why).toContain("https://h/plans/plan_s1 (after they claim the repo)");
    // The claim step is said once, up front.
    expect(steps.filter((s) => s.title.includes("claim link"))).toHaveLength(1);
    // Claimed: no claim step; the approval comes first.
    const claimed = nextStepsFor("project_created", { projectId: "rep_1", claimed: true, samplePlan });
    expect(claimed[0]?.call).toBe('get_plan({ planId: "plan_s1" })');
    expect(claimed.some((s) => s.title.includes("claim"))).toBe(false);
  });

  it("tells every wait step to call again while reason is timeout", () => {
    let waits = 0;
    for (const [event, ctx] of cases) {
      for (const step of nextStepsFor(event, ctx as never)) {
        if (step.call?.startsWith("wait_for_change(")) {
          waits++;
          expect(step.call).toContain("timeoutSec: 50");
          expect(step.why).toContain('call it again while reason is "timeout"');
        }
      }
    }
    expect(waits).toBeGreaterThan(5);
  });

  it("points an imported repo at propose_platform_config right after the first CI", () => {
    const steps = nextStepsFor("project_created", {
      projectId: "rep_1",
      changeId: "bs-rep_1",
      claimed: true,
      imported: true,
    });
    expect(steps.map((s) => s.call ?? s.command).slice(0, 2)).toEqual([
      'wait_for_change({ changeId: "bs-rep_1", until: "evidence_ready", timeoutSec: 50 })',
      'propose_platform_config({ repoId: "rep_1", waitSec: 45 })',
    ]);
    expect(steps[1]?.why).toMatch(/Plan \+ Change a human approves/);
    const template = nextStepsFor("project_created", { projectId: "rep_1", claimed: true });
    expect(template.some((s) => s.call?.startsWith("propose_platform_config("))).toBe(false);
  });

  it("hands a new project's first Change fork to the agent", () => {
    const steps = nextStepsFor("project_created", {
      projectId: "rep_1",
      changeId: "bs-rep_1",
      firstChange: {
        changeId: "chg_2",
        remote: { url: "https://git.example/task-chg_2.git", branch: "main" },
      },
      claimed: true,
    });
    expect(steps.map((s) => s.call ?? s.command)).toEqual([
      'wait_for_change({ changeId: "bs-rep_1", until: "evidence_ready", timeoutSec: 50 })',
      'git -c http.extraHeader="Authorization: Bearer <remote.token>" clone https://git.example/task-chg_2.git',
      'git -c http.extraHeader="Authorization: Bearer <remote.token>" push https://git.example/task-chg_2.git HEAD:main',
      'wait_for_change({ changeId: "chg_2", until: "evidence_ready", timeoutSec: 50 })',
      expect.stringContaining("create_plan("),
      expect.stringContaining("start_change("),
    ]);
  });

  it("tells a new Change to push to its fork", () => {
    const [push] = nextStepsFor("change_started", {
      changeId: "c",
      remote: { url: "https://git.example/f.git", branch: "main" },
    });
    expect(push?.command).toBe(
      'git -c http.extraHeader="Authorization: Bearer <remote.token>" push https://git.example/f.git HEAD:main',
    );
  });

  it("names the failing step, a hint and the log tail", () => {
    const [read, repro] = nextStepsFor("ci_failed", {
      changeId: "c",
      step: "install",
      logTail: "ERR_PNPM_OUTDATED_LOCKFILE",
    });
    expect(read?.title).toContain('"install"');
    expect(read?.why).toMatch(/lockfile doesn't match package\.json/);
    expect(read?.why).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    expect(repro?.command).toBe("pnpm install");
  });

  it("routes each lane differently", () => {
    const first = (lane: Lane, enabled: boolean) =>
      nextStepsFor("lane_assigned", { changeId: "c", lane, lane0Enabled: enabled })[0];
    expect(first(0, true)?.call).toContain('until: "merged"');
    expect(first(0, false)?.title).toMatch(/calibrating/);
    expect(first(1, false)?.call).toContain('until: "tour_ready"');
    expect(first(2, false)?.call).toContain("get_change_status");
    expect(
      nextStepsFor("lane_assigned", { changeId: "c", lane: 2, lane0Enabled: false }).some((s) =>
        s.call?.startsWith("request_review"),
      ),
    ).toBe(true);
    expect(
      nextStepsFor("lane_assigned", { changeId: "c", lane: 0, lane0Enabled: true }).some((s) =>
        s.call?.startsWith("request_review"),
      ),
    ).toBe(false);
  });

  it("never suggests approving", () => {
    for (const [event, ctx] of cases) {
      for (const s of nextStepsFor(event, ctx as never))
        expect(`${s.title} ${s.call ?? ""}`).not.toMatch(/\bapprove_|approve\(/);
    }
  });
});
