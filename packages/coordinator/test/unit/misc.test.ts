import { classify } from "@app/classifier";
import { type Change, defaultPolicy, RepoPolicy } from "@app/domain";
import { describe, expect, it } from "vitest";
import { MemoryKv } from "../../src/change-coordinator.js";
import { createFakeEnvironment } from "../../src/fakes/index.js";
import { changeFlagKey, isChangeEnabled } from "../../src/flags-helper.js";
import { changeWorkflowId, ciRunIdFor, revertIdFor } from "../../src/ids.js";
import { normalizeIssue } from "../../src/issues.js";
import { changeVersion, milestoneState } from "../../src/milestones.js";
import {
  escalateForPolicy,
  parsePolicyExport,
  restrictForClaim,
  withLane0Toggle,
} from "../../src/policy.js";
import { parsePushEvent } from "../../src/push-router.js";
import { createRunSink, toPipelineRun } from "../../src/run-sink.js";
import { fromWorkflowStep, waitOrTimeout } from "../../src/step.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("parsePushEvent", () => {
  const event = {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts.repo", namespace: "gittifacts-eu", repoName: "task-x" },
    payload: {
      ref: "refs/heads/main",
      before: SHA_A,
      after: SHA_B,
      commits: [],
      totalCommitsCount: 1,
      extra: true,
    },
    metadata: { accountId: "acc", eventSchemaVersion: 1 },
  };
  it("accepts the documented shape and ignores unknown fields", () => {
    expect(parsePushEvent(event, "gittifacts-eu")).toEqual({
      ok: true,
      namespace: "gittifacts-eu",
      repoName: "task-x",
      ref: "refs/heads/main",
      before: SHA_A,
      after: SHA_B,
    });
  });
  it("accepts repo_name", () => {
    expect(
      parsePushEvent({ ...event, source: { namespace: "gittifacts-eu", repo_name: "task-y" } }),
    ).toMatchObject({ ok: true, repoName: "task-y" });
  });
  it.each([
    ["another event type", { ...event, type: "cf.artifacts.repo.forked" }],
    ["another namespace", { ...event, source: { ...event.source, namespace: "keelhaul" } }],
    ["a bad sha", { ...event, payload: { ...event.payload, after: "nope" } }],
    ["no repo name", { ...event, source: { namespace: "gittifacts-eu" } }],
    ["garbage", 42],
  ])("rejects %s", (_n, raw) => {
    expect(parsePushEvent(raw, "gittifacts-eu").ok).toBe(false);
  });
});

describe("normalizeIssue", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  it("reads the Notifications envelope leniently", () => {
    const n = normalizeIssue(
      {
        name: "p",
        text: "summary",
        ts: 1790870150,
        alert_event: "ALERT_STATE_EVENT_START",
        alert_correlation_id: "corr",
        data: {
          issue: { id: "iss", title: "TypeError" },
          service: "api",
          scriptVersion: { id: "ver-1", tag: "chg123" },
          count: "7",
          firstObserved: 1790870000,
          url: "https://dash.cloudflare.com/x",
        },
      },
      now,
    );
    expect(n).toMatchObject({
      scriptName: "api",
      resolved: false,
      issue: {
        id: "iss",
        title: "TypeError",
        versionId: "ver-1",
        changeId: "chg123",
        count: 7,
        url: "https://dash.cloudflare.com/x",
      },
    });
    expect(n?.issue.firstSeen).toBe(new Date(1790870000 * 1000).toISOString());
  });
  it("accepts a bare issue and marks resolved alerts", () => {
    expect(
      normalizeIssue(
        { id: "i", service: "w", title: "t", alert_event: "ALERT_STATE_EVENT_END" },
        now,
      ),
    ).toMatchObject({ resolved: true, issue: { id: "i", count: 1, firstSeen: now.toISOString() } });
    expect(normalizeIssue({ title: "no id" }, now)).toBeNull();
    expect(normalizeIssue(null, now)).toBeNull();
  });
});

