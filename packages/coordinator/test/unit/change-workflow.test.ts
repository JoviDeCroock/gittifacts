import { describe, expect, it } from "vitest";
import type { ChangeWorkflowOutput } from "../../src/change-flow.js";
import { changeWorkflowId, rolloutWorkflowId } from "../../src/ids.js";
import { POLICY_UNAVAILABLE_CODE } from "../../src/policy.js";
import { push, reload, scenario, startAndPush } from "./helpers.js";

const lane0 = { lane0Enabled: true } as const;

describe("ChangeWorkflow (node, fake ports)", () => {
  it("lane 1 (shadow) → review → merge queue → merged → rollout → released", async () => {
    const s = await scenario({ deployTarget: "my-worker" });
    s.ports.deployer.live.set("my-worker", [{ versionId: "v0", percentage: 100 }]);
    const { change, headSha, instanceId } = await startAndPush(s);

    expect(change.status).toBe("awaiting-review");
    expect(change.computedLane).toBe(0);
    expect(change.lane).toBe(1); // shadow mode: Lane 0 is off by default
    expect(change.laneReasons.map((r) => r.code)).toContain("shadow.lane0-disabled");
    expect(change.evidenceId).not.toBeNull();
    expect(change.tourId).not.toBeNull();
    const instance = s.bindings.changeWorkflow.instances.get(instanceId);
    expect(instance?.waiting).toEqual(["review"]);
    // The reviewer agent never sees the author's summary.
    expect(JSON.stringify(s.ports.reviewer.tourCalls)).not.toContain("author's own summary");
    // CI was asked to plan from BASE, and evidence landed on the fork as a git note.
    expect(s.ports.ci.starts[0]).toMatchObject({
      pipelineFrom: "base",
      network: "open",
      limits: { maxMinutes: 90 },
    });
    expect(await s.ports.git.readNote(change.forkName, headSha)).toContain(
      "gittifacts.evidence/v1",
    );
    const evidence = await s.ports.store.getEvidence(change.id, headSha);
    expect(evidence?.notesWritten).toBe(true);
    expect(evidence?.items.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        "test-run",
        "sensitive-paths",
        "preview",
        "screenshots",
        "agent-trace",
      ]),
    );
    expect(evidence?.items.find((i) => i.kind === "preview")?.status).toBe("skipped");

    await s.coordinator.submitReview(s.reviewer, change.id, { decision: "approve", humanLane: 0 });
    await s.settle();

    const done = await reload(s, change.id);
    expect(done.mergedSha).toBe(headSha);
    expect(done.status).toBe("released");
    expect(done.rolloutState?.status).toBe("released");
    expect(s.ports.git.head(s.repo.artifactsName)).toBe(headSha);
    expect(s.ports.git.repo(s.repo.artifactsName).refs.has(`refs/merge-queue/${change.id}`)).toBe(
      false,
    );
    expect(await s.ports.git.readNote(s.repo.artifactsName, headSha)).toContain(headSha);
    expect(s.ports.deployer.splits.map((x) => x.split.map((v) => v.percentage))).toEqual([
      [5, 95],
      [25, 75],
      [100],
    ]);
    expect(s.ports.flags.flags.get(`change-${change.id}`)).toBe(true);
    expect(s.bindings.rolloutWorkflow.instances.has(rolloutWorkflowId(change.id))).toBe(true);
    expect(s.ports.notifier.kinds(change.id)).toEqual(
      expect.arrayContaining(["review-requested", "merged", "rollout-stage"]),
    );
    const output = s.bindings.changeWorkflow.instances.get(instanceId)
      ?.output as ChangeWorkflowOutput;
    expect(output).toMatchObject({ outcome: "merged", rollout: "started" });
    const actions = s.ports.audit.actions(`change:${change.id}`);
    for (const a of [
      "change.started",
      "change.pushed",
      "change.ci-passed",
      "change.evidence-signed",
      "change.classified",
      "change.review-requested",
      "change.reviewed",
      "change.approved",
      "change.queued",
      "change.merged",
      "change.rollout-started",
      "rollout.version-uploaded",
      "rollout.released",
    ]) {
      expect(actions).toContain(a);
    }
    // The merged fork is scheduled for deletion.
    expect(s.bindings.alarms.some((a) => a.changeId === change.id)).toBe(true);
  });

  it("lane 0 enabled → auto-merge without review or tour", async () => {
    const s = await scenario({ policy: lane0 });
    const { change, headSha } = await startAndPush(s);
    expect(change.lane).toBe(0);
    expect(change.status).toBe("released"); // no deploy target
    expect(change.mergedSha).toBe(headSha);
    expect(change.tourId).toBeNull();
    expect(s.ports.reviewer.tourCalls).toHaveLength(0);
    expect(s.ports.notifier.kinds(change.id)).not.toContain("review-requested");
  });

  it("unclaimed projects never auto-merge and never roll out", async () => {
    const s = await scenario({
      policy: lane0,
      deployTarget: "anon-worker",
      claim: { status: "unclaimed", ownerId: null, expiresAt: "2026-10-08T00:00:00.000Z" },
    });
    const { change } = await startAndPush(s);
    expect(change.computedLane).toBe(0);
    expect(change.lane).toBe(1);
    expect(change.status).toBe("awaiting-review");
    await s.coordinator.submitReview(s.reviewer, change.id, { decision: "approve" });
    await s.settle();
    const merged = await reload(s, change.id);
    expect(merged.status).toBe("merged");
    expect(s.bindings.rolloutWorkflow.instances.size).toBe(0);
    expect(s.ports.deployer.uploads).toHaveLength(0);
    expect(s.ports.audit.actions(`change:${change.id}`)).toContain("rollout.skipped");
    // CI for unclaimed projects only reaches package registries.
    expect(s.ports.ci.starts.every((r) => r.network === "registries-only")).toBe(true);
  });

  it("CI failure blocks: failing, notified, no tour, no merge", async () => {
    const s = await scenario();
    s.ports.ci.outcome = () => ({ status: "failed", evidence: [] });
    const { change, instanceId } = await startAndPush(s);
    expect(change.status).toBe("failing");
    expect(change.lane).toBe(2);
    expect(s.ports.notifier.kinds(change.id)).toContain("failing");
    expect(s.ports.reviewer.tourCalls).toHaveLength(0);
    expect(s.bindings.changeWorkflow.instances.get(instanceId)?.output).toMatchObject({
      outcome: "blocked",
    });
  });

  it("evidence that does not verify blocks the change", async () => {
    const s = await scenario({ policy: lane0 });
    s.ports.signer.failVerification = true;
    const { change } = await startAndPush(s);
    expect(change.status).toBe("failing");
    expect(change.laneReasons.map((r) => r.code)).toContain("evidence.unverified");
  });

  it("tour failure → reclassified to Lane 2", async () => {
    const s = await scenario();
    s.ports.reviewer.tourOutcome = "failed";
    const { change } = await startAndPush(s);
    expect(change.lane).toBe(2);
    expect(change.laneReasons.map((r) => r.code)).toContain("tour.failed");
    expect(change.status).toBe("awaiting-review");
    expect(
      s.ports.audit.actions(`change:${change.id}`).filter((a) => a === "change.classified"),
    ).toHaveLength(2);
  });

  it("budget exceeded escalates to Lane 2 and notifies", async () => {
    const s = await scenario({
      policy: { ai: { budgetUsdPerChange: 0.015, reviewerModel: "auto" } },
    });
    const { change } = await startAndPush(s);
    expect(change.lane).toBe(2);
    expect(change.laneReasons.map((r) => r.code)).toContain("budget.exceeded");
    expect(s.ports.notifier.kinds(change.id)).toContain("budget-exceeded");
    // Spend is tracked across heads by the change's coordinator.
    expect(await s.bindings.changeCoordinator(change.id).spent(change.id)).toBeCloseTo(0.03);
  });

  it("a judge that fails is an unknown signal (raises the lane), not a crash", async () => {
    const s = await scenario({ policy: lane0 });
    s.ports.reviewer.judgeError = new Error("gateway 500");
    const { change } = await startAndPush(s);
    expect(change.lane).toBeGreaterThanOrEqual(1);
    expect(change.laneReasons.map((r) => r.code)).toContain("signal.error.llm-judgment");
  });

  it("model concerns raise the lane (raise-only)", async () => {
    const s = await scenario({ policy: lane0 });
    s.ports.reviewer.judgeItems = [
      {
        id: "llm:scope",
        kind: "llm-judgment",
        status: "ok",
        question: "scope-drift",
        outcome: "concern",
        rationale: "touches billing",
        model: "m",
      },
    ];
    const { change } = await startAndPush(s);
    expect(change.lane).toBe(2);
    expect(change.status).toBe("awaiting-review");
  });

  it("policy from BASE: an unreadable policy escalates (Lane ≥ 1, policy.unavailable)", async () => {
    const s = await scenario({ policy: lane0 });
    // Base no longer matches the cached policy sha, and the sandbox cannot evaluate it.
    await s.ports.store.updateRepo(s.repo.id, { policySha: null });
    s.ports.sandbox.policyError = new Error("container failed to start");
    const { change } = await startAndPush(s);
    expect(change.lane).toBe(1);
    expect(change.laneReasons[0]?.code).toBe(POLICY_UNAVAILABLE_CODE);
    expect(change.status).toBe("awaiting-review");
  });

  it("the head's policy edits never govern the change: .platform changes need a human (Lane 2)", async () => {
    const s = await scenario({ policy: lane0 });
    const { change } = await startAndPush(s, {
      ".platform/policy.ts": "export default { lane0Enabled: true }\n",
    });
    expect(change.lane).toBe(2);
    const cls = await s.ports.store.getClassification(change.id, change.headSha ?? "");
    expect(cls?.requiresHumanApproval).toBe(true);
    // The policy was evaluated at the base sha of the main repo, never the fork head.
    expect(s.ports.sandbox.calls.filter((c) => c.op === "policy")).toEqual([]);
  });

  it("a newer push supersedes the older workflow and cancels its CI run", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      planId: `plan-${s.repo.id}`,
      title: "Fix a",
      category: "fix",
    });
    const first = push(s, change, { "src/a.ts": "export const a = 2;\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: first,
    });
    await s.settle();
    const firstInstance = s.bindings.changeWorkflow.instances.get(
      changeWorkflowId(change.id, first),
    );
    expect(firstInstance?.waiting).toEqual(["ci-finished"]);

    s.ports.ci.autoFinish = true;
    const second = push(s, change, { "src/a.ts": "export const a = 3;\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: first,
      after: second,
    });
    await s.settle();

    expect(firstInstance?.state).toBe("terminated");
    const firstRun = s.ports.ci.runs.get(`run-${changeWorkflowId(change.id, first)}`);
    expect(firstRun?.status.status).toBe("superseded");
    expect((await s.ports.store.getRun(firstRun?.status.id ?? ""))?.status).toBe("superseded");
    const fresh = await reload(s, change.id);
    expect(fresh.headSha).toBe(second);
    expect(fresh.status).toBe("awaiting-review");
    // A review of the old head is refused.
    await expect(
      s.coordinator.submitReview(s.reviewer, change.id, { decision: "approve", headSha: first }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("request-changes sends the change back to the author; reject ends it and GCs the fork", async () => {
    const s = await scenario();
    const a = await startAndPush(s);
    await s.coordinator.submitReview(s.reviewer, a.change.id, {
      decision: "request-changes",
      comment: "add a test",
    });
    await s.settle();
    expect((await reload(s, a.change.id)).status).toBe("awaiting-push");

    const b = await startAndPush(s);
    await s.coordinator.submitReview(s.reviewer, b.change.id, { decision: "reject" });
    await s.settle();
    expect((await reload(s, b.change.id)).status).toBe("rejected");
    expect(s.bindings.alarms.some((x) => x.changeId === b.change.id)).toBe(true);
  });

  it("main moved: the merge queue rebases, re-checks, re-signs, and the rollout is skipped (no bundle)", async () => {
    const s = await scenario({ deployTarget: "w" });
    s.ports.deployer.live.set("w", [{ versionId: "v0", percentage: 100 }]);
    const a = await startAndPush(s, { "src/a.ts": "export const a = 2;\n" });
    const b = await startAndPush(s, { "src/b.ts": "export const b = 1;\n" });
    await s.coordinator.submitReview(s.reviewer, a.change.id, { decision: "approve" });
    await s.settle();
    await s.coordinator.submitReview(s.reviewer, b.change.id, { decision: "approve" });
    await s.settle();

    const merged = await reload(s, b.change.id);
    expect(merged.status).toBe("merged");
    expect(merged.mergedSha).not.toBe(b.headSha);
    const main = s.ports.git.head(s.repo.artifactsName);
    expect(main).toBe(merged.mergedSha);
    expect(s.ports.git.filesAt(main ?? "")).toMatchObject({
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    // Cheap re-check: no evidence steps; evidence re-signed for the rebased sha with a signed link.
    expect(
      s.ports.ci.starts.some((r) => r.runId.startsWith("mq-") && r.evidenceSteps?.length === 0),
    ).toBe(true);
    expect(await s.ports.store.getEvidence(b.change.id, merged.mergedSha ?? "")).not.toBeNull();
    expect(s.ports.signer.documents).toContainEqual(
      expect.objectContaining({ purpose: "evidence-rebase", rebasedFrom: b.headSha }),
    );
    expect(s.ports.audit.actions(`change:${b.change.id}`)).toEqual(
      expect.arrayContaining(["merge-queue.rebased", "rollout.skipped"]),
    );
  });

  it("wait_for_change: evidence_ready and lane_assigned resolve; tour_ready is unreachable after auto-merge", async () => {
    const s = await scenario({ policy: lane0 });
    const { change } = await startAndPush(s);
    const evidence = await s.coordinator.waitFor(s.agent, change.id, "evidence_ready", 1000);
    expect(evidence).toMatchObject({ reached: true, reason: "reached" });
    expect((await s.coordinator.waitFor(s.agent, change.id, "merged", 0)).reached).toBe(true);
    expect(await s.coordinator.waitFor(s.agent, change.id, "tour_ready", 1000)).toMatchObject({
      reached: false,
      reason: "unreachable",
    });
    expect(await s.coordinator.waitFor(s.agent, change.id, "reverted", 20)).toMatchObject({
      reached: false,
      reason: "timeout",
    });
  });

  it("wait_for_change wakes up when the workflow reaches the milestone", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      planId: `plan-${s.repo.id}`,
      title: "x",
      category: "fix",
    });
    const head = push(s, change, { "src/a.ts": "export const a = 9;\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: head,
    });
    await s.settle();
    const waiting = s.coordinator.waitFor(s.agent, change.id, "lane_assigned", 5000);
    await s.ports.ci.finish(`run-${changeWorkflowId(change.id, head)}`);
    await s.settle();
    expect(await waiting).toMatchObject({ reached: true });
  });
});
