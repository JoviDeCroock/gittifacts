import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cachePointerKey } from "../../src/cache/pointer.js";
import {
  InvalidRunRequestError,
  RunConflictError,
  type RunRequest,
  type RunStatus,
  RunSummary,
} from "../../src/engine.js";
import { type EvidenceStepSpec, evidenceCommand } from "../../src/evidence-steps.js";
import type { StepSpec } from "../../src/plan/spec.js";
import { RunKeys } from "../../src/run-store.js";
import { RunnerOutcome } from "../../src/runner/job.js";
import { WorkflowsCiEngine } from "../../src/workflows/engine.js";
import type { TestEnv } from "./entry.js";
import { BAD_SHA, FAKE_TOKEN, type FakeEvent, SHAS } from "./fakes.js";

const e = env as unknown as TestEnv;
const engine = new WorkflowsCiEngine({
  workflow: e.CI_RUN_WORKFLOW,
  bucket: e.CI_BUCKET,
  runners: e.RUNNER,
});

const step = (
  name: string,
  command: string,
  parent: string | null = null,
  after: string[] = [],
  extra: Partial<StepSpec> = {},
): StepSpec => ({ name, command, parent, after, ...extra });

const pipeline = (steps: StepSpec[]) => ({
  version: 1 as const,
  source: "file" as const,
  steps,
  warnings: [],
});

const evidence = (
  name: EvidenceStepSpec["name"],
  parent: string | null,
  requiresGreen: boolean,
): EvidenceStepSpec => ({
  name,
  command: evidenceCommand(name.slice("evidence:".length) as never, { testCommand: "pnpm test" }),
  parent,
  requiresGreen,
});

function request(runId: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId,
    changeId: `chg-${runId}`,
    repo: {
      remote: "https://0123.artifacts.cloudflare.net/git/gittifacts-eu/fork-1.git",
      tokenProvider: "artifacts",
    },
    artifactsRepo: "fork-1",
    headSha: SHAS.head,
    baseSha: SHAS.base,
    budget: { maxMinutes: 120 },
    evidenceSteps: [],
    ...overrides,
  };
}

async function runToCompletion(req: RunRequest): Promise<unknown> {
  await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
  await inst.modify(async (m) => {
    await m.disableRetryDelays();
  });
  await engine.start(req);
  await inst.waitForStatus("complete");
  return inst.getOutput();
}

async function text(key: string): Promise<string | null> {
  const obj = await e.CI_BUCKET.get(key);
  return obj === null ? null : obj.text();
}

async function events(runId: string, stepName: string): Promise<FakeEvent[]> {
  const list = await e.CI_BUCKET.list({ prefix: `fake-events/${runId}:${stepName}/` });
  const keys = list.objects.map((o) => o.key).sort();
  return Promise.all(keys.map(async (k) => JSON.parse((await text(k)) ?? "{}") as FakeEvent));
}

async function sinkSummary(req: RunRequest): Promise<RunSummary> {
  return RunSummary.parse(
    JSON.parse((await text(`test-sink/${req.changeId}/${req.runId}.json`)) ?? "null"),
  );
}

