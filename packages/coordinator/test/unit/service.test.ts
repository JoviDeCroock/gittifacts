import type { ReviewDecision } from "@app/domain";
import { describe, expect, it } from "vitest";
import { CoordinatorError } from "../../src/api.js";
import { approvedPlan, createFakeEnvironment, principal } from "../../src/fakes/index.js";
import { changeWorkflowId, ZERO_SHA } from "../../src/ids.js";
import { push, reload, scenario, startAndPush } from "./helpers.js";

async function rejects(
  p: Promise<unknown>,
  code: CoordinatorError["code"],
): Promise<CoordinatorError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CoordinatorError);
  const ce = e as CoordinatorError;
  expect(ce.code).toBe(code);
  // Every error says what to do next.
  expect(ce.fix.explanation.length).toBeGreaterThan(0);
  return ce;
}

describe("repos", () => {
  it("humans and owned agents get claimed repos; ownerless agents get unclaimed ones that expire", async () => {
    const env = createFakeEnvironment();
    const human = principal({ kind: "human" });
    const owned = principal({ kind: "agent", ownerId: human.id });
    const anon = principal({ kind: "agent" });
    expect((await env.coordinator.createRepo(human, { name: "mine" })).claim).toEqual({
      status: "claimed",
      ownerId: human.id,
      expiresAt: null,
    });
    expect((await env.coordinator.createRepo(owned, { name: "theirs" })).claim.ownerId).toBe(
      human.id,
    );
    const unclaimed = await env.coordinator.createRepo(anon, { name: "anon", template: "hono" });
    expect(unclaimed.claim).toEqual({
      status: "unclaimed",
      ownerId: null,
      expiresAt: "2026-10-08T12:00:00.000Z",
    });
    expect(unclaimed.template).toBe("hono");
    expect(unclaimed.namespace).toBe(env.ports.git.namespace);
    expect(env.ports.audit.actions()).toEqual(["repo.created", "repo.created", "repo.created"]);
  });

  it("validates names: no task- prefix, Artifacts charset, no duplicates", async () => {
    const env = createFakeEnvironment();
    const human = principal({ kind: "human" });
    await rejects(env.coordinator.createRepo(human, { name: "task-abc" }), "invalid-input");
    await rejects(env.coordinator.createRepo(human, { name: "-bad" }), "invalid-input");
    await env.coordinator.createRepo(human, { name: "dup" });
    await rejects(env.coordinator.createRepo(human, { name: "dup" }), "conflict");
  });

  it("import reads .platform/policy.ts from the default branch", async () => {
    const env = createFakeEnvironment();
    env.ports.git.importSources.set("https://github.com/o/r", { files: { "a.txt": "a" } });
    env.ports.sandbox.policies.set("rr", { thresholds: { lane0MaxFiles: 3 } });
    const repo = await env.coordinator.importRepo(principal({ kind: "human" }), {
      name: "rr",
      url: "https://github.com/o/r",
    });
    expect(repo.policy.thresholds.lane0MaxFiles).toBe(3);
    expect(repo.policySha).toBe(env.ports.git.head("rr"));
    expect(repo.importedFrom).toBe("https://github.com/o/r");
  });

  it("an import whose policy cannot be read falls back to defaults with Lane 0 off and no cached sha", async () => {
    const env = createFakeEnvironment();
    env.ports.git.importSources.set("https://github.com/o/bad", { files: { "a.txt": "a" } });
    env.ports.sandbox.policies.set("bad", { thresholds: { lane0MaxFiles: "many" } });
    const repo = await env.coordinator.importRepo(principal({ kind: "human" }), {
      name: "bad",
      url: "https://github.com/o/bad",
    });
    expect(repo.policy.lane0Enabled).toBe(false);
    expect(repo.policySha).toBeNull();
    await rejects(
      env.coordinator.importRepo(principal({ kind: "human" }), {
        name: "x",
        url: "http://insecure",
      }),
      "invalid-input",
    );
  });
});

