import { describe, expect, it } from "vitest";
import {
  CloudflareCiEngine,
  type CloudflareCiParams,
  cloudflareCiEngineFactory,
  isCloudflareCiEnv,
  selectCiEngineWithCloudflare,
} from "../../src/cloudflare/engine.js";
import { failureOutput, replayPipeline, toRunnerOptions } from "../../src/cloudflare/replay.js";
import { buildReplaySummary } from "../../src/cloudflare/summary.js";
import type {
  CfCiContext,
  CfLogs,
  CfRunnerOptions,
  CfRunnerResult,
} from "../../src/cloudflare/types.js";
import { InvalidRunRequestError, RunRequest } from "../../src/engine.js";
import { type EvidenceStepSpec, evidenceCommand } from "../../src/evidence-steps.js";
import type { PipelineSpec, StepSpec } from "../../src/plan/spec.js";
import { CiEngineConfigError, selectCiEngine } from "../../src/select.js";
import { FakeWorkflow } from "./fake-workflow.js";
import { MemoryStore, SHA_A, SHA_B } from "./helpers.js";

const step = (name: string, parent: string | null = null, after: string[] = []): StepSpec => ({
  name,
  command: `run ${name}`,
  parent,
  after,
});
const spec = (steps: StepSpec[]): PipelineSpec => ({
  version: 1,
  source: "file",
  steps,
  warnings: [],
});
const ev = (
  name: EvidenceStepSpec["name"],
  parent: string | null,
  requiresGreen: boolean,
): EvidenceStepSpec => ({
  name,
  command: evidenceCommand(name.slice(9) as never),
  parent,
  requiresGreen,
});
const ctx = { runId: "run-1", headSha: SHA_A, baseSha: SHA_B };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A CiRunnerFailure-shaped error as @cloudflare/ci's RunnerGroup throws it. */
function ciFailure(own: string, others: string[] = []) {
  const err = new Error(`${others[0] ?? own} failed: exit 1`) as Error & { diagnostics: unknown };
  err.diagnostics = {
    failures: [...others, own].map((n) => ({ runner: { name: n }, output: `output of ${n}` })),
    runners: [],
  };
  return err;
}