const byName = (status: RunStatus) => Object.fromEntries(status.steps.map((s) => [s.name, s]));

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("CiRunWorkflow", () => {
  it("runs install → parallel checks → build, starts children from snapshots, collects evidence and redacts logs", async () => {
    const req = request("happy", {
      pipeline: pipeline([
        step("install", "fake:touch=node_modules fake:out=installed fake:printtoken"),
        step("lint", "fake:require=node_modules fake:sleep=150", "install"),
        step("typecheck", "fake:require=node_modules fake:sleep=150", "install"),
        step("test", "fake:require=node_modules fake:sleep=150 fake:env", "install"),
        step("build", "fake:require=node_modules", "install", ["lint", "typecheck", "test"]),
      ]),
      evidenceSteps: [
        evidence("evidence:dependencies", null, false),
        evidence("evidence:policy", null, false),
        evidence("evidence:coverage", "install", true),
      ],
    });
    expect(await runToCompletion(req)).toMatchObject({ status: "passed", evidenceItems: 3 });

    const status = await engine.status(req.runId);
    expect(status.status).toBe("passed");
    expect(status.engine).toBe("workflows");
    expect(status.steps.map((s) => [s.name, s.status])).toEqual([
      ["install", "passed"],
      ["lint", "passed"],
      ["typecheck", "passed"],
      ["test", "passed"],
      ["build", "passed"],
      ["evidence:dependencies", "passed"],
      ["evidence:policy", "passed"],
      ["evidence:coverage", "passed"],
    ]);
    expect(byName(status).install?.logRef).toBe(RunKeys.log(req.runId, "install"));

    // lint/typecheck/test overlap in time; build starts after all three ended.
    const exits = await Promise.all(
      ["lint", "typecheck", "test", "build"].map(
        async (s) => (await events(req.runId, s)).find((x) => x.kind === "exit")!,
      ),
    );
    const [lint, typecheck, test, build] = exits as [FakeEvent, FakeEvent, FakeEvent, FakeEvent];
    const checks = [lint, typecheck, test];
    expect(Math.max(...checks.map((x) => x.t0 as number))).toBeLessThan(
      Math.min(...checks.map((x) => x.t1 as number)),
    );
    expect(build.t0 as number).toBeGreaterThanOrEqual(
      Math.max(...checks.map((x) => x.t1 as number)),
    );

    // install starts from the image and is snapshotted; children start from that snapshot; leaves aren't snapshotted.
    const installEvents = await events(req.runId, "install");
    expect(installEvents[0]).toMatchObject({
      kind: "start",
      snapshot: null,
      enableInternet: true,
      instance: "standard-2",
    });
    const snap = installEvents.find((x) => x.kind === "snapshot")?.id;
    expect(snap).toBeTypeOf("string");
    const lintEvents = await events(req.runId, "lint");
    expect(lintEvents[0]).toMatchObject({ kind: "start", snapshot: snap });
    expect(lintEvents.some((x) => x.kind === "snapshot")).toBe(false);
    expect(lintEvents.at(-1)?.kind).toBe("destroy");

    // Logs are redacted, and the token never reaches a user command's env.
    const installLog = (await text(RunKeys.log(req.runId, "install"))) ?? "";
    expect(installLog).toContain("Authorization: Bearer [REDACTED]");
    expect(installLog).toContain("leaked [REDACTED]");
    expect(installLog).not.toContain("feedface");
    const testLog = (await text(RunKeys.log(req.runId, "test"))) ?? "";
    expect(testLog).toMatch(/env .*GITTIFACTS_HEAD_SHA/);
    expect(testLog).not.toMatch(/env .*GIT_CONFIG/);
    expect(testLog).not.toContain("GITTIFACTS_EVIDENCE_OUT");
    // Workspace commands run as the image's unprivileged user.
    const testExec = (await events(req.runId, "test")).find((x) => x.kind === "exec");
    expect(testExec?.user).toBe("10001:10001");

    // Evidence: file channel (dependencies, coverage) and ::evidence:: line channel (policy).
    const summary = await sinkSummary(req);
    expect(summary.status).toBe("passed");
    expect(summary.evidence.map((i) => i.id).sort()).toEqual([
      "coverage",
      "dependencies",
      "policy",
    ]);
    expect(summary.evidenceErrors).toEqual([]);
    const depLog = (await text(RunKeys.log(req.runId, "evidence:dependencies"))) ?? "";
    expect(depLog).toContain(`base=${SHAS.base} head=${SHAS.head}`);
    expect(await text(RunKeys.summary(req.runId))).not.toBeNull();
  });

  it("caches a step's snapshot and reuses it in a later run with the same inputs", async () => {
    const steps = pipeline([
      step("install", "fake:touch=node_modules", null, [], {
        cache: { inputs: ["package.json", "pnpm-lock.yaml"] },
      }),
      step("test", "fake:require=node_modules", "install"),
    ]);
    const cache = { write: "repo:r1:main", read: ["repo:r1:main"] };
    const first = request("cache-1", { pipeline: steps, cache });
    expect(await runToCompletion(first)).toMatchObject({ status: "passed" });
    const firstSnap = (await events(first.runId, "install")).find((x) => x.kind === "snapshot")?.id;
    expect((await e.CI_BUCKET.list({ prefix: "ci-cache/" })).objects.length).toBeGreaterThan(0);

    const second = request("cache-2", { pipeline: steps, cache, headSha: SHAS.head2 });
    expect(await runToCompletion(second)).toMatchObject({ status: "passed" });
    const status = byName(await engine.status(second.runId));
    expect(status.install).toMatchObject({ status: "passed", cacheHit: true });
    expect(status.test).toMatchObject({ status: "passed", cacheHit: false });
    expect(await events(second.runId, "install")).toEqual([]);
    expect((await events(second.runId, "test"))[0]).toMatchObject({
      kind: "start",
      snapshot: firstSnap,
    });
    expect(await text(RunKeys.log(second.runId, "install"))).toMatch(
      /cache hit \(repo scope\): reusing snapshot/,
    );
  });

  it("a failing step skips its dependents; evidence that doesn't need green still runs", async () => {
    const req = request("failing", {
      pipeline: pipeline([
        step("install", "fake:touch=node_modules"),
        step("lint", "fake:exit=0", "install"),
        step("test", "fake:out=1_test_failed fake:exit=1", "install"),
        step("build", "fake:exit=0", "install", ["test"]),
      ]),
      evidenceSteps: [
        evidence("evidence:red-green", "install", false),
        evidence("evidence:coverage", "install", true),
      ],
    });
    expect(await runToCompletion(req)).toMatchObject({ status: "failed" });
    const status = await engine.status(req.runId);
    expect(status.status).toBe("failed");
    const s = byName(status);
    expect(s.test).toMatchObject({ status: "failed", exitCode: 1 });
    expect(s.test?.tail).toContain("1 test failed");
    expect(s.build).toMatchObject({ status: "skipped", reason: '"test" failed' });
    expect(s.lint?.status).toBe("passed");
    expect(s["evidence:red-green"]?.status).toBe("passed");
    expect(s["evidence:coverage"]).toMatchObject({
      status: "skipped",
      reason: "requires every pipeline step to pass",
    });
    const summary = await sinkSummary(req);
    expect(summary.evidence.map((i) => i.id)).toEqual(["red-green"]);
    expect(summary.evidenceErrors).toEqual([
      { step: "evidence:coverage", message: "skipped: requires every pipeline step to pass" },
    ]);
  });

  it("retries an infrastructure failure once, then marks the step errored", async () => {
    const req = request("infra", {
      pipeline: pipeline([step("a", "fake:crash"), step("b", "fake:exit=0", "a")]),
    });
    expect(await runToCompletion(req)).toMatchObject({ status: "failed" });
    const s = byName(await engine.status(req.runId));
    expect(s.a?.status).toBe("errored");
    expect(s.a?.reason).toContain("fake crash");
    expect(s.b).toMatchObject({ status: "skipped", reason: '"a" errored' });
    expect((await events(req.runId, "a")).filter((x) => x.kind === "start")).toHaveLength(2);
  });

  it("evaluates .platform/ci.ts in plan mode when the request has no pipeline", async () => {
    const req = request("from-file", { headSha: SHAS.withCiFile, pipelineFrom: "head" });
    delete req.evidenceSteps;
    expect(await runToCompletion(req)).toMatchObject({ status: "passed" });
    const status = await engine.status(req.runId);
    expect(status.pipelineSource).toBe("file");
    expect(status.steps.map((s) => [s.name, s.status])).toEqual([
      ["deps", "passed"],
      ["unit", "passed"],
      ["evidence:dependencies", "passed"],
      ["evidence:policy", "passed"],
      ["evidence:red-green", "passed"],
    ]);
    const plan = await events(req.runId, "plan");
    const planCommand = plan.find((x) => x.kind === "exec")?.command as string;
    expect(planCommand).toContain("gittifacts-runner plan '\\''.platform/ci.ts'\\''");
    expect(planCommand).toContain(`--sha ${SHAS.withCiFile}`);
    expect(await text(RunKeys.log(req.runId, "plan"))).toContain("planning .platform/ci.ts");
  });

  it("uses the default pipeline and default evidence steps without a pipeline file", async () => {
    const req = request("defaults", { headSha: SHAS.defaults, pipelineFrom: "head" });
    delete req.evidenceSteps;
    expect(await runToCompletion(req)).toMatchObject({ status: "passed" });
    const status = await engine.status(req.runId);
    expect(status.pipelineSource).toBe("default");
    expect(status.steps.map((s) => s.name)).toEqual([
      "install",
      "typecheck",
      "test",
      "evidence:dependencies",
      "evidence:policy",
      "evidence:red-green",
      "evidence:test-run",
      "evidence:coverage",
      "evidence:mutation",
    ]);
    const summary = await sinkSummary(req);
    expect(summary.evidenceErrors).toHaveLength(1);
    expect(summary.evidenceErrors[0]).toMatchObject({ step: "evidence:mutation" });
    expect(summary.evidenceErrors[0]?.message).toMatch(/not JSON/);
  });

  it("passes merge-queue test targets to user steps (GITTIFACTS_TEST_TARGETS), never to evidence steps", async () => {
    const req = request("targets", {
      pipeline: pipeline([step("test", "fake:env")]),
      testTargets: ["src/a.test.ts"],
    });
    expect(await runToCompletion(req)).toMatchObject({ status: "passed" });
    const exec = (await events(req.runId, "test")).find((x) => x.kind === "exec");
    expect(exec?.envKeys).toContain("GITTIFACTS_TEST_TARGETS");
  });

  it("fails the run with the author's error when the pipeline file throws", async () => {
    const req = request("bad-file", { headSha: SHAS.badCiFile, pipelineFrom: "head" });
    delete req.evidenceSteps;
    expect(await runToCompletion(req)).toMatchObject({ status: "failed" });
    const status = await engine.status(req.runId);
    expect(status.status).toBe("failed");
    expect(status.error).toBe(".platform/ci.ts: the pipeline function threw: boom");
    expect(status.steps).toEqual([]);
  });

  it("replays the lineage when a parent snapshot has disappeared", async () => {
    const steps = pipeline([
      step("install", "fake:touch=node_modules", null, [], {
        cache: { inputs: ["pnpm-lock.yaml"] },
      }),
      step("test", "fake:require=node_modules", "install"),
    ]);
    const cache = { write: "repo:r2:main", read: ["repo:r2:main"] };
    const first = request("gone-1", { pipeline: steps, cache });
    expect(await runToCompletion(first)).toMatchObject({ status: "passed" });
    const snap = (await events(first.runId, "install")).find((x) => x.kind === "snapshot")
      ?.id as string;
    await e.CI_BUCKET.delete(`fake-snapshots/${snap}.json`);
    const pointers = (await e.CI_BUCKET.list({ prefix: "ci-cache/" })).objects.map((o) => o.key);

    const second = request("gone-2", { pipeline: steps, cache, headSha: SHAS.head2 });
    expect(await runToCompletion(second)).toMatchObject({ status: "passed" });
    const testEvents = await events(second.runId, "test");
    const starts = testEvents.filter((x) => x.kind === "start");
    expect(starts.map((x) => x.snapshot)).toEqual([snap, null]);
    expect(testEvents.filter((x) => x.kind === "exec").map((x) => x.command as string)).toEqual([
      expect.stringContaining("fake:touch=node_modules"),
      expect.stringContaining("fake:require=node_modules"),
    ]);
    const remaining = (await e.CI_BUCKET.list({ prefix: "ci-cache/" })).objects.map((o) => o.key);
    expect(remaining.filter((k) => pointers.includes(k)).length).toBeLessThan(pointers.length);
    expect(await text(RunKeys.log(second.runId, "test"))).toContain('replaying "install"');
  });

  it("skips steps once the run budget is exhausted", async () => {
    const req = request("budget", {
      pipeline: pipeline([step("a", "fake:exit=0")]),
      budget: { maxMinutes: 1 },
    });
    expect(await runToCompletion(req)).toMatchObject({ status: "failed" });
    expect(byName(await engine.status(req.runId)).a).toMatchObject({
      status: "skipped",
      reason: "the run's 1-minute limit is exhausted",
    });
    expect(await events(req.runId, "a")).toEqual([]);
  });
});

