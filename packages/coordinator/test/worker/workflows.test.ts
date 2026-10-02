/**
 * The real ChangeWorkflow / RolloutWorkflow / ChangeCoordinator / MergeQueue classes under
 * workerd (@cloudflare/vitest-plugin), with fake Ports. Workflow behaviour is controlled through
 * `introspectWorkflowInstance` (disableSleeps, mockEvent) and real events sent by the service.
 */
import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Change, Repo } from "@app/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeWorkflowOutput } from "../../src/change-flow.js";
import { type CoordinatorEnv, cloudflareBindings } from "../../src/cloudflare-bindings.js";
import type { ChangeWorkflowParams, RolloutParams } from "../../src/events.js";
import {
  approvedPlan,
  type FakePorts,
  linkedIssue,
  portsForRole,
  principal,
} from "../../src/fakes/index.js";
import { changeWorkflowId, ciRunIdFor, revertIdFor, rolloutWorkflowId } from "../../src/ids.js";
import { withChangeNotifications } from "../../src/milestones.js";
import type { RolloutOutput } from "../../src/rollout-flow.js";
import { createRunSink } from "../../src/run-sink.js";
import { createCoordinator } from "../../src/service.js";
import { resetFakePorts } from "./fixture.js";

type TestEnv = CoordinatorEnv & {
  BATCH_RUN_WORKFLOW: Workflow<unknown>;
  CHANGE_WORKFLOW: Workflow<ChangeWorkflowParams>;
  ROLLOUT_WORKFLOW: Workflow<RolloutParams>;
  PUSH_ROUTER: Workflow<unknown>;
};
const testEnv = env as unknown as TestEnv;

let ports: FakePorts;

async function seedRepo(overrides: Partial<Repo> = {}): Promise<Repo> {
  const head = ports.git.seed("app", { "src/a.ts": "export const a = 1;\n" });
  const repo: Repo = {
    id: "repo-1",
    namespace: ports.git.namespace,
    artifactsName: "app",
    name: "app",
    defaultBranch: "main",
    jurisdiction: "eu",
    importedFrom: null,
    policy: (await import("@app/domain")).defaultPolicy(),
    policySha: head,
    deployTarget: null,
    claim: { status: "claimed", ownerId: "owner", expiresAt: null },
    template: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
  await ports.store.insertRepo(repo);
  return repo;
}

beforeEach(() => {
  ports = resetFakePorts();
  const bindings = cloudflareBindings(testEnv);
  ports.ci.sink = createRunSink(withChangeNotifications(ports, bindings), bindings);
  ports.ci.autoFinish = false; // the test finishes CI runs explicitly
});

describe("ChangeWorkflow (workerd)", () => {
  it("lane 1 → review event → merge queue → merged", async () => {
    const bindings = cloudflareBindings(testEnv);
    const coordinator = createCoordinator(portsForRole(ports, "default"), bindings);
    const repo = await seedRepo();
    const owner = ports.store.addPrincipal(principal({ kind: "human" }));
    const agent = ports.store.addPrincipal(principal({ kind: "agent", ownerId: owner.id }));
    const reviewer = ports.store.addPrincipal(principal({ kind: "human" }));
    ports.store.addPlan(approvedPlan(repo.id));

    const { change } = await coordinator.startChange(agent, {
      repoId: repo.id,
      planId: `plan-${repo.id}`,
      title: "Fix a",
      category: "fix",
    });
    const head = ports.git.commit(change.forkName, "main", { "src/a.ts": "export const a = 2;\n" });
    const instanceId = changeWorkflowId(change.id, head);
    await using instance = await introspectWorkflowInstance(testEnv.CHANGE_WORKFLOW, instanceId);
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    // The push event → ChangeCoordinator DO → ChangeWorkflow instance for this head.
    await coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: head,
    });
    await instance.waitForStepResult({ name: "ci-start" });

    // The CI engine reports the run to its sink → "ci-finished" on this instance.
    await ports.ci.finish(ciRunIdFor(instanceId));
    await instance.waitForStepResult({ name: "request-review" });
    const waiting: Change | null = await ports.store.getChange(change.id);
    expect(waiting).toMatchObject({ status: "awaiting-review", lane: 1, computedLane: 0 });

    // A human approves the current head → "review" event → merge queue (the agent-native DO:
    // batch tree on main, a BatchRunWorkflow runs CI on it, CAS) → "merged" event.
    await using batchRuns = await introspectWorkflow(testEnv.BATCH_RUN_WORKFLOW);
    await batchRuns.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    await coordinator.submitReview(reviewer, change.id, { decision: "approve" });
    const queueRuns = () => [...ports.ci.runs.keys()].filter((id) => id.startsWith("mq-"));
    await vi.waitFor(() => expect(queueRuns().length).toBeGreaterThan(0), { timeout: 20_000 });
    const queued = ports.ci.runs.get(queueRuns()[0] ?? "");
    expect(queued?.request).toMatchObject({
      artifactsRepo: "app",
      headSha: head,
      evidenceSteps: [],
    });
    for (const id of queueRuns()) await ports.ci.finish(id);
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as ChangeWorkflowOutput;
    expect(output).toMatchObject({ outcome: "merged", lane: 1, detail: head, rollout: "none" });

    const merged = await ports.store.getChange(change.id);
    expect(merged).toMatchObject({ status: "released", mergedSha: head });
    expect(ports.git.head("app")).toBe(head);
    expect(ports.audit.actions(`change:${change.id}`)).toEqual(
      expect.arrayContaining([
        "change.pushed",
        "change.classified",
        "change.reviewed",
        "change.queued",
        "change.merged",
        "change.released",
      ]),
    );
    // DO state: the instance and run are tracked per change.
    const state = await bindings.changeCoordinator(change.id).state(change.id);
    expect(state).toMatchObject({ headSha: head, instanceId, runId: ciRunIdFor(instanceId) });
  });
});

