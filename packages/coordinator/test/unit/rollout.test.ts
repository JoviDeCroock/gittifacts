import { describe, expect, it } from "vitest";
import { linkedIssue } from "../../src/fakes/index.js";
import { revertIdFor, rolloutWorkflowId } from "../../src/ids.js";
import type { RolloutOutput } from "../../src/rollout-flow.js";
import { reload, type Scenario, scenario, startAndPush } from "./helpers.js";

const fast = { stages: [10, 100], stageMinutes: 2, watchMinutes: 3, maxErrorRateIncrease: 0.01, maxNewIssueGroups: 0, minRequests: 50 };

async function mergeOne(s: Scenario) {
  const started = await startAndPush(s);
  await s.coordinator.submitReview(s.reviewer, started.change.id, { decision: "approve" });
  await s.settle();
  return { ...started, change: await reload(s, started.change.id) };
}

async function withRollout(opts: { previous?: boolean } = {}) {
  const s = await scenario({ deployTarget: "api", policy: { rollout: fast, autoMergeVerifiedReverts: true } });
  if (opts.previous !== false) s.ports.deployer.live.set("api", [{ versionId: "v0", percentage: 100 }]);
  return s;
}

describe("RolloutWorkflow", () => {
  it("rolls out stage by stage, watches, and releases", async () => {
    const s = await withRollout();
    const { change } = await mergeOne(s);
    expect(change.status).toBe("released");
    const state = change.rolloutState;
    expect(state?.status).toBe("released");
    expect(state?.previousVersionId).toBe("v0");
    expect(state?.stages.map((x) => x.percent)).toEqual([10, 100]);
    expect(state?.stages.every((x) => x.startedAt !== null && x.completedAt !== null)).toBe(true);
    expect(state?.lastCheck?.requests).toBe(1000);
    expect(s.ports.deployer.splits.map((x) => x.split)).toEqual([
      [
        { versionId: state?.versionId, percentage: 10 },
        { versionId: "v0", percentage: 90 },
      ],
      [{ versionId: state?.versionId, percentage: 100 }],
    ]);
    // Telemetry was checked at least once a minute per stage + watch window.
    expect(s.ports.telemetry.calls.length).toBeGreaterThanOrEqual(fast.stageMinutes * 2 + fast.watchMinutes);
    expect(s.ports.deployer.uploads[0]).toMatchObject({ script: "api", changeId: change.id, sha: change.mergedSha });
    const output = s.bindings.rolloutWorkflow.instances.get(rolloutWorkflowId(change.id))?.output as RolloutOutput;
    expect(output.outcome).toBe("released");
  });

  it("regression → flag off → rollback → pure revert change that auto-merges as a verified revert", async () => {
    const s = await withRollout();
    // Healthy for the first check, then the error rate jumps at 10%.
    s.ports.telemetry.queue.push({ errorRate: 0.001 }, { errorRate: 0.2, baselineErrorRate: 0.001 });
    const { change, headSha } = await mergeOne(s);

    const original = await reload(s, change.id);
    expect(original.status).toBe("reverted");
    expect(original.rolloutState?.status).toBe("rolled-back");
    expect(original.revertedBy).toBe(revertIdFor(change.id));
    expect(s.ports.flags.flags.get(`change-${change.id}`)).toBe(false);
    expect(s.ports.deployer.rollbacks).toEqual([expect.objectContaining({ script: "api", versionId: "v0" })]);
    expect(s.ports.notifier.kinds(change.id)).toEqual(expect.arrayContaining(["regression-detected", "reverted"]));
    const steps = s.bindings.rolloutWorkflow.instances.get(rolloutWorkflowId(change.id))?.steps ?? [];
    expect(steps.slice(steps.indexOf("regression"))).toEqual(["regression", "flag-off", "rollback", "revert"]);

    // The revert is a normal Change: plan-less, claims revert, revertOf set, authored by the platform.
    const revert = await reload(s, revertIdFor(change.id));
    expect(revert).toMatchObject({ revertOf: change.id, planId: null, authorId: "system", claim: { category: "revert" } });
    // Verified pure revert + autoMergeVerifiedReverts → merged without a human, even in shadow mode.
    expect(revert.laneReasons.map((r) => r.code)).toEqual(expect.arrayContaining(["revert.verified", "revert.auto-merge"]));
    expect(revert.lane).toBe(0);
    expect(revert.mergedSha).not.toBeNull();
    const main = s.ports.git.head(s.repo.artifactsName) ?? "";
    const preMerge = s.ports.git.commits.get(headSha)?.parents[0] ?? "";
    expect(s.ports.git.commits.get(main)?.tree).toBe(s.ports.git.commits.get(preMerge)?.tree);
    for (const a of ["rollout.regression", "rollout.flag-off", "rollout.rolled-back", "change.revert-opened", "rollout.reverted"]) {
      expect(s.ports.audit.actions(`change:${change.id}`)).toContain(a);
    }
  });

  it("a Workers Issues webhook is linked to the version and short-circuits the wait", async () => {
    const s = await withRollout();
    // Hold the first wait so the webhook can arrive while the rollout is waiting.
    s.bindings.rolloutWorkflow.stepOptions = { onElapse: (ms) => s.ports.clock.advance(ms) };
    const { change } = await mergeOne(s);
    const rollout = s.bindings.rolloutWorkflow.instances.get(rolloutWorkflowId(change.id));
    expect(rollout?.waiting).toEqual(["issue"]);
    const versionId = (await reload(s, change.id)).rolloutState?.versionId ?? "";

    s.ports.telemetry.queue.push({ newIssueGroups: 1 });
    await s.coordinator.onIssue({
      name: "issues",
      text: "New issue in api",
      alert_type: "workers_observability_real_time_issue",
      alert_event: "ALERT_STATE_EVENT_START",
      data: { issueId: "iss-1", service: "api", title: "TypeError", count: 4, scriptVersion: { id: versionId } },
    });
    await s.settle();

    expect(rollout?.received.map((e) => e.type)).toContain("issue");
    const stored = s.ports.store.issues.get("iss-1");
    expect(stored).toMatchObject({ changeId: change.id, versionId, scriptName: "api" });
    expect((await reload(s, change.id)).status).toBe("reverted");
  });

  it("first deploy (no previous version): straight to 100%, flag off is the only mitigation", async () => {
    const s = await withRollout({ previous: false });
    s.ports.telemetry.queue.push({ errorRate: 0.5, baselineErrorRate: null });
    const { change } = await mergeOne(s);
    expect(s.ports.deployer.splits[0]?.split).toEqual([{ versionId: expect.any(String), percentage: 100 }]);
    expect(s.ports.deployer.rollbacks).toHaveLength(0);
    expect(s.ports.audit.actions(`change:${change.id}`)).toContain("rollout.rollback-impossible");
    expect(s.ports.flags.flags.get(`change-${change.id}`)).toBe(false);
    expect((await reload(s, change.id)).status).toBe("reverted");
  });

  it("telemetry that stays down counts as a regression (unknown → escalate)", async () => {
    const s = await withRollout();
    s.ports.telemetry.queue.push(new Error("503"), new Error("503"), new Error("503"));
    const { change } = await mergeOne(s);
    expect((await reload(s, change.id)).status).toBe("reverted");
  });

  it("a rollout waits for another rollout's split on the same script", async () => {
    const s = await withRollout();
    s.ports.deployer.live.set("api", [
      { versionId: "other", percentage: 25 },
      { versionId: "v0", percentage: 75 },
    ]);
    const started = await startAndPush(s);
    await s.coordinator.submitReview(s.reviewer, started.change.id, { decision: "approve" });
    // Let the other rollout finish after the first slot check.
    const wf = s.bindings.rolloutWorkflow;
    wf.stepOptions = {
      ...wf.stepOptions,
      onElapse: (ms) => {
        s.ports.clock.advance(ms);
        s.ports.deployer.live.set("api", [{ versionId: "other", percentage: 100 }]);
      },
    };
    await s.settle();
    const steps = wf.instances.get(rolloutWorkflowId(started.change.id))?.steps ?? [];
    expect(steps).toEqual(expect.arrayContaining(["slot-1", "slot-wait-1", "slot-2"]));
    expect((await reload(s, started.change.id)).rolloutState?.previousVersionId).toBe("other");
  });

  it("the human kill switch stops the rollout, turns the flag off, rolls back and opens a revert", async () => {
    const s = await withRollout();
    s.bindings.rolloutWorkflow.stepOptions = { onElapse: (ms) => s.ports.clock.advance(ms) };
    const { change } = await mergeOne(s);
    expect((await reload(s, change.id)).status).toBe("rolling-out");

    await expect(s.coordinator.kill(s.agent, change.id, "agents cannot")).rejects.toMatchObject({ code: "forbidden" });
    const killed = await s.coordinator.kill(s.reviewer, change.id, "checkout is broken");
    await s.settle();

    expect(killed.status).toBe("reverted");
    expect(s.bindings.rolloutWorkflow.instances.get(rolloutWorkflowId(change.id))?.state).toBe("terminated");
    expect(s.ports.flags.flags.get(`change-${change.id}`)).toBe(false);
    expect(s.ports.deployer.rollbacks.at(-1)).toMatchObject({ versionId: "v0" });
    expect((await reload(s, change.id)).rolloutState?.status).toBe("rolled-back");
    expect(await s.ports.store.getChange(revertIdFor(change.id))).toMatchObject({ revertOf: change.id });
    expect(s.ports.audit.actions(`change:${change.id}`)).toContain("change.killed");
  });
});
