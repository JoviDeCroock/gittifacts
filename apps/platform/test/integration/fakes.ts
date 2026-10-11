/**
 * The fakes the M1 integration test swaps in for Cloudflare primitives that have no local
 * equivalent under workerd tests. Everything else is the real platform: D1Store, the AuditLog DO,
 * the signing key, D1Notifier, the ChangeCoordinator / MergeQueue DOs and the Workflows.
 *
 * - git (FakeGitHost): Artifacts has no local simulator (the binding is remote-only).
 * - sandbox (FakeSandboxJobs) and ci (EngineShapedCi): containers cannot run in workerd tests.
 *   EngineShapedCi reports runs exactly like `CiRunWorkflow`'s finalize step: a ci-engine
 *   `RunSummary` (schema-checked) sent to `env.COORDINATOR.getByName(changeId).onRunFinished`,
 *   with the step log written to `CI_BUCKET` at `ci-logs/<runId>/<step>.log`.
 * - reviewer (FakeReviewer): no model calls from tests.
 *
 * Kept on globalThis so the test file and the Durable Objects / Workflows (same isolate, possibly
 * another module instance) share one set.
 */
import { RunRequest, RunSummary } from "@app/ci-engine";
import type {
  CiEngine,
  CiRunRequest,
  CiRunStatus,
  GitHost,
  Ports,
  PortsRole,
} from "@app/coordinator";
import { FakeGitHost, FakeReviewer, FakeSandboxJobs, greenEvidence } from "@app/coordinator/fakes";
import { PlatformPreviews } from "../../src/previews/port.js";
import type { PortsEnv } from "../../src/runtime/ports.js";
import { D1Store } from "../../src/store/d1-store.js";
import { fakeBrowser } from "./preview-fakes.js";

export const NAMESPACE = "gittifacts-eu";

/** The bindings EngineShapedCi reports through (what CiRunWorkflow uses). */
export interface CiSinkEnv {
  COORDINATOR: { getByName(name: string): { onRunFinished(summary: unknown): Promise<unknown> } };
  CI_BUCKET: R2Bucket;
}

export class EngineShapedCi implements CiEngine {
  readonly runs = new Map<string, { request: CiRunRequest; status: CiRunStatus }>();

  async start(req: CiRunRequest): Promise<{ runId: string }> {
    // The real engine's request schema is strict: whatever the coordinator sends must parse.
    RunRequest.parse(req);
    if (!this.runs.has(req.runId)) {
      this.runs.set(req.runId, {
        request: structuredClone(req),
        status: {
          id: req.runId,
          changeId: req.changeId,
          headSha: req.headSha,
          baseSha: req.baseSha,
          engine: "workflows",
          status: "running",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          steps: [],
        },
      });
    }
    return { runId: req.runId };
  }