describe("WorkflowsCiEngine", () => {
  it("start is idempotent per run id and rejects conflicting or invalid requests", async () => {
    const req = request("idem", { pipeline: pipeline([step("a", "fake:exit=0")]) });
    await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
    expect(await engine.start(req)).toEqual({ runId: "idem" });
    expect(await engine.start(req)).toEqual({ runId: "idem" });
    await inst.waitForStatus("complete");
    await expect(engine.start({ ...req, headSha: SHAS.head2 })).rejects.toBeInstanceOf(
      RunConflictError,
    );
    await expect(engine.start({ ...req, runId: "bad id!" })).rejects.toBeInstanceOf(
      InvalidRunRequestError,
    );
    await expect(
      engine.start(
        request("bad-evidence", {
          pipeline: pipeline([step("a", "x")]),
          evidenceSteps: [evidence("evidence:coverage", "install", true)],
        }),
      ),
    ).rejects.toThrow(/unknown step "install"/);
    await expect(engine.status("nope")).rejects.toThrow(/not found/);
  });

  it("cancel terminates the run, stops its containers and reports superseded", async () => {
    const req = request("cancel", {
      pipeline: pipeline([step("slow", "fake:sleep=60000"), step("after", "x", "slow")]),
    });
    await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
    await engine.start(req);
    await until(async () => (await events(req.runId, "slow")).some((x) => x.kind === "exec"));
    expect((await engine.status(req.runId)).status).toBe("running");

    await engine.cancel(req.runId, "superseded by a newer head");
    await engine.cancel(req.runId, "superseded by a newer head");
    const status = await engine.status(req.runId);
    expect(status.status).toBe("superseded");
    expect(byName(status).slow?.status).toBe("cancelled");
    expect(byName(status).after?.status).toBe("cancelled");
    await until(async () => (await events(req.runId, "slow")).some((x) => x.kind === "destroy"));
    const exit = (await events(req.runId, "slow")).find((x) => x.kind === "exit");
    expect(exit?.code).toBe(137);

    const refused = RunnerOutcome.parse(
      await e.RUNNER.getByName(`${req.runId}:after`).run({
        runId: req.runId,
        step: "after",
        kind: "user",
        command: "x",
        instance: "lite",
        timeoutSeconds: 60,
        artifactsRepo: "fork-1",
        remote: "https://example.com/r.git",
        headSha: SHAS.head,
        from: { kind: "image" },
        snapshot: false,
        logKey: "ci-logs/x/after.log",
      }),
    );
    expect(refused).toMatchObject({ ok: false, code: "aborted" });
    void inst;
  });

  it("restartFrom re-runs a step and its dependents via instance.restart", async () => {
    const req = request("restart", {
      pipeline: pipeline([
        step("install", "fake:touch=node_modules"),
        step("test", "fake:exit=1", "install"),
        step("build", "fake:exit=0", "install", ["test"]),
      ]),
    });
    await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
    await inst.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await engine.start(req);
    await inst.waitForStatus("complete");
    expect((await engine.status(req.runId)).status).toBe("failed");
    // "build" never ran (skipped), so the restart point becomes its failed ancestor "test".
    await engine.restartFrom(req.runId, "build");
    expect((await engine.status(req.runId)).status).not.toBe("failed");
    await until(async () => (await text(RunKeys.summary(req.runId))) !== null, 30_000);
    const execs = async (s: string) =>
      (await events(req.runId, s)).filter((x) => x.kind === "exec").length;
    expect(await execs("test")).toBe(2);
    expect(await execs("install")).toBe(1);
    await expect(engine.restartFrom(req.runId, "nope")).rejects.toThrow(/no step "nope"/);
  });
});