describe("startChange / push grants", () => {
  it("forks to task-<id> and grants a write token for the fork only (TTL ≤ 1h)", async () => {
    const s = await scenario();
    const { change, remote } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "feature",
    });
    expect(change.forkName).toBe(`task-${change.id}`);
    expect(change.status).toBe("awaiting-push");
    expect(change.baseSha).toBe(s.ports.git.head(s.repo.artifactsName));
    expect(remote.url).toContain(`/task-${change.id}.git`);
    expect(remote.branch).toBe("main");
    expect(s.ports.git.tokens).toEqual([
      expect.objectContaining({ repo: change.forkName, scope: "write", ttlSeconds: 3600 }),
    ]);
    expect(s.ports.git.tokens.some((t) => t.repo === s.repo.artifactsName)).toBe(false);
    expect(s.ports.audit.actions(`change:${change.id}`)).toEqual(["change.started"]);
  });

  it("is idempotent per (actor, key)", async () => {
    const s = await scenario();
    const input = {
      repoId: s.repo.id,
      title: "t",
      category: "fix" as const,
      idempotencyKey: "k-1",
    };
    const a = await s.coordinator.startChange(s.agent, input);
    const b = await s.coordinator.startChange(s.agent, input);
    expect(b.change.id).toBe(a.change.id);
    expect(s.ports.store.changes.size).toBe(1);
    const other = principal({ kind: "agent", ownerId: s.owner.id });
    const c = await s.coordinator.startChange(other, input);
    expect(c.change.id).not.toBe(a.change.id);
  });

  it("refuses plans from other repos, ended plans and empty repos", async () => {
    const s = await scenario();
    s.ports.store.addPlan(approvedPlan("other", { id: "p-other" }));
    s.ports.store.addPlan(approvedPlan(s.repo.id, { id: "p-old", status: "superseded" }));
    await rejects(
      s.coordinator.startChange(s.agent, {
        repoId: s.repo.id,
        planId: "p-other",
        title: "t",
        category: "fix",
      }),
      "invalid-input",
    );
    await rejects(
      s.coordinator.startChange(s.agent, {
        repoId: s.repo.id,
        planId: "p-old",
        title: "t",
        category: "fix",
      }),
      "invalid-state",
    );
    await rejects(
      s.coordinator.startChange(s.agent, {
        repoId: s.repo.id,
        planId: "nope",
        title: "t",
        category: "fix",
      }),
      "not-found",
    );
    const empty = await s.coordinator.createRepo(s.owner, { name: "empty" });
    await rejects(
      s.coordinator.startChange(s.agent, { repoId: empty.id, title: "t", category: "fix" }),
      "invalid-state",
    );
  });

  it("only the author can refresh a push grant", async () => {
    const s = await scenario();
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    const grant = await s.coordinator.refreshPushGrant(s.agent, change.id);
    expect(grant.token).toContain(change.forkName);
    await rejects(s.coordinator.refreshPushGrant(s.reviewer, change.id), "forbidden");
    await s.coordinator.abandon(s.agent, change.id);
    await rejects(s.coordinator.refreshPushGrant(s.agent, change.id), "invalid-state");
  });
});

describe("onPush routing", () => {
  it("routes fork branch pushes to the change; ignores main repos, deletes, tags, other branches and duplicates", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    const head = push(s, change, { "src/a.ts": "x\n" });
    const ev = {
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: head,
    };

    await s.coordinator.onPush({ ...ev, repoName: s.repo.artifactsName });
    await s.coordinator.onPush({ ...ev, after: ZERO_SHA });
    await s.coordinator.onPush({ ...ev, ref: "refs/tags/v1" });
    await s.coordinator.onPush({ ...ev, ref: "refs/heads/feature" });
    await s.coordinator.onPush({ ...ev, repoName: "task-unknown" });
    expect(s.bindings.changeWorkflow.instances.size).toBe(0);

    await s.coordinator.onPush(ev);
    await s.coordinator.onPush(ev); // redelivered
    await s.settle();
    expect([...s.bindings.changeWorkflow.instances.keys()]).toEqual([
      changeWorkflowId(change.id, head),
    ]);
    expect((await reload(s, change.id)).headSha).toBe(head);
    expect(
      s.ports.audit.actions(`change:${change.id}`).filter((a) => a === "change.pushed"),
    ).toHaveLength(1);
  });

  it("trusts the fork's tip over event order", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    const first = push(s, change, { "src/a.ts": "1\n" });
    const second = push(s, change, { "src/a.ts": "2\n" });
    // The second push's event arrives first, then the first push's (stale) event.
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: first,
      after: second,
    });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: first,
    });
    await s.settle();
    expect([...s.bindings.changeWorkflow.instances.keys()]).toEqual([
      changeWorkflowId(change.id, second),
    ]);
  });

  it("an old head pushed again (A → B → A) restarts A's workflow", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    const a = push(s, change, { "src/a.ts": "1\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: a,
    });
    const b = push(s, change, { "src/a.ts": "2\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: a,
      after: b,
    });
    s.ports.git.repo(change.forkName).refs.set("refs/heads/main", a); // force-push back to A
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: b,
      after: a,
    });
    await s.settle();
    expect(s.bindings.changeWorkflow.instances.get(changeWorkflowId(change.id, a))?.restarts).toBe(
      1,
    );
    expect(s.bindings.changeWorkflow.instances.get(changeWorkflowId(change.id, b))?.state).toBe(
      "terminated",
    );
  });
});

