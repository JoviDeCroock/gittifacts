import { describe, expect, it } from "vitest";
import type { EvalConfig } from "../../src/env.js";
import { MODELS } from "../../src/models.js";
import { redact, redactDeep } from "../../src/redact.js";
import { keys, matrixIdOf, newMatrixId, ResultStore, runIdFor } from "../../src/store.js";
import {
  type InstanceStatus,
  type MatrixDeps,
  type MatrixParams,
  planRuns,
  runMatrixCore,
} from "../../src/workflows/matrix-core.js";
import { stubResult } from "../../src/workflows/run-core.js";
import { ADMIN_TOKEN, FakePlatform, fakePlatformFetch, HOST, SUFFIX } from "../fake-platform.js";
import { FakeBucket } from "../fake-r2.js";
import { cachingStep, FakeClock } from "../fakes.js";

const cfg: EvalConfig = {
  host: HOST,
  previewSuffix: SUFFIX,
  gatewayId: "g",
  importRepoUrl: "https://github.com/x/y",
  runsPerCell: 2,
  concurrency: 3,
  maxToolCalls: 60,
  maxWallMs: 900_000,
  tokenBudget: 1_500_000,
  checkGraceMs: 0,
};

const params: MatrixParams = {
  matrixId: "m-20261003-030000-abcd",
  trigger: "cron",
  createdAt: new Date().toISOString(),
  tasks: ["t1", "t2", "t3", "t4"],
  models: MODELS.map((m) => m.id),
  runsPerCell: 2,
  concurrency: 3,
};

function setup(
  behave: (runId: string, tick: number) => InstanceStatus | "report" = () => "report",
) {
  const platform = new FakePlatform();
  const bucket = new FakeBucket();
  const store = new ResultStore(bucket.asR2());
  const f = fakePlatformFetch(platform);
  const started: string[] = [];
  const inFlightAtStart: number[] = [];
  let tick = 0;
  const statuses = new Map<string, InstanceStatus>();
  const deps: MatrixDeps = {
    cfg,
    store,
    step: cachingStep(new FakeClock(Date.now(), 0)),
    sleep: async () => {
      tick++;
      // Every started run moves on according to the scenario.
      for (const id of started) {
        if (statuses.get(id) !== "running") continue;
        const b = behave(id, tick);
        if (b === "report") {
          const plan = planRuns(params).find((r) => r.runId === id)!;
          await store.putRun({
            ...stubResult(
              { ...plan, matrixId: params.matrixId, task: plan.task },
              MODELS.find((m) => m.id === plan.model),
              "final",
              "",
            ),
            success: true,
          });
          statuses.set(id, "complete");
        } else statuses.set(id, b);
      }
    },
    fetcher: f,
    adminFetcher: f,
    adminToken: ADMIN_TOKEN,
    startRun: async (p) => {
      inFlightAtStart.push([...statuses.values()].filter((s) => s === "running").length);
      started.push(p.runId);
      statuses.set(p.runId, "running");
    },
    runStatus: async (id) => ({ status: statuses.get(id) ?? "unknown" }),
    stopRun: async (id) => {
      statuses.set(id, "terminated");
    },
  };
  return { platform, bucket, store, deps, started, inFlightAtStart };
}

describe("planRuns", () => {
  it("interleaves attempts so the first wave covers every task × model", () => {
    const runs = planRuns(params);
    expect(runs).toHaveLength(16);
    expect(runs.slice(0, 8).map((r) => `${r.task}/${r.runId.split("--")[2]}`)).toEqual([
      "t1/kimi",
      "t1/gptoss",
      "t2/kimi",
      "t2/gptoss",
      "t3/kimi",
      "t3/gptoss",
      "t4/kimi",
      "t4/gptoss",
    ]);
    expect(runs[0]!.runId).toBe("m-20261003-030000-abcd--t1--kimi--r1");
    expect(matrixIdOf(runs[0]!.runId)).toBe(params.matrixId);
  });
});

describe("runMatrixCore", () => {
  it("runs everything with bounded concurrency, sweeps, summarizes, and writes the sweep last", async () => {
    const s = setup();
    const out = await runMatrixCore(params, s.deps);
    expect(s.started).toHaveLength(16);
    expect(Math.max(...s.inFlightAtStart)).toBeLessThanOrEqual(2);
    expect(out).toMatchObject({ matrixId: params.matrixId, runs: 16 });
    const view = await s.store.view(params.matrixId);
    expect(view?.complete).toBe(true);
    expect(view?.runs).toHaveLength(16);
    expect(view?.sweep).toMatchObject({ complete: true, violations: [] });
    expect(s.bucket.writes.at(-1)).toBe(keys.sweep(params.matrixId));
    expect(s.bucket.objects.has(keys.summary(params.matrixId))).toBe(true);
  });

  it("records runs whose Workflow errored as infra-error", async () => {
    const s = setup((id) => (id.endsWith("--t3--kimi--r1") ? "errored" : "report"));
    await runMatrixCore(params, s.deps);
    const r = await s.store.getRun(runIdFor(params.matrixId, "t3", "kimi", 1));
    expect(r).toMatchObject({ stop: "infra-error", note: "run workflow errored", success: false });
  });

  it("blocks every run without starting any when credential-less creation is off", async () => {
    const s = setup();
    s.platform.anonymousAvailable = false;
    const out = await runMatrixCore(params, s.deps);
    expect(s.started).toEqual([]);
    expect(out.pass).toBe(false);
    const runs = await s.store.listRuns(params.matrixId);
    expect(runs).toHaveLength(16);
    expect(new Set(runs.map((r) => r.stop))).toEqual(new Set(["blocked"]));
  });
});

describe("ids and redaction", () => {
  it("matrix ids sort by time and are valid instance ids", () => {
    const a = newMatrixId(Date.parse("2026-10-03T03:00:00Z"), () => 0.5);
    expect(a).toMatch(/^m-20261003-030000-[0-9a-z]{4}$/);
    expect(newMatrixId(Date.parse("2026-10-04T03:00:00Z")) > a).toBe(true);
  });

  it("redacts platform tokens, bearer headers, token fields and URL credentials", () => {
    const text = [
      "Authorization: Bearer gtf_abcdefghijklmnop",
      '{"token":"gtf_unclaimed_xyz123456","remote":{"token":"art_v1_secretsecret"}}',
      "git push https://x:supersecret@acct.artifacts.cloudflare.net/git/ns/task-1.git",
      "https://host/clone?token=abcdef123456&expires=1",
    ].join("\n");
    const out = redact(text);
    expect(out).not.toMatch(/abcdefghijklmnop|unclaimed_xyz|secretsecret|supersecret|abcdef123456/);
    expect(redactDeep({ a: ["Bearer abcdefghijkl"] })).toEqual({ a: ["Bearer [redacted]"] });
  });
});