function streamOf(text: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent) c.close();
      else {
        sent = true;
        c.enqueue(bytes);
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

class FakeCi implements CfCiContext {
  readonly calls: {
    name: string;
    parent: string | null;
    options: CfRunnerOptions;
    t0: number;
    t1: number;
  }[] = [];
  readonly failures = new Map<string, unknown>();
  readonly logs = new Map<string, () => CfLogs>();
  inFlight = 0;
  maxInFlight = 0;
  private clock = 0;

  runner = (options: CfRunnerOptions) => this.invoke(options, null);

  private async invoke(options: CfRunnerOptions, parent: string | null): Promise<CfRunnerResult> {
    const call = { name: options.name, parent, options, t0: this.clock++, t1: -1 };
    this.calls.push(call);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await sleep(15);
    this.inFlight--;
    call.t1 = this.clock++;
    const failure = this.failures.get(options.name);
    if (failure !== undefined) throw failure;
    return {
      exitCode: 0,
      logs: this.logs.get(options.name)?.() ?? { stdout: `ran ${options.name}`, stderr: "" },
      snapshot: { id: `snap-${options.name}`, dir: "/workspace" },
      runner: (next) => this.invoke(next, options.name),
    };
  }
}

const readme = spec([
  step("install"),
  step("lint", "install"),
  step("typecheck", "install"),
  step("test", "install"),
  step("build", "install", ["lint", "typecheck", "test"]),
]);

describe("replayPipeline (CloudflareCiEngine adapter)", () => {
  it("replays the DAG with ci.runner for roots, .runner() chaining and parallel siblings", async () => {
    const ci = new FakeCi();
    const res = await replayPipeline(ci, readme, [], ctx);
    expect(res.green).toBe(true);
    const byName = Object.fromEntries(ci.calls.map((c) => [c.name, c]));
    expect(Object.fromEntries(ci.calls.map((c) => [c.name, c.parent]))).toEqual({
      install: null,
      lint: "install",
      typecheck: "install",
      test: "install",
      build: "install",
    });
    expect(ci.maxInFlight).toBe(3);
    const checksEnd = Math.max(...["lint", "typecheck", "test"].map((n) => byName[n]!.t1));
    expect(byName.build!.t0).toBeGreaterThan(checksEnd);
    expect(res.steps.map((s) => [s.name, s.status, s.snapshotId])).toEqual([
      ["install", "passed", "snap-install"],
      ["lint", "passed", "snap-lint"],
      ["typecheck", "passed", "snap-typecheck"],
      ["test", "passed", "snap-test"],
      ["build", "passed", "snap-build"],
    ]);
  });

  it("maps step options, timeouts and platform env", () => {
    const o = toRunnerOptions(
      { ...step("t"), cwd: "app", env: { A: "1" }, cache: { inputs: ["x"] }, timeoutMinutes: 10 },
      { GITTIFACTS_RUN_ID: "r" },
    );
    expect(o).toEqual({
      name: "t",
      command: "run t",
      cwd: "app",
      env: { A: "1", GITTIFACTS_RUN_ID: "r" },
      cache: { inputs: ["x"] },
      config: {
        retries: { limit: 1, delay: 10_000, backoff: "constant" },
        timeout: 900_000,
        commandTimeoutMs: 600_000,
      },
    });
  });

  it("records failures, skips dependents and gates requiresGreen evidence", async () => {
    const ci = new FakeCi();
    // RunnerGroup rethrows the earliest failure, which may be another runner's: attribution
    // comes from which promise rejected, the output from the diagnostics.
    ci.failures.set("test", ciFailure("test", ["lint"]));
    ci.failures.set("lint", ciFailure("lint"));
    const res = await replayPipeline(
      ci,
      readme,
      [ev("evidence:red-green", "install", false), ev("evidence:coverage", "install", true)],
      ctx,
    );
    const s = Object.fromEntries(res.steps.map((r) => [r.name, r]));
    expect(res.green).toBe(false);
    expect(s.test).toMatchObject({ status: "failed", output: "output of test" });
    expect(s.lint).toMatchObject({ status: "failed", output: "output of lint" });
    expect(s.build).toMatchObject({ status: "skipped", reason: '"lint" failed' });
    expect(s["evidence:coverage"]).toMatchObject({
      status: "skipped",
      reason: "requires every pipeline step to pass",
    });
    expect(s["evidence:red-green"]?.status).toBe("passed");
    const rg = ci.calls.find((c) => c.name === "evidence:red-green")!;
    expect(rg.parent).toBe("install");
    expect(rg.options.sourceControlCredentials).toBe(true);
    expect(rg.options.env).toMatchObject({
      GITTIFACTS_BASE_SHA: SHA_B,
      GITTIFACTS_HEAD_SHA: SHA_A,
    });
    expect(ci.calls.some((c) => c.name === "build")).toBe(false);
  });

  it("reads evidence from string or streamed stdout and releases user log streams", async () => {
    const ci = new FakeCi();
    let cancelled = 0;
    const item = (id: string) =>
      JSON.stringify({ id, kind: "sensitive-paths", status: "ok", patterns: [], hits: [] });
    ci.logs.set("install", () => ({
      stdout: streamOf("big log", () => cancelled++),
      stderr: streamOf("err", () => cancelled++),
    }));
    ci.logs.set("evidence:policy", () => ({
      stdout: `x\n::evidence::${item("policy")}\n`,
      stderr: "",
    }));
    ci.logs.set("evidence:dependencies", () => ({
      stdout: streamOf(`::evidence::[${item("deps")}]\n`),
      stderr: "",
    }));
    ci.logs.set("evidence:public-api", () => ({ stdout: "::evidence::{nope", stderr: "" }));
    const pipeline = spec([step("install")]);
    const evidence = [
      ev("evidence:policy", null, false),
      ev("evidence:dependencies", null, false),
      ev("evidence:public-api", "install", false),
      ev("evidence:transforms", "install", false),
    ];
    const res = await replayPipeline(ci, pipeline, evidence, ctx);
    expect(cancelled).toBe(2);
    const req = RunRequest.parse({
      runId: "run-1",
      changeId: "c1",
      repo: { remote: "https://x/r.git", tokenProvider: "artifacts" },
      artifactsRepo: "fork",
      headSha: SHA_A,
      baseSha: SHA_B,
      pipeline,
      evidenceSteps: evidence,
      budget: { maxMinutes: 30 },
    });
    const summary = buildReplaySummary(
      req,
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:05:00.000Z",
      res,
    );
    expect(summary).toMatchObject({
      engine: "cloudflare-ci",
      status: "passed",
      pipelineSource: "request",
    });
    expect(summary.evidence.map((i) => i.id).sort()).toEqual(["deps", "policy"]);
    expect(summary.evidenceErrors.map((e) => e.step)).toEqual([
      "evidence:public-api",
      "evidence:transforms",
    ]);
    expect(summary.evidenceErrors[0]?.message).toMatch(/not JSON/);
    expect(summary.evidenceErrors[1]?.message).toMatch(/no ::evidence:: line/);
  });

  it("calls hooks for every step", async () => {
    const seen: string[] = [];
    await replayPipeline(new FakeCi(), spec([step("a"), step("b", "a")]), [], ctx, {
      onStepStart: (name) => {
        seen.push(`start:${name}`);
      },
      onStepFinish: (r) => {
        seen.push(`finish:${r.name}:${r.status}`);
      },
    });
    expect(seen).toEqual(["start:a", "finish:a:passed", "start:b", "finish:b:passed"]);
  });

  it("falls back to the error message without diagnostics", () => {
    expect(failureOutput(new Error("plain"), "x")).toBe("plain");
    expect(failureOutput(ciFailure("x"), "x")).toBe("output of x");
  });
});

describe("CloudflareCiEngine", () => {
  const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
    runId: "cf-1",
    changeId: "c1",
    repo: { remote: "https://x/r.git", tokenProvider: "artifacts" },
    artifactsRepo: "fork-1",
    headSha: SHA_A,
    baseSha: SHA_B,
    pipeline: spec([step("a")]),
    evidenceSteps: [],
    budget: { maxMinutes: 30 },
    ...overrides,
  });

  it("starts a GittifactsCIWorkflow instance with @cloudflare/ci params carrying the request", async () => {
    const workflow = new FakeWorkflow<CloudflareCiParams>();
    const bucket = new MemoryStore();
    const engine = new CloudflareCiEngine({ workflow, bucket, namespace: "gittifacts-eu" });
    expect(engine.kind).toBe("cloudflare-ci");
    await engine.start(request());
    const params = workflow.instances.get("cf-1")?.params;
    expect(params).toMatchObject({
      provider: "cloudflare-artifacts",
      providerData: { namespace: "gittifacts-eu" },
      owner: "gittifacts-eu",
      repo: "fork-1",
      sha: SHA_A,
      trigger: "push",
      ref: "refs/heads/main",
      beforeSha: SHA_B,
      gittifacts: { runId: "cf-1", changeId: "c1" },
    });
    expect((await engine.status("cf-1")).engine).toBe("cloudflare-ci");
  });

  it("requires an explicit pipeline (no plan mode)", async () => {
    const engine = new CloudflareCiEngine({
      workflow: new FakeWorkflow(),
      bucket: new MemoryStore(),
      namespace: "ns",
    });
    const req = request();
    delete req.pipeline;
    await expect(engine.start(req)).rejects.toBeInstanceOf(InvalidRunRequestError);
  });

  it("is opt-in through selectCiEngine factories", () => {
    const env = {
      CF_CI_WORKFLOW: new FakeWorkflow(),
      CI_BUCKET: new MemoryStore(),
      CF_CI_NAMESPACE: "ns",
    };
    expect(isCloudflareCiEnv(env)).toBe(true);
    expect(isCloudflareCiEnv({ ...env, CF_CI_NAMESPACE: "" })).toBe(false);
    // The default entry never constructs it on its own...
    expect(() => selectCiEngine(env, { engine: "cloudflare-ci" })).toThrow(CiEngineConfigError);
    // ...only with the factory from @app/ci-engine/cloudflare, which receives the env untouched.
    expect(
      selectCiEngine(
        env,
        { engine: "cloudflare-ci" },
        { "cloudflare-ci": cloudflareCiEngineFactory },
      ),
    ).toBeInstanceOf(CloudflareCiEngine);
    expect(selectCiEngineWithCloudflare(env, { engine: "cloudflare-ci" }).kind).toBe(
      "cloudflare-ci",
    );
    expect(() => selectCiEngineWithCloudflare({}, { engine: "cloudflare-ci" })).toThrow(
      /CF_CI_WORKFLOW/,
    );
    expect(() => cloudflareCiEngineFactory({})).toThrow(CiEngineConfigError);
  });
});
