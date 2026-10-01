import { describe, expect, it } from "vitest";
import {
  type CiRunParams,
  deriveRunId,
  InvalidRunRequestError,
  RunConflictError,
  RunNotFoundError,
  type RunRequest,
  type RunSummary,
} from "../../src/engine.js";
import type { StepSpec } from "../../src/plan/spec.js";
import { buildRunStatus, RunKeys, writeStepRecord } from "../../src/run-store.js";
import { CiEngineConfigError, selectCiEngine } from "../../src/select.js";
import { writeJson } from "../../src/storage.js";
import { WorkflowsCiEngine } from "../../src/workflows/engine.js";
import { FakeRunners, FakeWorkflow } from "./fake-workflow.js";
import { MemoryStore, SHA_A, SHA_B, SHA_C } from "./helpers.js";

const step = (name: string, parent: string | null = null, after: string[] = []): StepSpec => ({
  name,
  command: `run ${name}`,
  parent,
  after,
});

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  runId: "run-1",
  changeId: "chg-1",
  repo: { remote: "https://x/r.git", tokenProvider: "artifacts" },
  artifactsRepo: "fork-1",
  headSha: SHA_A,
  baseSha: SHA_B,
  pipeline: {
    version: 1,
    source: "file",
    steps: [step("install"), step("test", "install"), step("build", "install", ["test"])],
    warnings: [],
  },
  evidenceSteps: [
    { name: "evidence:coverage", command: "cov", parent: "install", requiresGreen: true },
  ],
  budget: { maxMinutes: 60 },
  ...overrides,
});

function setup() {
  const workflow = new FakeWorkflow<CiRunParams>();
  const bucket = new MemoryStore();
  const runners = new FakeRunners();
  const engine = new WorkflowsCiEngine({ workflow, bucket, runners, cancelTimeoutMs: 50 });
  return { workflow, bucket, runners, engine };
}

const stepStatus = (name: string, status: "passed" | "failed" | "running" | "skipped") => ({
  name,
  kind: "user" as const,
  status,
  durationMs: null,
  logRef: null,
  cacheHit: false,
  exitCode: null,
  startedAt: null,
  finishedAt: null,
});