describe("PushRouter (workerd)", () => {
  it("routes an Artifacts push event to the change's coordinator, which starts the ChangeWorkflow", async () => {
    const bindings = cloudflareBindings(testEnv);
    const coordinator = createCoordinator(portsForRole(ports, "default"), bindings);
    const repo = await seedRepo();
    const agent = ports.store.addPrincipal(principal({ kind: "agent", ownerId: "owner" }));
    const { change } = await coordinator.startChange(agent, {
      repoId: repo.id,
      title: "t",
      category: "feature",
    });
    const head = ports.git.commit(change.forkName, "main", { "src/b.ts": "export const b = 1;\n" });

    await using changeWorkflows = await introspectWorkflow(testEnv.CHANGE_WORKFLOW);
    await using router = await introspectWorkflowInstance(testEnv.PUSH_ROUTER, "push-1");
    await testEnv.PUSH_ROUTER.create({
      id: "push-1",
      params: {
        type: "cf.artifacts.repo.pushed",
        source: {
          type: "artifacts.repo",
          namespace: ports.git.namespace,
          repoName: change.forkName,
        },
        payload: {
          ref: "refs/heads/main",
          before: change.baseSha,
          after: head,
          commits: [],
          totalCommitsCount: 1,
        },
        metadata: { eventSchemaVersion: 1 },
      },
    });
    await router.waitForStatus("complete");
    expect(await router.getOutput()).toEqual({ routed: true, reason: null });
    expect((await changeWorkflows.get()).length).toBe(1);
    expect(await ports.store.getChange(change.id)).toMatchObject({
      headSha: head,
      status: "running",
    });

    // Events for other namespaces or main repos are ignored without touching any change.
    await using other = await introspectWorkflowInstance(testEnv.PUSH_ROUTER, "push-2");
    await testEnv.PUSH_ROUTER.create({
      id: "push-2",
      params: {
        type: "cf.artifacts.repo.pushed",
        source: { namespace: "keelhaul", repoName: "x" },
        payload: { ref: "refs/heads/main", before: head, after: head },
      },
    });
    await other.waitForStatus("complete");
    expect(await other.getOutput()).toMatchObject({ routed: false });
  });
});

describe("RolloutWorkflow (workerd)", () => {
  it("regression → flag off → rollback → revert change", async () => {
    const repo = await seedRepo({ deployTarget: "api" });
    ports.deployer.live.set("api", [{ versionId: "v0", percentage: 100 }]);
    // A merged change at the tip of main.
    const mergedSha = ports.git.commit(
      "app",
      "main",
      { "src/a.ts": "export const a = 2;\n" },
      "merge c1",
    );
    const change: Change = {
      id: "c1",
      repoId: repo.id,
      planId: null,
      title: "Make a two",
      claim: { category: "fix", summary: null },
      baseSha: ports.git.commits.get(mergedSha)?.parents[0] ?? "",
      headSha: mergedSha,
      forkName: "task-c1",
      authorId: "agent",
      status: "rolling-out",
      computedLane: 1,
      lane: 1,
      laneReasons: [],
      evidenceId: null,
      tourId: null,
      flagKey: null,
      mergedSha,
      rolloutState: null,
      revertOf: null,
      revertedBy: null,
      agentTraceId: null,
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
    };
    await ports.store.insertChange(change);
    ports.telemetry.queue.push({ requests: 500, errorRate: 0.3, baselineErrorRate: 0.001 });

    await using revertWorkflows = await introspectWorkflow(testEnv.CHANGE_WORKFLOW);
    await revertWorkflows.modifyAll(async (m) => {
      await m.disableSleeps();
    });
    const id = rolloutWorkflowId("c1");
    await using instance = await introspectWorkflowInstance(testEnv.ROLLOUT_WORKFLOW, id);
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      // A Workers Issues webhook arrives during the first wait: no need to sit out the minute.
      await m.mockEvent({ type: "issue", payload: linkedIssue({ id: "iss-1" }) });
    });
    await testEnv.ROLLOUT_WORKFLOW.create({
      id,
      params: { changeId: "c1", bundleRef: "bundles/c1", rollout: repo.policy.rollout },
    });
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as RolloutOutput;
    expect(output).toMatchObject({ outcome: "rolled-back", revertChangeId: revertIdFor("c1") });

    expect(ports.flags.flags.get("change-c1")).toBe(false);
    expect(ports.deployer.rollbacks).toEqual([
      expect.objectContaining({ script: "api", versionId: "v0" }),
    ]);
    const original = await ports.store.getChange("c1");
    expect(original).toMatchObject({ status: "reverted", revertedBy: revertIdFor("c1") });
    expect(original?.rolloutState?.status).toBe("rolled-back");
    const revert = await ports.store.getChange(revertIdFor("c1"));
    expect(revert).toMatchObject({
      revertOf: "c1",
      claim: { category: "revert" },
      authorId: "system",
      planId: null,
    });
    // The revert commit restores the pre-merge tree exactly.
    expect(ports.git.commits.get(revert?.headSha ?? "")?.tree).toBe(
      ports.git.commits.get(change.baseSha)?.tree,
    );
    expect(ports.audit.actions("change:c1")).toEqual(
      expect.arrayContaining([
        "rollout.regression",
        "rollout.flag-off",
        "rollout.rolled-back",
        "change.revert-opened",
        "rollout.reverted",
      ]),
    );
    // The revert entered the normal pipeline (its own ChangeWorkflow instance).
    expect((await revertWorkflows.get()).length).toBe(1);
  });
});
