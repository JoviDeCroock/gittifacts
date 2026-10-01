import { describe, expect, it } from "vitest";
import { type CacheKeyInput, computeCacheKey } from "../../src/cache/key.js";
import { CloudflareCiEngine } from "../../src/cloudflare/engine.js";
import {
  type CiEngine,
  type CiRunParams,
  InvalidRunRequestError,
  RunRequest,
  type RunRequest as RunRequestInput,
  resolveLimits,
} from "../../src/engine.js";
import { recordPipeline } from "../../src/plan/recorder.js";
import {
  clampInstance,
  effectiveCacheScope,
  isInstallLike,
  type PipelineSpec,
  parsePipelineSpec,
  seedPipeline,
} from "../../src/plan/spec.js";
import { summarizeUsage } from "../../src/run-store.js";
import {
  describeUrl,
  EgressProps,
  egressDecision,
  REGISTRY_HOSTS,
} from "../../src/runner/egress.js";
import { inDirectory, trustCaScript } from "../../src/runner/shell.js";
import { WorkflowsCiEngine } from "../../src/workflows/engine.js";
import { FakeWorkflow } from "./fake-workflow.js";
import { MemoryStore, SHA_A, SHA_B } from "./helpers.js";

describe("egress policy", () => {
  const props = { registries: [...REGISTRY_HOSTS], gitHost: "0123.artifacts.cloudflare.net" };
  const git = "https://0123.artifacts.cloudflare.net/git/ns/repo.git";
  it.each([
    ["GET", "https://registry.npmjs.org/react", true],
    ["HEAD", "https://registry.yarnpkg.com/react", true],
    ["GET", "https://codeload.github.com/o/r/tar.gz/main", true],
    ["PUT", "https://registry.npmjs.org/my-pkg", false],
    ["POST", "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", false],
    ["GET", `${git}/info/refs?service=git-upload-pack`, true],
    ["POST", `${git}/git-upload-pack`, true],
    ["GET", `${git}/info/refs?service=git-receive-pack`, false],
    ["POST", `${git}/git-receive-pack`, false],
    ["GET", "https://evil.example/x", false],
    ["GET", "https://registry.npmjs.org.evil.example/x", false],
    ["GET", "not a url", false],
  ] as const)("%s %s → %s", (method, url, allowed) => {
    expect(egressDecision(method, url, props).allowed).toBe(allowed);
  });

  it("explains refusals, strips queries from logged URLs and validates props", () => {
    expect(egressDecision("GET", "https://evil.example/", props)).toEqual({
      allowed: false,
      reason: "evil.example is not an allowed registry",
    });
    expect(describeUrl("https://u:p@evil.example/a/b?token=x#f")).toBe("https://evil.example/a/b");
    expect(
      EgressProps.safeParse({ runner: "r:s", registries: ["a b"], gitHost: null }).success,
    ).toBe(false);
  });
});

describe("cache scope", () => {
  const blobs = [
    { path: "package.json", sha: "1".repeat(40) },
    { path: "pnpm-lock.yaml", sha: "2".repeat(40) },
  ];
  const input = (over: Partial<CacheKeyInput> = {}): CacheKeyInput => ({
    kind: "global",
    scope: "repo:a",
    namespace: "v1",
    image: "img@sha256:1",
    step: { name: "install", command: "pnpm install --frozen-lockfile" },
    inputs: ["package.json", "pnpm-lock.yaml"],
    blobs,
    ...over,
  });

  it("global keys ignore the repository, the step name and how inputs are written", async () => {
    const k = await computeCacheKey(input());
    expect(await computeCacheKey(input({ scope: "repo:b" }))).toBe(k);
    expect(
      await computeCacheKey(
        input({ step: { name: "deps", command: "pnpm install --frozen-lockfile" } }),
      ),
    ).toBe(k);
    expect(await computeCacheKey(input({ inputs: ["*.json", "*.yaml"] }))).toBe(k);
  });

  it("global keys change with the image, command, env and file contents", async () => {
    const k = await computeCacheKey(input());
    const variants = await Promise.all([
      computeCacheKey(input({ image: "img@sha256:2" })),
      computeCacheKey(input({ step: { name: "install", command: "pnpm install" } })),
      computeCacheKey(
        input({
          step: { name: "install", command: "pnpm install --frozen-lockfile", env: { A: "1" } },
        }),
      ),
      computeCacheKey(
        input({ blobs: [blobs[0]!, { path: "pnpm-lock.yaml", sha: "3".repeat(40) }] }),
      ),
      computeCacheKey(input({ kind: "repo" })),
    ]);
    for (const v of variants) expect(v).not.toBe(k);
  });

  it("repo keys depend on the repository scope", async () => {
    const a = await computeCacheKey(input({ kind: "repo" }));
    expect(await computeCacheKey(input({ kind: "repo", scope: "repo:b" }))).not.toBe(a);
  });

  it("defaults install-like root steps to global and everything else to repo", () => {
    const cache = { inputs: ["pnpm-lock.yaml"] };
    expect(isInstallLike({ command: "npm ci", parent: null, cache })).toBe(true);
    expect(
      effectiveCacheScope({ command: "pnpm install --frozen-lockfile", parent: null, cache }),
    ).toBe("global");
    expect(effectiveCacheScope({ command: "pnpm build", parent: null, cache })).toBe("repo");
    expect(
      effectiveCacheScope({ command: "pnpm install", parent: "x", cache, cacheScope: "global" }),
    ).toBe("repo");
    expect(
      effectiveCacheScope({ command: "make deps", parent: null, cache, cacheScope: "global" }),
    ).toBe("global");
    expect(effectiveCacheScope({ command: "pnpm install", parent: null })).toBeNull();
  });

  it("records cacheScope in plan mode and seeds only global steps", async () => {
    const spec = await recordPipeline(async (ci) => {
      const deps = await ci.runner({
        name: "deps",
        command: "make deps",
        cache: { inputs: ["Makefile"] },
        cacheScope: "global",
      });
      await deps.runner({ name: "test", command: "make test" });
    });
    expect(spec.steps[0]?.cacheScope).toBe("global");
    expect(seedPipeline(spec).steps.map((s) => s.name)).toEqual(["deps"]);
    const invalid = parsePipelineSpec({
      ...spec,
      steps: [{ ...spec.steps[0], cacheScope: "everyone" }],
    });
    expect(invalid.ok).toBe(false);
  });
});