describe("submitReview", () => {
  it("agents cannot review; nobody reviews their own change; reviewers need change:review", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    const otherAgent = principal({ kind: "agent", ownerId: s.owner.id, scopes: ["change:review"] });
    await rejects(
      s.coordinator.submitReview(otherAgent, change.id, { decision: "approve" }),
      "forbidden",
    );
    await rejects(
      s.coordinator.submitReview(s.agent, change.id, { decision: "approve" }),
      "forbidden",
    );
    const noScope = principal({ kind: "human", scopes: ["repo:read"] });
    await rejects(
      s.coordinator.submitReview(noScope, change.id, { decision: "approve" }),
      "forbidden",
    );
    expect(s.ports.store.reviews.size).toBe(0);
  });

  it("blocks self-approval by a human author", async () => {
    const s = await scenario();
    const { change } = await s.coordinator.startChange(s.reviewer, {
      repoId: s.repo.id,
      title: "mine",
      category: "fix",
      planId: `plan-${s.repo.id}`,
    });
    const head = push(s, change, { "src/a.ts": "y\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: head,
    });
    await s.settle();
    const e = await rejects(
      s.coordinator.submitReview(s.reviewer, change.id, { decision: "approve" }),
      "self-approval",
    );
    expect(e.fix.call).toContain("get_change_status");
  });

  it("binds to the current head and records computedLane for shadow agreement", async () => {
    const s = await scenario();
    const { change, headSha } = await startAndPush(s);
    await rejects(
      s.coordinator.submitReview(s.reviewer, change.id, {
        decision: "approve",
        headSha: "f".repeat(40),
      }),
      "conflict",
    );
    await s.coordinator.submitReview(s.reviewer, change.id, {
      decision: "approve",
      humanLane: 0,
      comment: "lgtm",
    });
    const [review] = [...s.ports.store.reviews.values()] as ReviewDecision[];
    expect(review).toMatchObject({
      changeId: change.id,
      headSha,
      reviewerId: s.reviewer.id,
      decision: "approve",
      humanLane: 0,
      computedLane: 0,
    });
    expect(await s.ports.store.listShadowSamples(s.repo.id)).toEqual([
      { computedLane: 0, humanLane: 0, decision: "approve" },
    ]);
  });

  it("the agent's owner may approve (recorded); .platform changes need a human other than the author", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s, { ".platform/ci.ts": "export default () => {}\n" });
    const cls = await s.ports.store.getClassification(change.id, change.headSha ?? "");
    expect(cls?.requiresHumanApproval).toBe(true);
    await s.coordinator.submitReview(s.owner, change.id, { decision: "approve" });
    const audit = s.ports.audit.payloadOf("change.reviewed") as {
      approvedByAgentOwner: boolean;
      requiresHumanApproval: boolean;
    };
    expect(audit).toMatchObject({ approvedByAgentOwner: true, requiresHumanApproval: true });
  });

  it("is idempotent with a key (a retry after the workflow moved on is a no-op)", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    await s.coordinator.submitReview(s.reviewer, change.id, {
      decision: "approve",
      idempotencyKey: "rk",
    });
    await s.settle();
    const again = await s.coordinator.submitReview(s.reviewer, change.id, {
      decision: "approve",
      idempotencyKey: "rk",
    });
    expect(again.status).toBe("released");
    expect(s.ports.store.reviews.size).toBe(1);
    // Without the key the same retry is an error (the change is no longer awaiting review).
    await rejects(
      s.coordinator.submitReview(s.reviewer, change.id, { decision: "approve" }),
      "invalid-state",
    );
  });

  it("refuses changes that are not awaiting review", async () => {
    const s = await scenario();
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    await rejects(
      s.coordinator.submitReview(s.reviewer, change.id, { decision: "approve" }),
      "invalid-state",
    );
    await rejects(
      s.coordinator.submitReview(s.reviewer, "missing", { decision: "approve" }),
      "not-found",
    );
  });
});