  async status(runId: string): Promise<CiRunStatus> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`CI run ${runId} not found`);
    return structuredClone(run.status);
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined || run.status.status !== "running") return;
    run.status.status = reason.startsWith("superseded") ? "superseded" : "cancelled";
  }

  async restartFrom(): Promise<void> {}

  /**
   * Finish `runId` green (install, test, build + evidence) and report it like CiRunWorkflow. With
   * `failTests`, the test step fails with that many failing tests (CI red, evidence still sealed).
   */
  async finish(env: CiSinkEnv, runId: string, opts: { failTests?: number } = {}): Promise<unknown> {
    const failing = opts.failTests ?? 0;
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`CI run ${runId} was never started`);
    const { request } = run;
    const started = run.status.startedAt ?? new Date().toISOString();
    const finished = new Date().toISOString();
    const log = (step: string) => `ci-logs/${runId}/${step}.log`;
    await env.CI_BUCKET.put(
      log("test"),
      " ✓ test/a.test.ts (12 tests) 900ms\n Tests  12 passed (12)\n",
      {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      },
    );
    const step = (name: string, kind: "user" | "evidence", durationMs: number) => ({
      name,
      kind,
      status: failing > 0 && name === "test" ? ("failed" as const) : ("passed" as const),
      durationMs,
      logRef: log(name),
      cacheHit: false,
      exitCode: failing > 0 && name === "test" ? 1 : 0,
      startedAt: started,
      finishedAt: finished,
    });
    const bundleKey = `ci-artifacts/${runId}/build/bundle.tgz`;
    const summary = RunSummary.parse({
      id: runId,
      changeId: request.changeId,
      headSha: request.headSha,
      baseSha: request.baseSha,
      engine: "workflows",
      status: failing > 0 ? "failed" : "passed",
      startedAt: started,
      finishedAt: finished,
      steps: [
        step("install", "user", 3000),
        step("test", "user", 900),
        step("build", "user", 400),
        step("evidence:red-green", "evidence", 1200),
      ],
      pipelineSource: "default",
      warnings: [],
      evidence: greenEvidence(request.baseSha, request.headSha).map((item) =>
        failing > 0 && item.kind === "test-run"
          ? {
              ...item,
              passed: Math.max(0, item.passed - failing),
              failed: failing,
              failures: Array.from({ length: failing }, (_, i) => ({
                name: `breaks case ${i + 1}`,
                message: "expected 'hello' to be 'hi'",
              })),
            }
          : item,
      ),
      evidenceErrors: [],
      usage: {
        computeMs: 5500,
        ciMinutes: 0.1,
        byInstance: { "standard-2": 5500 },
        containers: 4,
        cacheHits: 0,
        logBytes: 64,
        artifactBytes: 1024,
      },
      timings: { totalMs: 6000 },
      artifacts: {
        bundle: { key: bundleKey, bytes: 1024, sha256: "0".repeat(64), step: "build" },
      },
      snapshots: { build: "snap-build" },
    });
    run.status = {
      ...run.status,
      // Like the engine's RunStatus: the passed steps' container snapshots (previews, QA).
      ...({ snapshots: summary.snapshots } as Partial<CiRunStatus>),
      status: summary.status,
      finishedAt: finished,
      steps: summary.steps.map((s) => ({
        name: s.name,
        kind: s.kind,
        status: s.status,
        durationMs: s.durationMs,
        logRef: s.logRef,
      })),
    };
    return env.COORDINATOR.getByName(request.changeId).onRunFinished(summary);
  }
}

export interface IntegrationFakes {
  git: FakeGitHost;
  sandbox: FakeSandboxJobs;
  ci: EngineShapedCi;
  reviewer: FakeReviewer;
}

const KEY = "__gittifactsPlatformIntegrationFakes";

function create(): IntegrationFakes {
  const git = new FakeGitHost({ namespace: NAMESPACE });
  return {
    git,
    sandbox: new FakeSandboxJobs(git),
    ci: new EngineShapedCi(),
    reviewer: new FakeReviewer(),
  };
}

export function integrationFakes(): IntegrationFakes {
  const g = globalThis as unknown as Record<string, IntegrationFakes | undefined>;
  g[KEY] ??= create();
  return g[KEY];
}

export function resetIntegrationFakes(): IntegrationFakes {
  const fakes = create();
  (globalThis as unknown as Record<string, IntegrationFakes>)[KEY] = fakes;
  return fakes;
}

const GUARDED = new Set([
  "writeNote",
  "updateRef",
  "commitTree",
  "deleteRepo",
  "transferObjects",
  "fetchExternal",
]);

/**
 * Like ArtifactsGitHost's default guard: outside the merge queue, only change forks are written
 * (and, for GitHub mode's `github` role, GitHub mirrors `ghm-*`).
 */
function forkOnly(git: FakeGitHost, mirrors = false): GitHost {
  return new Proxy(git, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const name = String(prop);
        const repo = name === "transferObjects" || name === "fetchExternal" ? args[1] : args[0];
        const writes = GUARDED.has(name) || (name === "mintToken" && args[1] === "write");
        const allowed = (r: string) => r.startsWith("task-") || (mirrors && /^ghm-\d+$/.test(r));
        if (writes && typeof repo === "string" && !allowed(repo)) {
          throw new Error(`forbidden: ${name} on main repo ${repo} outside the merge queue`);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * The ports to swap into `buildPorts(env, role, { overrides })`. With `env`, previews use the
 * real `PlatformPreviews` (D1 rows, the PreviewHost DO with a fake container) and a fake
 * Browser Run for screenshots.
 */
export function integrationOverrides(role: PortsRole, env?: PortsEnv): Partial<Ports> {
  const f = integrationFakes();
  return {
    git: role === "merge-queue" ? f.git : forkOnly(f.git, role === "github"),
    sandbox: f.sandbox,
    ci: f.ci,
    reviewer: f.reviewer,
    ...(env === undefined
      ? {}
      : {
          previews: new PlatformPreviews(
            { ...env, BROWSER: fakeBrowser },
            new D1Store(env.DB, env.BLOBS),
          ),
        }),
  };
}
