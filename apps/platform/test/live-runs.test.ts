/**
 * Runs in flight show their steps live (queued / running with elapsed / passed / failed) from the
 * CI engine's R2 records; D1 only has them once the run finishes (M5 friction 10: `steps: []`).
 */
import { env } from "cloudflare:workers";
import type { PipelineRun } from "@app/domain";
import { describe, expect, it } from "vitest";
import { liveStep, withLiveSteps } from "../src/services/live-runs.js";
import { addMember, HEAD_SHA, runFixture, seedWorld, store } from "./fixtures.js";
import { call, createAgent, json, makeApp, signUpHuman } from "./http.js";

const bucket = env.CI_BUCKET;
const BASE_SHA = "b".repeat(40);

async function engineRecords(runId: string, changeId: string, startedAt: string) {
  const put = (key: string, value: unknown) => bucket.put(key, JSON.stringify(value));
  await put(`ci-runs/${runId}/run.json`, {
    v: 1,
    runId,
    changeId,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    engine: "workflows",
    createdAt: startedAt,
  });
  await put(`ci-runs/${runId}/pipeline.json`, {
    v: 1,
    source: "default",
    pipeline: {
      version: 1,
      source: "default",
      steps: [
        { name: "install", command: "pnpm install", parent: null, after: [] },
        { name: "test", command: "pnpm test", parent: "install", after: [] },
      ],
      warnings: [],
    },
    evidenceSteps: [
      {
        name: "evidence:test-run",
        command: "gittifacts-runner evidence test-run",
        parent: "install",
        requiresGreen: false,
      },
    ],
    resolvedAt: startedAt,
  });
  const step = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
    v: 1,
    name,
    kind: "user",
    status,
    durationMs: null,
    logRef: `ci-logs/${runId}/${name}.log`,
    cacheHit: false,
    exitCode: null,
    startedAt,
    finishedAt: null,
    ...extra,
  });
  await put(`ci-runs/${runId}/steps/install.json`, step("install", "passed", { durationMs: 4200 }));
  await put(`ci-runs/${runId}/steps/test.json`, step("test", "running"));
}

describe("live run steps", () => {
  it("maps engine steps: queued → pending, cache hits → cached, elapsed for running steps", () => {
    const now = Date.parse("2026-10-03T10:00:30Z");
    const base = { kind: "user" as const, durationMs: null, logRef: null };
    expect(liveStep({ ...base, name: "a", status: "queued", startedAt: null }, now)).toMatchObject({
      status: "pending",
      startedAt: null,
    });
    expect(
      liveStep({ ...base, name: "b", status: "running", startedAt: "2026-10-03T10:00:00Z" }, now),
    ).toMatchObject({ status: "running", elapsedMs: 30_000 });
    expect(
      liveStep({ ...base, name: "c", status: "passed", durationMs: 900, cacheHit: true }, now),
    ).toMatchObject({ status: "cached", elapsedMs: 900 });
    expect(liveStep({ ...base, name: "d", status: "errored" }, now).status).toBe("failed");
  });

  it("leaves finished runs alone and falls back to the stored run without records", async () => {
    const done = runFixture("chg_x");
    const running: PipelineRun = { ...runFixture("chg_x"), status: "running", steps: [] };
    expect(await withLiveSteps(bucket, [done, running], Date.now())).toEqual([done, running]);
  });

  it("GET /changes/:id serves the steps of a running run while it is in flight", async () => {
    const { app } = makeApp({});
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const s = store();
    const { repo, change } = await seedWorld(s);
    await addMember(s, repo.id, human.principal.id, "owner");
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const run = runFixture(change.id, { status: "running", finishedAt: null, steps: [] });
    await s.upsertRun(run);
    await engineRecords(run.id, change.id, startedAt);

    const body = await json<{ runs: PipelineRun[] }>(
      await call(app, "GET", `/api/v1/changes/${change.id}`, { token: agent.token }),
    );
    const steps = body.runs[0]?.steps ?? [];
    expect(steps.map((st) => [st.name, st.status])).toEqual([
      ["install", "passed"],
      ["test", "running"],
      ["evidence:test-run", "pending"],
    ]);
    expect(steps[1]?.elapsedMs).toBeGreaterThanOrEqual(89_000);
    expect(steps[0]).toMatchObject({ durationMs: 4200, elapsedMs: 4200 });
  });
});