describe("Runner", () => {
  it("reports checkout failures with a redacted log and destroys the container", async () => {
    const outcome = RunnerOutcome.parse(
      await e.RUNNER.getByName("direct:checkout").run({
        runId: "direct",
        step: "checkout",
        kind: "user",
        command: "fake:exit=0",
        instance: "lite",
        timeoutSeconds: 60,
        artifactsRepo: "fork-1",
        remote: "https://example.com/r.git",
        headSha: BAD_SHA,
        from: { kind: "image" },
        snapshot: false,
        logKey: "ci-logs/direct/checkout.log",
      }),
    );
    expect(outcome).toMatchObject({ ok: false, code: "checkout" });
    const log = (await text("ci-logs/direct/checkout.log")) ?? "";
    expect(log).toContain("object not found");
    expect(log).not.toContain(FAKE_TOKEN);
    expect((await events("direct", "checkout")).at(-1)?.kind).toBe("destroy");
  });

  it("rejects invalid jobs without starting a container", async () => {
    const outcome = RunnerOutcome.parse(
      await e.RUNNER.getByName("direct:invalid").run({ step: 1 }),
    );
    expect(outcome).toMatchObject({ ok: false, code: "invalid-job" });
    expect(await events("direct", "invalid")).toEqual([]);
  });

  it("keeps cache pointers keyed by content", async () => {
    expect(cachePointerKey("a".repeat(64))).toBe(`ci-cache/${"a".repeat(64)}.json`);
  });
});