describe("WorkflowsCiEngine (fake bindings)", () => {
  it("start validates, records and creates exactly one instance", async () => {
    const { workflow, bucket, engine } = setup();
    await expect(engine.start({ ...request(), headSha: "nope" })).rejects.toBeInstanceOf(
      InvalidRunRequestError,
    );
    expect(await engine.start(request())).toEqual({ runId: "run-1" });
    expect(await engine.start(request())).toEqual({ runId: "run-1" });
    expect(workflow.creates).toBe(1);
    expect(workflow.instances.get("run-1")?.params).toMatchObject({
      pipelineFrom: "base",
      changeId: "chg-1",
    });
    expect(bucket.data.has(RunKeys.run("run-1"))).toBe(true);
    expect(bucket.data.has(RunKeys.pipeline("run-1"))).toBe(true);
    await expect(engine.start(request({ headSha: SHA_C }))).rejects.toBeInstanceOf(
      RunConflictError,
    );
  });

  it("recovers when the record exists but the instance was never created", async () => {
    const { workflow, bucket, engine } = setup();
    await writeJson(bucket, RunKeys.run("run-1"), {
      v: 1,
      runId: "run-1",
      changeId: "chg-1",
      headSha: SHA_A,
      baseSha: SHA_B,
      engine: "workflows",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await engine.start(request());
    expect(workflow.instances.has("run-1")).toBe(true);
  });

  it("folds records and instance status into RunStatus", async () => {
    const { workflow, bucket, engine } = setup();
    await expect(engine.status("missing")).rejects.toBeInstanceOf(RunNotFoundError);
    await engine.start(request());
    const inst = workflow.instances.get("run-1")!;

    let s = await engine.status("run-1");
    expect(s.status).toBe("queued");
    expect(s.steps.map((x) => [x.name, x.kind, x.status])).toEqual([
      ["install", "user", "queued"],
      ["test", "user", "queued"],
      ["build", "user", "queued"],
      ["evidence:coverage", "evidence", "queued"],
    ]);

    inst.state = { status: "running" };
    await writeStepRecord(bucket, "run-1", stepStatus("install", "passed"));
    await writeStepRecord(bucket, "run-1", stepStatus("test", "running"));
    s = await engine.status("run-1");
    expect(s.status).toBe("running");
    expect(s.steps.map((x) => x.status)).toEqual(["passed", "running", "queued", "queued"]);

    inst.state = { status: "errored", error: { name: "Error", message: "boom" } };
    s = await engine.status("run-1");
    expect(s).toMatchObject({ status: "failed", error: "boom" });
    expect(s.steps.map((x) => x.status)).toEqual(["passed", "cancelled", "cancelled", "cancelled"]);

    inst.state = {
      status: "complete",
      output: {
        status: "passed",
        finishedAt: "2026-10-01T00:10:00.000Z",
        steps: [],
        evidenceItems: 0,
      },
    };
    expect((await engine.status("run-1")).status).toBe("passed");
    inst.state = { status: "complete", output: { conclusion: "success" } };
    expect(await engine.status("run-1")).toMatchObject({
      status: "failed",
      error: /without a summary/,
    });

    const summary: RunSummary = {
      ...(await engine.status("run-1")),
      status: "passed",
      finishedAt: "2026-10-01T00:10:00.000Z",
      steps: [],
      evidence: [],
      evidenceErrors: [],
      usage: {
        computeMs: 0,
        ciMinutes: 0,
        byInstance: {},
        containers: 0,
        cacheHits: 0,
        logBytes: 0,
      },
      timings: { totalMs: 600_000 },
    };
    delete summary.error;
    await writeJson(bucket, RunKeys.summary("run-1"), summary);
    expect(await engine.status("run-1")).toMatchObject({ status: "passed", steps: [] });
  });

  it("cancel records the reason, terminates, aborts every runner and is idempotent", async () => {
    const { workflow, bucket, runners, engine } = setup();
    await engine.start(request());
    workflow.instances.get("run-1")!.state = { status: "running" };
    await engine.cancel("run-1", "superseded by run-2");
    expect(workflow.instances.get("run-1")?.terminated).toBe(1);
    expect(runners.aborted.sort()).toEqual(
      [
        "run-1:build",
        "run-1:evidence:coverage",
        "run-1:install",
        "run-1:plan",
        "run-1:test",
      ].sort(),
    );
    const s = await engine.status("run-1");
    expect(s.status).toBe("superseded");
    expect(s.finishedAt).not.toBeNull();
    await engine.cancel("run-1", "again");
    expect(JSON.parse(bucket.data.get(RunKeys.cancel("run-1"))!)).toMatchObject({
      reason: "superseded by run-2",
    });
    await engine.cancel("unknown-run", "x");
  });

  it("cancel does not wait forever for unresponsive runners and skips finished runs", async () => {
    const { workflow, bucket, runners, engine } = setup();
    await engine.start(request());
    runners.hang = true;
    const t0 = Date.now();
    await engine.cancel("run-1", "user asked");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await engine.status("run-1")).status).toBe("cancelled");

    await engine.start(request({ runId: "run-2" }));
    await writeJson(bucket, RunKeys.summary("run-2"), { not: "checked here" });
    await engine.cancel("run-2", "late");
    expect(workflow.instances.get("run-2")?.terminated).toBe(0);
  });

  it("restartFrom clears the step, its dependents and evidence, then restarts from it", async () => {
    const { workflow, bucket, runners, engine } = setup();
    await engine.start(request());
    for (const [n, st] of [
      ["install", "passed"],
      ["test", "failed"],
      ["build", "skipped"],
    ] as const) {
      await writeStepRecord(bucket, "run-1", stepStatus(n, st));
    }
    await writeJson(bucket, RunKeys.summary("run-1"), {});
    await engine.restartFrom("run-1", "test");
    const inst = workflow.instances.get("run-1")!;
    expect(inst.restarts).toEqual([{ from: { name: "test" } }]);
    expect(bucket.data.has(RunKeys.summary("run-1"))).toBe(false);
    expect(bucket.data.has(RunKeys.step("run-1", "install"))).toBe(true);
    expect(bucket.data.has(RunKeys.step("run-1", "test"))).toBe(false);
    expect(runners.cleared.sort()).toEqual([
      "run-1:build",
      "run-1:evidence:coverage",
      "run-1:test",
    ]);

    // A skipped step restarts from its failed ancestor.
    await writeStepRecord(bucket, "run-1", stepStatus("test", "failed"));
    await writeStepRecord(bucket, "run-1", stepStatus("build", "skipped"));
    await engine.restartFrom("run-1", "build");
    expect(inst.restarts.at(-1)).toEqual({ from: { name: "test" } });

    await engine.restartFrom("run-1", "evidence:coverage");
    expect(inst.restarts.at(-1)).toEqual({ from: { name: "evidence:coverage" } });
    await engine.restartFrom("run-1", "plan");
    expect(inst.restarts.at(-1)).toEqual({ from: { name: "plan" } });
    await expect(engine.restartFrom("run-1", "nope")).rejects.toThrow(/no step "nope"/);
    await expect(engine.restartFrom("missing", "test")).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("selectCiEngine", () => {
  it("builds the workflows engine from bindings", () => {
    const env = { CI_RUN_WORKFLOW: new FakeWorkflow<CiRunParams>(), CI_BUCKET: new MemoryStore() };
    expect(selectCiEngine(env, { engine: "workflows" }).kind).toBe("workflows");
    expect(() => selectCiEngine({}, { engine: "workflows" })).toThrow(CiEngineConfigError);
  });
});

describe("deriveRunId", () => {
  it("is deterministic per change, head and attempt", async () => {
    const a = await deriveRunId("chg-1", SHA_A);
    expect(a).toMatch(/^r-[0-9a-f]{32}$/);
    expect(await deriveRunId("chg-1", SHA_A)).toBe(a);
    expect(await deriveRunId("chg-1", SHA_B)).not.toBe(a);
    expect(await deriveRunId("chg-1", SHA_A, 1)).not.toBe(a);
  });
});

describe("buildRunStatus", () => {
  it("lists recorded steps missing from the pipeline record after the declared ones", () => {
    const status = buildRunStatus({
      run: {
        v: 1,
        runId: "r",
        changeId: "c",
        headSha: SHA_A,
        baseSha: SHA_B,
        engine: "workflows",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      pipeline: null,
      steps: new Map([["x", { v: 1 as const, ...stepStatus("x", "passed") }]]),
      cancel: null,
      summary: null,
      instance: { status: "running" },
    });
    expect(status.steps.map((s) => s.name)).toEqual(["x"]);
    expect(status.pipelineSource).toBeNull();
  });
});
