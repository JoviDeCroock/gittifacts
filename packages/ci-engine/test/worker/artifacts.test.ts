/** Build artifacts and build snapshots in the run summary (rollouts and previews). */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type RunRequest, RunSummary } from "../../src/engine.js";
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
const bundle = (extra: { optional?: boolean } = {}) => ({
  artifacts: [{ name: "bundle", paths: ["dist"], ...extra }],
});

function request(runId: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    runId,
    changeId: `chg-${runId}`,
    repo: {
      remote: "https://0123.artifacts.cloudflare.net/git/gittifacts-eu/fork.git",
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

async function run(req: RunRequest): Promise<RunSummary> {
  await using inst = await introspectWorkflowInstance(e.CI_RUN_WORKFLOW, req.runId);
  await inst.modify(async (m) => {
    await m.disableRetryDelays();
  });
  await engine.start(req);
  await inst.waitForStatus("complete");
  return RunSummary.parse(
    JSON.parse((await (await e.CI_BUCKET.get(RunKeys.summary(req.runId)))?.text()) ?? "null"),
  );
}

async function events(runId: string, stepName: string): Promise<FakeEvent[]> {
  const list = await e.CI_BUCKET.list({ prefix: `fake-events/${runId}:${stepName}/` });
  const keys = list.objects.map((o) => o.key).sort();
  return Promise.all(
    keys.map(
      async (k) => JSON.parse((await (await e.CI_BUCKET.get(k))?.text()) ?? "{}") as FakeEvent,
    ),
  );
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const byName = (s: RunSummary) => Object.fromEntries(s.steps.map((x) => [x.name, x]));

describe("build artifacts", () => {
  it("streams declared artifacts to R2 and reports them with the build snapshot", async () => {
    const s = await run(
      request("art", {
        pipeline: pipeline([
          step("install", "pnpm install --frozen-lockfile"),
          step(
            "build",
            "fake:require=node_modules fake:touch=dist fake:bundlesize=6000000",
            "install",
            bundle(),
          ),
        ]),
      }),
    );
    expect(s.status).toBe("passed");
    const ref = s.artifacts.bundle!;
    expect(ref).toMatchObject({
      key: "ci-artifacts/art/build/bundle.tgz",
      step: "build",
      bytes: 6_000_000,
    });
    const obj = await e.CI_BUCKET.get(ref.key);
    const body = await obj!.arrayBuffer();
    expect(body.byteLength).toBe(ref.bytes);
    expect(ref.sha256).toBe(await sha256Hex(body));
    expect(byName(s).build?.artifacts?.bundle).toEqual({
      key: ref.key,
      bytes: ref.bytes,
      sha256: ref.sha256,
    });
    expect(byName(s).build?.timings?.artifactsMs).toBeGreaterThanOrEqual(0);
    expect(s.usage.artifactBytes).toBe(6_000_000);

    const buildEvents = await events("art", "build");
    expect(buildEvents.find((x) => x.kind === "tar")).toMatchObject({
      paths: ["dist"],
      user: "10001:10001",
    });
    // The build has no dependents but is snapshotted anyway: previews start from it.
    const snap = buildEvents.find((x) => x.kind === "snapshot")?.id;
    expect(s.snapshots).toEqual({ install: expect.any(String), build: snap });
  });

  it("fails the step when a required artifact is missing; optional ones only add a note", async () => {
    const required = await run(
      request("art-missing", {
        pipeline: pipeline([step("build", "fake:exit=0", null, bundle())]),
      }),
    );
    expect(required.status).toBe("failed");
    expect(byName(required).build).toMatchObject({ status: "failed", exitCode: 0 });
    expect(byName(required).build?.reason).toMatch(/artifact "bundle" missing: tar exited with 2/);
    expect(required.artifacts).toEqual({});
    expect(required.snapshots).toEqual({});
    expect(await (await e.CI_BUCKET.get(RunKeys.log("art-missing", "build")))?.text()).toContain(
      "Cannot stat",
    );

    const optional = await run(
      request("art-optional", {
        pipeline: pipeline([step("build", "fake:exit=0", null, bundle({ optional: true }))]),
      }),
    );
    expect(optional.status).toBe("passed");
    expect(byName(optional).build?.reason).toMatch(/optional artifact "bundle" skipped/);
    expect(optional.snapshots.build).toEqual(expect.any(String));
  });

  it("caps artifact size and leaves nothing behind", async () => {
    const s = await run(
      request("art-cap", {
        limits: { maxMinutes: 60, maxArtifactBytes: 1024 * 1024 },
        pipeline: pipeline([
          step("build", "fake:touch=dist fake:bundlesize=2000000", null, bundle()),
        ]),
      }),
    );
    expect(byName(s).build?.reason).toMatch(/larger than 1048576 bytes/);
    expect(s.status).toBe("failed");
    expect(await e.CI_BUCKET.head("ci-artifacts/art-cap/build/bundle.tgz")).toBeNull();
  });

  it("reuses artifacts and the snapshot from a cache hit, but not from an entry without them", async () => {
    const steps = (withBundle: boolean) =>
      pipeline([
        step("build", "fake:touch=dist", null, {
          cache: { inputs: ["src/**"] },
          ...(withBundle ? bundle() : {}),
        }),
      ]);
    const cache = { write: "repo:art-cache", read: ["repo:art-cache"] };
    await run(request("art-c0", { pipeline: steps(false), cache }));
    const first = await run(request("art-c1", { pipeline: steps(true), cache }));
    expect(byName(first).build).toMatchObject({ cacheHit: false });
    const second = await run(request("art-c2", { pipeline: steps(true), cache }));
    expect(byName(second).build).toMatchObject({ cacheHit: true });
    expect(second.artifacts.bundle).toEqual(first.artifacts.bundle);
    expect(second.snapshots.build).toBe(first.snapshots.build);
    expect(second.usage.artifactBytes).toBe(0);
  });

  it("the default pipeline uploads the template's buildOutput as the bundle", async () => {
    const req = request("art-template", { headSha: SHAS.template, pipelineFrom: "head" });
    delete req.evidenceSteps;
    const s = await run(req);
    expect(s.pipelineSource).toBe("default");
    expect(s.status).toBe("passed");
    expect(s.artifacts.bundle).toMatchObject({
      step: "build",
      key: "ci-artifacts/art-template/build/bundle.tgz",
    });
    expect((await events("art-template", "build")).find((x) => x.kind === "tar")?.paths).toEqual([
      "out",
    ]);
    expect(s.snapshots.build).toEqual(expect.any(String));
  });
});
