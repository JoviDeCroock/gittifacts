/**
 * Durable Runner jobs (runner/client.ts): `start` returns at once, `poll` long-polls, a retry
 * re-attaches to the running job, and a step whose polls are lost survives without a restart.
 */
import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type RunRequest, RunSummary } from "../../src/engine.js";
import { RunnerJobState } from "../../src/runner/client.js";
import { RunnerOutcome } from "../../src/runner/job.js";
import { WorkflowsCiEngine } from "../../src/workflows/engine.js";
import type { TestEnv } from "./entry.js";
import { type FakeEvent, SHAS } from "./fakes.js";

const e = env as unknown as TestEnv;
const engine = new WorkflowsCiEngine({
  workflow: e.CI_RUN_WORKFLOW,
  bucket: e.CI_BUCKET,
  runners: e.RUNNER,
});

function job(runId: string, step: string, command: string) {
  return {
    runId,
    step,
    kind: "user" as const,
    command,
    instance: "lite" as const,
    timeoutSeconds: 60,
    artifactsRepo: "fork-1",
    remote: "https://example.com/r.git",
    headSha: SHAS.head,
    from: { kind: "image" as const },
    snapshot: false,
    logKey: `ci-logs/${runId}/${step}.log`,
  };
}

async function events(runId: string, step: string): Promise<FakeEvent[]> {
  const list = await e.CI_BUCKET.list({ prefix: `fake-events/${runId}:${step}/` });
  const keys = list.objects.map((o) => o.key).sort();
  return Promise.all(
    keys.map(
      async (k) => JSON.parse((await (await e.CI_BUCKET.get(k))?.text()) ?? "{}") as FakeEvent,
    ),
  );
}

const starts = async (runId: string, step: string) =>
  (await events(runId, step)).filter((x) => x.kind === "start").length;

describe("Runner durable jobs", () => {
  it("start returns at once; poll long-polls until the job is done", async () => {
    const stub = e.RUNNER.getByName("dur1:s");
    const t0 = Date.now();
    const started = RunnerJobState.parse(
      await stub.start({ jobId: "main", job: job("dur1", "s", "fake:sleep=400 fake:out=hi") }),
    );
    expect(started).toMatchObject({ state: "running", jobId: "main" });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(RunnerJobState.parse(await stub.poll("main"))).toMatchObject({ state: "running" });
    const done = RunnerJobState.parse(await stub.poll("main", 10_000));
    expect(done).toMatchObject({ state: "done", launch: 1 });
    if (done.state !== "done") throw new Error("unreachable");
    expect(RunnerOutcome.parse(done.outcome)).toMatchObject({ ok: true, exitCode: 0 });
    expect(RunnerJobState.parse(await stub.poll("nope"))).toEqual({
      state: "unknown",
      jobId: "nope",
    });
  });

  it("a second start with the same id re-attaches (running, then finished) and never restarts", async () => {
    const stub = e.RUNNER.getByName("dur2:s");
    const input = { jobId: "main", job: job("dur2", "s", "fake:sleep=300") };
    await stub.start(input);
    expect(RunnerJobState.parse(await stub.start(input))).toMatchObject({
      state: "running",
      attached: true,
    });
    await stub.poll("main", 10_000);
    expect(RunnerJobState.parse(await stub.start(input))).toMatchObject({
      state: "done",
      attached: true,
      launch: 1,
    });
    expect(await starts("dur2", "s")).toBe(1);
  });

  it("a failed (infrastructure) outcome is started again as a new launch", async () => {
    const stub = e.RUNNER.getByName("dur3:s");
    const input = { jobId: "main", job: job("dur3", "s", "fake:crash") };
    await stub.start(input);
    const first = RunnerJobState.parse(await stub.poll("main", 10_000));
    expect(first).toMatchObject({ state: "done", launch: 1 });
    await stub.start(input);
    expect(RunnerJobState.parse(await stub.poll("main", 10_000))).toMatchObject({
      state: "done",
      launch: 2,
    });
    expect(await starts("dur3", "s")).toBe(2);
  });

  it("reports a job it no longer runs (the object restarted) as lost", async () => {
    const stub = e.RUNNER.getByName("dur4:s");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("jobrec:main", {
        state: "running",
        launch: 1,
        startedAt: new Date().toISOString(),
      });
    });
    expect(RunnerJobState.parse(await stub.poll("main"))).toMatchObject({ state: "lost" });
  });

  it("clearAbort forgets finished jobs so a restarted step runs again", async () => {
    const stub = e.RUNNER.getByName("dur5:s");
    const input = { jobId: "main", job: job("dur5", "s", "fake:exit=0") };
    await stub.start(input);
    await stub.poll("main", 10_000);
    await stub.clearAbort();
    expect(RunnerJobState.parse(await stub.start(input))).toMatchObject({ state: "running" });
    await stub.poll("main", 10_000);
    expect(await starts("dur5", "s")).toBe(2);
  });

  it("refuses invalid start requests without starting a container", async () => {
    const stub = e.RUNNER.getByName("dur6:s");
    const res = RunnerJobState.parse(await stub.start({ jobId: "main", job: { step: 1 } }));
    expect(res.state).toBe("done");
    if (res.state !== "done") throw new Error("unreachable");
    expect(RunnerOutcome.parse(res.outcome)).toMatchObject({ ok: false, code: "invalid-job" });
    expect(await events("dur6", "s")).toEqual([]);
  });
});

describe("CiRunWorkflow with lost connections", () => {
  it("a step whose first attempt loses every poll re-attaches on retry instead of restarting", async () => {
    const req: RunRequest = {
      runId: "dropped",
      changeId: "chg-dropped",
      repo: { remote: "https://example.com/r.git", tokenProvider: "artifacts" },
      artifactsRepo: "fork-1",
      headSha: SHAS.head,
      baseSha: SHAS.base,
      limits: { maxMinutes: 30 },
      evidenceSteps: [],
      pipeline: {
        version: 1,
        source: "file",
        steps: [
          { name: "drop-long", command: "fake:sleep=1500 fake:out=done", parent: null, after: [] },
        ],
        warnings: [],
      },
    };
    await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
    await inst.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await engine.start(req);
    await inst.waitForStatus("complete");
    expect(await inst.getOutput()).toMatchObject({ status: "passed" });
    expect(await starts("dropped", "drop-long")).toBe(1);
    const summary = RunSummary.parse(
      JSON.parse((await (await e.CI_BUCKET.get("ci-runs/dropped/summary.json"))?.text()) ?? "null"),
    );
    const st = summary.steps.find((s) => s.name === "drop-long");
    expect(st).toMatchObject({ status: "passed" });
    expect(st?.reason).toContain("re-attached to the running job (main)");
    expect(summary.usage.containers).toBe(1);
  });
});