describe("setLane0", () => {
  const sample = (decision: ReviewDecision["decision"], i: number): ReviewDecision => ({
    id: `rev-${i}`,
    changeId: `c-${i}`,
    headSha: "a".repeat(40),
    reviewerId: "h",
    decision,
    humanLane: null,
    computedLane: 0,
    comment: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });

  it("needs a human policy admin and the shadow agreement threshold", async () => {
    const s = await scenario();
    await rejects(s.coordinator.setLane0(s.agent, s.repo.id, true), "forbidden");
    const e = await rejects(
      s.coordinator.setLane0(s.reviewer, s.repo.id, true),
      "threshold-not-met",
    );
    expect(e.message).toContain("25 more agreeing reviews needed");
    for (let i = 0; i < 25; i++) {
      await s.ports.store.insertChange({
        ...(await startAndPush(s)).change,
        id: `c-${i}`,
        forkName: `task-c-${i}`,
      });
      await s.ports.store.putReview(sample("approve", i));
    }
    const repo = await s.coordinator.setLane0(s.reviewer, s.repo.id, true);
    expect(repo.policy.lane0Enabled).toBe(true);
    expect(s.ports.audit.actions(`repo:${s.repo.id}`)).toContain("repo.lane0-enabled");
    expect((await s.coordinator.setLane0(s.reviewer, s.repo.id, false)).policy.lane0Enabled).toBe(
      false,
    );
  });

  it("is off for unclaimed projects", async () => {
    const s = await scenario({ claim: { status: "unclaimed", ownerId: null, expiresAt: null } });
    await rejects(s.coordinator.setLane0(s.reviewer, s.repo.id, true), "forbidden");
  });
});

describe("kill, abandon", () => {
  it("kill only applies to merged changes and only for humans", async () => {
    const s = await scenario();
    const { change } = await startAndPush(s);
    await rejects(s.coordinator.kill(s.reviewer, change.id, "nope"), "invalid-state");
    await rejects(s.coordinator.kill(s.reviewer, change.id, "   "), "invalid-input");
    await rejects(s.coordinator.kill(s.agent, change.id, "x"), "forbidden");
  });

  it("abandon terminates the workflow, cancels CI, leaves the queue and GCs the fork", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    const head = push(s, change, { "src/a.ts": "z\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: head,
    });
    await s.settle();
    await rejects(s.coordinator.abandon(principal({ kind: "agent" }), change.id), "forbidden");
    const abandoned = await s.coordinator.abandon(s.agent, change.id);
    expect(abandoned.status).toBe("abandoned");
    expect(s.bindings.changeWorkflow.instances.get(changeWorkflowId(change.id, head))?.state).toBe(
      "terminated",
    );
    expect(s.ports.ci.runs.get(`run-${changeWorkflowId(change.id, head)}`)?.status.status).toBe(
      "superseded",
    );
    // The fork GC alarm deletes the fork when it fires.
    expect(s.bindings.alarms.at(-1)?.changeId).toBe(change.id);
    s.ports.clock.advance(11 * 60_000);
    const coordinator = s.bindings.coordinators.get(change.id);
    expect(await coordinator?.alarm()).toBeNull();
    expect(s.ports.git.deleted).toEqual([change.forkName]);
    // Abandoning twice is fine; merged changes cannot be abandoned.
    expect((await s.coordinator.abandon(s.agent, change.id)).status).toBe("abandoned");
    const merged = await startAndPush(await scenario({ policy: { lane0Enabled: true } }));
    expect(merged.change.status).toBe("released");
  });
});

describe("onIssue", () => {
  it("stores webhook issues (lenient payloads) and ignores ones without an id", async () => {
    const s = await scenario();
    await s.coordinator.onIssue({ data: { id: "i-9", service: "api", title: "boom" } });
    await s.coordinator.onIssue({ text: "no id at all" });
    await s.coordinator.onIssue("garbage");
    expect([...s.ports.store.issues.keys()]).toEqual(["i-9"]);
    expect(s.ports.store.issues.get("i-9")).toMatchObject({ scriptName: "api", changeId: null });
  });
});

describe("waitFor / watchChange", () => {
  it("times out with the current snapshot, and watch returns as soon as the row changes", async () => {
    const s = await scenario();
    s.ports.ci.autoFinish = false;
    const { change } = await s.coordinator.startChange(s.agent, {
      repoId: s.repo.id,
      title: "t",
      category: "fix",
    });
    const t = await s.coordinator.waitFor(s.agent, change.id, "lane_assigned", 10);
    expect(t).toMatchObject({ reached: false, reason: "timeout" });
    expect(t.change.id).toBe(change.id);
    const first = await s.coordinator.watchChange(s.agent, change.id, {
      since: null,
      timeoutMs: 10,
    });
    expect(first.changed).toBe(true);
    const watching = s.coordinator.watchChange(s.agent, change.id, {
      since: first.version,
      timeoutMs: 5000,
    });
    const head = push(s, change, { "src/a.ts": "w\n" });
    await s.coordinator.onPush({
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: change.baseSha,
      after: head,
    });
    const next = await watching;
    expect(next.changed).toBe(true);
    expect(next.change.headSha).toBe(head);
    await rejects(s.coordinator.waitFor(s.agent, change.id, "soon" as never, 10), "invalid-input");
  });
});