describe("policy from base", () => {
  it("no file → defaults (+ toggle); invalid → error; lane0 toggle is platform-owned", () => {
    expect(parsePolicyExport(null, true)).toEqual({
      policy: { ...defaultPolicy(), lane0Enabled: true },
      source: "default",
    });
    expect(parsePolicyExport({ thresholds: { lane0MaxFiles: -1 } }, true)).toHaveProperty("error");
    // A file cannot turn Lane 0 on…
    expect(
      withLane0Toggle(RepoPolicy.parse({ lane0Enabled: true }), { lane0Enabled: true }, false)
        .lane0Enabled,
    ).toBe(false);
    // …but it can force it off.
    expect(withLane0Toggle(RepoPolicy.parse({}), { lane0Enabled: false }, true).lane0Enabled).toBe(
      false,
    );
    expect(withLane0Toggle(RepoPolicy.parse({}), {}, true).lane0Enabled).toBe(true);
  });
  it("unclaimed projects lose Lane 0 and verified-revert auto-merge", () => {
    const p = RepoPolicy.parse({ lane0Enabled: true, autoMergeVerifiedReverts: true });
    expect(restrictForClaim(p, "unclaimed")).toMatchObject({
      lane0Enabled: false,
      autoMergeVerifiedReverts: false,
    });
    expect(restrictForClaim(p, "claimed")).toBe(p);
  });
  it("an unavailable policy raises Lane 0 to 1 but keeps computedLane", () => {
    const result = classify(
      null,
      defaultPolicy(),
      null,
      null,
      { category: "fix" },
      {
        ciStatus: "passed",
        evidenceVerified: true,
        budgetExceeded: false,
        tourStatus: "not-generated",
        pureRevertVerified: false,
      },
    );
    const fake = { ...result, lane: 0 as const, computedLane: 0 as const };
    const raised = escalateForPolicy(fake, {
      policy: defaultPolicy(),
      source: "unavailable",
      error: "boom",
    });
    expect(raised).toMatchObject({ lane: 1, computedLane: 0 });
    expect(raised.reasons[0]?.code).toBe("policy.unavailable");
    expect(escalateForPolicy(fake, { policy: defaultPolicy(), source: "file", error: null })).toBe(
      fake,
    );
  });
});

describe("milestones", () => {
  const base: Change = {
    id: "c",
    repoId: "r",
    planId: null,
    title: "t",
    claim: { category: "fix", summary: null },
    baseSha: SHA_A,
    headSha: SHA_B,
    forkName: "task-c",
    authorId: "a",
    status: "running",
    computedLane: null,
    lane: null,
    laneReasons: [],
    evidenceId: null,
    tourId: null,
    flagKey: null,
    mergedSha: null,
    rolloutState: null,
    revertOf: null,
    revertedBy: null,
    agentTraceId: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
  };
  it.each([
    ["evidence_ready", {}, "pending"],
    ["evidence_ready", { evidenceId: "ev" }, "reached"],
    ["lane_assigned", { lane: 1 }, "reached"],
    ["tour_ready", { lane: 1, status: "awaiting-review" }, "pending"],
    ["tour_ready", { lane: 1, tourId: "t" }, "reached"],
    ["tour_ready", { lane: 0, status: "queued" }, "unreachable"],
    ["tour_ready", { lane: 2, status: "failing" }, "unreachable"],
    ["merged", { mergedSha: SHA_B, status: "merged" }, "reached"],
    ["merged", { status: "abandoned" }, "unreachable"],
    ["reverted", { status: "reverted" }, "reached"],
    ["reverted", { status: "released", mergedSha: SHA_B }, "pending"],
  ] as const)("%s with %j → %s", (until, patch, expected) => {
    expect(milestoneState({ ...base, ...patch } as Change, until)).toBe(expected);
  });
  it("versions change with any field", () => {
    expect(changeVersion(base)).toBe(changeVersion({ ...base }));
    expect(changeVersion(base)).not.toBe(changeVersion({ ...base, lane: 1 }));
  });
});