describe("limits", () => {
  const base: RunRequestInput = {
    runId: "r1",
    changeId: "c1",
    repo: { remote: "https://x/r.git", tokenProvider: "artifacts" },
    artifactsRepo: "fork",
    headSha: SHA_A,
    baseSha: SHA_B,
    limits: { maxMinutes: 10 },
  };

  it("fills defaults and keeps the deprecated budget working", () => {
    const req: CiRunParams = RunRequest.parse(base);
    expect(resolveLimits(req)).toEqual({
      maxMinutes: 10,
      maxLogBytes: 20 * 1024 * 1024,
      instance: "standard-4",
      maxArtifactBytes: 100 * 1024 * 1024,
    });
    expect(req.network).toBe("open");
    const { limits: _l, ...withoutLimits } = base;
    expect(RunRequest.safeParse(withoutLimits).success).toBe(false);
    const legacy = RunRequest.parse({ ...withoutLimits, budget: { maxMinutes: 7 } });
    expect(resolveLimits(legacy).maxMinutes).toBe(7);
  });

  it("clamps instance types to the limit", () => {
    expect(clampInstance("standard-4", "standard-1")).toBe("standard-1");
    expect(clampInstance("lite", "standard-1")).toBe("lite");
  });

  it("sums usage per instance and rounds minutes up", () => {
    expect(
      summarizeUsage(
        [
          {
            v: 1,
            step: "a",
            instance: "standard-1",
            computeMs: 61_000,
            logBytes: 10,
            artifactBytes: 100,
          },
          { v: 1, step: "b", instance: "standard-2", computeMs: 1, logBytes: 5, artifactBytes: 0 },
        ],
        2,
      ),
    ).toEqual({
      computeMs: 61_001,
      ciMinutes: 1.02,
      byInstance: { "standard-1": 61_000, "standard-2": 1 },
      containers: 2,
      cacheHits: 2,
      logBytes: 15,
      artifactBytes: 100,
    });
  });
});

describe("shell helpers for onboarding", () => {
  it("runs commands in a quoted working directory with a clear failure", () => {
    expect(inDirectory("pnpm test", undefined)).toBe("pnpm test");
    const s = inDirectory("pnpm test", "apps/$(rm -rf)");
    expect(s).toContain("cd -- 'apps/$(rm -rf)' ||");
    expect(s).toContain("'gittifacts: working directory apps/$(rm -rf) does not exist'");
  });

  it("installs the interception CA", () => {
    const s = trustCaScript("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(s).toContain("update-ca-certificates");
    expect(s).toContain("exit 3");
  });
});

describe("engines and onboarding features", () => {
  const pipeline: PipelineSpec = {
    version: 1,
    source: "file",
    steps: [
      {
        name: "install",
        command: "pnpm install --frozen-lockfile",
        parent: null,
        after: [],
        cache: { inputs: ["pnpm-lock.yaml"] },
      },
      { name: "test", command: "pnpm test", parent: "install", after: [] },
    ],
    warnings: [],
  };

  it("seedCache starts a seed run with global writes and an idempotent id", async () => {
    const workflow = new FakeWorkflow<CiRunParams>();
    const bucket = new MemoryStore();
    const engine = new WorkflowsCiEngine({ workflow, bucket });
    const seed = {
      templateId: "ts-lib",
      artifactsRepo: "tmpl-ts-lib",
      remote: "https://x/t.git",
      sha: SHA_A,
      pipeline,
    };
    const { runId } = await engine.seedCache(seed);
    expect((await engine.seedCache(seed)).runId).toBe(runId);
    expect(workflow.creates).toBe(1);
    expect(workflow.instances.get(runId)?.params).toMatchObject({
      seed: { templateId: "ts-lib" },
      cache: { global: "read-write" },
      headSha: SHA_A,
      baseSha: SHA_A,
      pipelineFrom: "head",
    });
    const status = await engine.status(runId);
    expect(status.steps.map((s) => s.name)).toEqual(["install"]);
    await expect(engine.seedCache({ ...seed, templateId: "" })).rejects.toBeInstanceOf(
      InvalidRunRequestError,
    );
  });

  it("the cloudflare-ci engine refuses restricted egress and seeding (fails closed)", async () => {
    const engine = new CloudflareCiEngine({
      workflow: new FakeWorkflow(),
      bucket: new MemoryStore(),
      namespace: "ns",
    });
    const req: RunRequestInput = {
      runId: "cf",
      changeId: "c",
      repo: { remote: "https://x/r.git", tokenProvider: "artifacts" },
      artifactsRepo: "fork",
      headSha: SHA_A,
      baseSha: SHA_B,
      pipeline,
      evidenceSteps: [],
      limits: { maxMinutes: 5 },
    };
    await expect(engine.start({ ...req, network: "registries-only" })).rejects.toThrow(
      /cannot restrict egress/,
    );
    await expect(engine.start({ ...req, seed: { templateId: "t" } })).rejects.toThrow(
      /cannot seed/,
    );
    const asEngine: CiEngine = engine;
    expect(asEngine.seedCache).toBeUndefined();
  });
});