describe("run sink", () => {
  it("persists every run and forwards only the current head's full run", async () => {
    const env = createFakeEnvironment({ runWorkflows: false });
    const repo = await env.seedRepo();
    const change: Change = {
      ...({} as Change),
      id: "c1",
      repoId: repo.id,
      planId: null,
      title: "t",
      claim: { category: "fix", summary: null },
      baseSha: SHA_A,
      headSha: SHA_B,
      forkName: "task-c1",
      authorId: "a",
      status: "running",
      computedLane: null,
      lane: null,
      laneReasons: [],
      evidenceId: null,
      tourId: null,
      flagKey: null,
      mergedSha: null,
      rolloutState: null,
      revertOf: null,
      revertedBy: null,
      agentTraceId: null,
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
    };
    await env.ports.store.insertChange(change);
    const instanceId = changeWorkflowId("c1", SHA_B);
    const instance = await env.bindings.changeWorkflow.create({
      id: instanceId,
      params: { changeId: "c1", headSha: SHA_B },
    });
    const sink = createRunSink(env.ports, env.bindings);
    const summary = {
      id: ciRunIdFor(instanceId),
      changeId: "c1",
      headSha: SHA_B,
      baseSha: SHA_A,
      engine: "workflows",
      status: "passed",
      startedAt: null,
      finishedAt: "2026-10-01T12:05:00.000Z",
      steps: [
        {
          name: "install",
          kind: "user",
          status: "passed",
          durationMs: 5,
          logRef: "logs/1",
          cacheHit: true,
        },
        { name: "x", kind: "evidence", status: "errored", durationMs: null, logRef: null },
      ],
      pipelineSource: "default",
      warnings: [],
      evidence: [{ kind: "nonsense" }],
      evidenceErrors: [{ step: "evidence:mutation", message: "stryker crashed" }],
      usage: { computeMs: 1 },
    };
    expect(await sink.onRunFinished(summary)).toEqual({
      accepted: true,
      forwarded: true,
      reason: null,
    });
    expect(instance.received[0]).toMatchObject({
      type: "ci-finished",
      payload: {
        run: { status: "passed", steps: [{ status: "cached" }, { status: "failed" }] },
        evidenceErrors: [{ step: "evidence:mutation" }],
      },
    });
    expect(await env.ports.store.getRun(summary.id)).toMatchObject({ status: "passed" });

    expect(
      await sink.onRunFinished({ ...summary, id: `mq-c1-${SHA_B.slice(0, 12)}` }),
    ).toMatchObject({ forwarded: false });
    await env.ports.store.updateChange("c1", { headSha: SHA_A });
    expect(await sink.onRunFinished(summary)).toMatchObject({
      forwarded: false,
      reason: "head superseded",
    });
    expect(await sink.onRunFinished({ nope: true })).toMatchObject({ accepted: false });
    expect(toPipelineRun({ ...summary, status: "weird", steps: [] }).status).toBe("errored");
  });
});

describe("ChangeCoordinator idempotency keys and spend", () => {
  it("claims a key once per TTL and releases on failure", async () => {
    const env = createFakeEnvironment({ runWorkflows: false });
    const c = env.bindings.changeCoordinator("c");
    expect(await c.claimKey({ changeId: "c", key: "k", ttlMs: 1000 })).toBe(true);
    expect(await c.claimKey({ changeId: "c", key: "k", ttlMs: 1000 })).toBe(false);
    await c.releaseKey({ changeId: "c", key: "k" });
    expect(await c.claimKey({ changeId: "c", key: "k", ttlMs: 1000 })).toBe(true);
    env.ports.clock.advance(1001);
    expect(await c.claimKey({ changeId: "c", key: "k", ttlMs: 1000 })).toBe(true);
    expect(await c.recordSpend({ changeId: "c", usd: 0.1 })).toBeCloseTo(0.1);
    expect(await c.recordSpend({ changeId: "c", usd: -5 })).toBeCloseTo(0.1);
    expect(await c.spent("c")).toBeCloseTo(0.1);
    await expect(
      c.scheduleForkGc({ changeId: "c", forkName: "main-repo", delayMs: 0 }),
    ).rejects.toThrow(/not a fork/);
    expect(new MemoryKv()).toBeDefined();
  });
});

describe("ids, flags helper, step adapter", () => {
  it("derives stable ids", () => {
    expect(changeWorkflowId("abc", SHA_B)).toBe("abc-bbbbbbbbbbbb");
    expect(revertIdFor("abc")).toBe("rv-abc");
    expect(revertIdFor("x".repeat(64)).length).toBeLessThanOrEqual(64);
    expect(revertIdFor("x".repeat(64))).toBe(revertIdFor("x".repeat(64)));
  });

  it("isChangeEnabled: missing flag → true, disabled → false, errors → true", async () => {
    const flags = new Map<string, boolean>([[changeFlagKey("off"), false]]);
    const binding = {
      getBooleanValue: async (key: string, dflt: boolean) => {
        if (key === "change-boom") throw new Error("flagship down");
        return flags.get(key) ?? dflt;
      },
    };
    expect(await isChangeEnabled(binding, "missing")).toBe(true);
    expect(await isChangeEnabled(binding, "off", { targetingKey: "u1" })).toBe(false);
    expect(await isChangeEnabled(binding, "boom")).toBe(true);
  });

  it("fromWorkflowStep forwards to the engine step; waitOrTimeout maps rejection to null", async () => {
    const calls: string[] = [];
    const engine = {
      do: async (name: string, _c: unknown, cb: () => Promise<unknown>) => {
        calls.push(name);
        return cb();
      },
      sleep: async (name: string) => void calls.push(`sleep:${name}`),
      waitForEvent: async (name: string) => {
        calls.push(`wait:${name}`);
        throw new Error("timed out");
      },
    };
    const step = fromWorkflowStep(engine as never);
    expect(await step.do("a", {}, async () => 1)).toBe(1);
    await step.sleep("s", "1 minute");
    expect(await waitOrTimeout(step, "w", "review", "1 day")).toBeNull();
    expect(calls).toEqual(["a", "sleep:s", "wait:w"]);
  });
});
