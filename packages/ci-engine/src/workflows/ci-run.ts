/**
 * `CiRunWorkflow`: one Workflow instance per CI run (instance id = runId).
 *
 *   plan      resolve the pipeline when the request didn't carry one (`.platform/ci.ts` evaluated
 *             in a sandbox, or the default JS/TS pipeline) and the evidence steps
 *   prepare   walk the head tree, compute cache keys (global and per-repo), fix the deadline
 *   <step>…   one `step.do` per pipeline step, named exactly like the step, each as soon as its
 *             dependencies passed (so levels run in parallel); a dependency that did not pass
 *             skips the step
 *   evidence:* platform evidence steps after the user steps; `requiresGreen` ones only when all
 *             user steps passed
 *   finalize  write the summary (with usage and timings) to R2 and report it to the `RunSink`
 *
 * Everything outside `step.do` is deterministic given earlier step results, so replays are safe.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { EvidenceItem } from "@app/evidence";
import { z } from "zod";
import { computeCacheKey, matchBlobs } from "../cache/key.js";
import {
  type CachePointer,
  deleteCachePointer,
  readCachePointer,
  writeCachePointer,
} from "../cache/pointer.js";
import { listDirectory, listRoot, type RepoReader, readRootFile, walkTree } from "../cache/tree.js";
import {
  type ArtifactRef,
  type CiRunParams,
  type RunLimits,
  RunRequest,
  type RunSink,
  type RunSummary,
  resolveLimits,
  type StepStatus,
  type StepTimings,
  stepEnv,
} from "../engine.js";
import {
  defaultEvidenceSteps,
  type EvidenceStepSpec,
  evidenceOptionsFor,
  evidenceStepIssues,
} from "../evidence-steps.js";
import { parentChain, snapshotSources, topologicalOrder } from "../plan/dag.js";
import { defaultPipeline, detectRepoFeatures } from "../plan/defaults.js";
import {
  type ArtifactSpec,
  type CacheScope,
  clampInstance,
  DEFAULT_INSTANCE,
  DEFAULT_STEP_TIMEOUT_MINUTES,
  effectiveCacheScope,
  formatIssues,
  type InstanceType,
  type PipelineSpec,
  type StepSpec,
  seedPipeline,
  stepDependencies,
} from "../plan/spec.js";
import {
  computeByStep,
  type PipelineSource,
  RunKeys,
  type RunOutput,
  readUsage,
  summarizeUsage,
  writeStepRecord,
  writeUsage,
} from "../run-store.js";
import { errorMessage } from "../runner/container.js";
import {
  type EvidenceCapture,
  MAX_HERMETIC_INPUTS,
  PLAN_RUNNER_STEP,
  PlanOutcome,
  type ReplayStep,
  RunnerDescription,
  type RunnerJobInput,
  RunnerOutcome,
  type RunnerRpc,
  runnerName,
} from "../runner/job.js";
import { parsePlanOutput } from "../runner/markers.js";
import { type ObjectStore, readJson, writeJson } from "../storage.js";
import { CI_PIPELINE_FILE, ENGINE_STEPS } from "./constants.js";

/** The coordinator's Durable Object namespace, as far as the CI engine is concerned. */
export interface RunSinkNamespace {
  getByName(name: string): RunSink;
}

export interface RunnerNamespace {
  getByName(name: string): RunnerRpc;
}

export interface CiWorkflowEnv {
  ARTIFACTS: Artifacts;
  CI_BUCKET: R2Bucket;
  RUNNER: RunnerNamespace;
  /** Receives `onRunFinished(summary)` keyed by changeId. Optional: the summary is in R2 anyway. */
  COORDINATOR?: RunSinkNamespace;
  /** Cache-key salt (the runner image reference is part of every key already). Default "v1". */
  CI_CACHE_NAMESPACE?: string;
}

const PLAN_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};
const PREPARE_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};
const FINALIZE_CONFIG: WorkflowStepConfig = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};
/** A step needs at least this much budget left to start. */
const MIN_STEP_BUDGET_MS = 2 * 60_000;
const TAIL_IN_ERROR = 2_000;

export type StepResult = {
  name: string;
  kind: "user" | "evidence";
  status: "passed" | "failed" | "errored" | "skipped";
  exitCode: number | null;
  timedOut: boolean;
  cacheHit: boolean;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  logKey: string | null;
  /** Container snapshot to start dependents from, and the commit its workspace is at. */
  snapshot: { id: string; sha: string } | null;
  /** Cache pointer this result came from or wrote, for invalidation. */
  cacheKey: string | null;
  cacheScope: CacheScope | null;
  tail: string;
  reason: string | null;
  evidence: EvidenceCapture | null;
  instance: InstanceType;
  timings: StepTimings | null;
  /** Container time of this attempt's Runner calls. */
  computeMs: number;
  egressDenied: { count: number; hosts: string[] } | null;
  /** Build artifacts by name (uploaded now, or reused from the cache hit). */
  artifacts: Record<string, ArtifactRef>;
};

export type ResolvedPipeline =
  | {
      ok: true;
      source: PipelineSource;
      pipeline: PipelineSpec;
      evidenceSteps: EvidenceStepSpec[];
      durationMs: number;
    }
  | { ok: false; error: string; durationMs: number };

export type CacheKeys = {
  scope: CacheScope;
  /** Keys to look up, in order. */
  read: string[];
  /** Key to publish a fresh snapshot under (null: read-only). */
  write: string | null;
  writeScope: string;
  /** Global writes run hermetically on these paths. */
  hermeticInputs: string[] | null;
  /** Where to cache instead when the hermetic run fails (the step needs other files). */
  fallback: { write: string; writeScope: string } | null;
};

export type Prepared = {
  /** Epoch ms after which no new step starts. */
  deadline: number;
  image: string | null;
  cacheKeys: Record<string, CacheKeys | null>;
  warnings: string[];
  durationMs: number;
};

/** A pipeline or evidence step, normalized for execution. */
type ExecSpec = {
  name: string;
  kind: "user" | "evidence";
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  instance: InstanceType;
  timeoutMinutes: number;
  parent: string | null;
  deps: string[];
  artifacts: ArtifactSpec[];
};

function userExec(s: StepSpec, limits: RunLimits): ExecSpec {
  return {
    name: s.name,
    kind: "user",
    command: s.command,
    cwd: s.cwd,
    env: s.env,
    instance: clampInstance(s.instance ?? DEFAULT_INSTANCE, limits.instance),
    timeoutMinutes: s.timeoutMinutes ?? DEFAULT_STEP_TIMEOUT_MINUTES,
    parent: s.parent,
    deps: stepDependencies(s),
    artifacts: s.artifacts ?? [],
  };
}

function evidenceExec(e: EvidenceStepSpec, limits: RunLimits): ExecSpec {
  return {
    name: e.name,
    kind: "evidence",
    command: e.command,
    instance: clampInstance(e.instance ?? DEFAULT_INSTANCE, limits.instance),
    timeoutMinutes: e.timeoutMinutes ?? DEFAULT_STEP_TIMEOUT_MINUTES,
    parent: e.parent,
    deps: e.parent === null ? [] : [e.parent],
    artifacts: [],
  };
}

/** step.do config for a pipeline step: one retry for infrastructure failures. */
export function stepConfig(timeoutMinutes: number): WorkflowStepConfig {
  return {
    retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
    timeout: `${timeoutMinutes + 5} minutes`,
  };
}

function notRun(
  spec: ExecSpec,
  status: "skipped" | "errored",
  reason: string,
  logKey: string | null,
): StepResult {
  return {
    name: spec.name,
    kind: spec.kind,
    status,
    exitCode: null,
    timedOut: false,
    cacheHit: false,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    logKey,
    snapshot: null,
    cacheKey: null,
    cacheScope: null,
    tail: "",
    reason,
    evidence: null,
    instance: spec.instance,
    timings: null,
    computeMs: 0,
    egressDenied: null,
    artifacts: {},
  };
}

export function toStepStatus(r: StepResult, computeMs?: number): StepStatus {
  const showTail = (r.status === "failed" || r.status === "errored") && r.tail !== "";
  const compute = computeMs ?? r.computeMs;
  return {
    name: r.name,
    kind: r.kind,
    status: r.status,
    durationMs: r.durationMs,
    logRef: r.logKey,
    cacheHit: r.cacheHit,
    exitCode: r.exitCode,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    instance: r.instance,
    ...(r.reason === null ? {} : { reason: r.reason.slice(0, 4000) }),
    ...(showTail ? { tail: r.tail.slice(-16 * 1024) } : {}),
    ...(r.timings === null ? {} : { timings: r.timings }),
    ...(compute > 0 || r.timings !== null ? { computeMs: compute } : {}),
    ...(r.cacheScope === null ? {} : { cacheScope: r.cacheScope }),
    ...(Object.keys(r.artifacts).length === 0 ? {} : { artifacts: r.artifacts }),
    ...(r.egressDenied === null || r.egressDenied.count === 0
      ? {}
      : { egressDenied: r.egressDenied }),
  };
}

export class CiRunWorkflow<E extends CiWorkflowEnv = CiWorkflowEnv> extends WorkflowEntrypoint<
  E,
  CiRunParams
> {
  // ------------------------------------------------------------------ seams

  /** Runs `fn` with a read handle on the repository (the Artifacts handle is Disposable). */
  protected async withRepo<T>(name: string, fn: (repo: RepoReader) => Promise<T>): Promise<T> {
    using repo = await this.env.ARTIFACTS.get(name);
    return await fn(repo);
  }

  protected runner(runId: string, step: string): RunnerRpc {
    return this.env.RUNNER.getByName(runnerName(runId, step));
  }

  /** Where the finished run is reported. Default: `env.COORDINATOR.getByName(changeId)`. */
  protected runSink(req: CiRunParams): RunSink {
    const ns = this.env.COORDINATOR;
    if (ns === undefined) return { onRunFinished: async () => undefined };
    return { onRunFinished: (summary) => ns.getByName(req.changeId).onRunFinished(summary) };
  }

  protected store(): ObjectStore {
    return this.env.CI_BUCKET;
  }

  // ------------------------------------------------------------------ orchestration

  override async run(
    event: Readonly<WorkflowEvent<CiRunParams>>,
    step: WorkflowStep,
  ): Promise<RunOutput> {
    const parsed = RunRequest.safeParse(event.payload);
    if (!parsed.success) {
      throw new NonRetryableError(`invalid CI run params\n${formatIssues(parsed.error)}`);
    }
    const req = parsed.data;
    const limits = resolveLimits(req);
    const startedAt = event.timestamp.toISOString();

    let resolved: ResolvedPipeline;
    if (req.pipeline !== undefined && (req.evidenceSteps !== undefined || req.seed !== undefined)) {
      resolved = {
        ok: true,
        source: "request",
        pipeline: req.pipeline,
        evidenceSteps: req.evidenceSteps ?? [],
        durationMs: 0,
      };
    } else {
      try {
        resolved = await step.do(ENGINE_STEPS.plan, PLAN_CONFIG, () => this.resolvePipeline(req));
      } catch (error) {
        resolved = {
          ok: false,
          error: `could not resolve the pipeline: ${errorMessage(error)}`,
          durationMs: 0,
        };
      }
    }
    if (!resolved.ok) return this.finish(step, req, startedAt, [], [], resolved.error, resolved);
    let { pipeline, evidenceSteps } = resolved;
    if (req.seed !== undefined) {
      pipeline = seedPipeline(pipeline);
      evidenceSteps = [];
      if (pipeline.steps.length === 0) {
        const error = "the template has no global-scope cached steps to seed";
        return this.finish(step, req, startedAt, [], [], error, resolved);
      }
    }

    let prepared: Prepared;
    try {
      prepared = await step.do(ENGINE_STEPS.prepare, PREPARE_CONFIG, () =>
        this.prepare(req, pipeline, event.timestamp.getTime()),
      );
    } catch (error) {
      const message = `prepare failed: ${errorMessage(error)}`;
      return this.finish(step, req, startedAt, [], [], message, resolved);
    }

    const needsSnapshot = snapshotSources(pipeline.steps);
    for (const e of evidenceSteps) if (e.parent !== null) needsSnapshot.add(e.parent);
    // Previews start from the build step's snapshot.
    for (const st of pipeline.steps)
      if ((st.artifacts?.length ?? 0) > 0) needsSnapshot.add(st.name);

    const results = new Map<string, Promise<StepResult>>();
    const byName = new Map(pipeline.steps.map((s) => [s.name, s] as const));
    for (const name of topologicalOrder(pipeline.steps)) {
      const spec = userExec(byName.get(name)!, limits);
      const chain = parentChain(pipeline.steps, name).map((s) => userExec(s, limits));
      results.set(
        name,
        this.schedule(step, req, prepared, spec, chain, results, needsSnapshot.has(name), null),
      );
    }
    const userResults = await Promise.all(pipeline.steps.map((s) => results.get(s.name)!));
    const green = userResults.every((r) => r.status === "passed");

    const evidenceResults = await Promise.all(
      evidenceSteps.map((e) => {
        const spec = evidenceExec(e, limits);
        const chain =
          e.parent === null
            ? []
            : [...parentChain(pipeline.steps, e.parent), byName.get(e.parent)!].map((s) =>
                userExec(s, limits),
              );
        const gate = e.requiresGreen && !green ? "requires every pipeline step to pass" : null;
        return this.schedule(step, req, prepared, spec, chain, results, false, gate);
      }),
    );

    const clamped = [...pipeline.steps, ...evidenceSteps]
      .filter(
        (s) =>
          s.instance !== undefined && clampInstance(s.instance, limits.instance) !== s.instance,
      )
      .map(
        (s) =>
          `step "${s.name}" runs on ${limits.instance} (requested ${s.instance}; the run's limit)`,
      );
    return this.finish(
      step,
      req,
      startedAt,
      userResults,
      evidenceResults,
      undefined,
      resolved,
      [...prepared.warnings, ...clamped],
      prepared.durationMs,
    );
  }

  private async schedule(
    step: WorkflowStep,
    req: CiRunParams,
    prepared: Prepared,
    spec: ExecSpec,
    chain: ExecSpec[],
    results: Map<string, Promise<StepResult>>,
    snapshot: boolean,
    gate: string | null,
  ): Promise<StepResult> {
    const deps = await Promise.all(spec.deps.map((d) => results.get(d)!));
    const blocked = deps.find((d) => d.status !== "passed");
    if (blocked !== undefined) {
      return notRun(spec, "skipped", `"${blocked.name}" ${blocked.status}`, null);
    }
    if (gate !== null) return notRun(spec, "skipped", gate, null);
    const parent = spec.parent === null ? null : (deps[spec.deps.indexOf(spec.parent)] ?? null);
    const chainResults = await Promise.all(chain.map((c) => results.get(c.name)!));
    // Only meaningful on the first execution of the step body; replays use the cached result.
    const readyAt = Date.now();
    try {
      return await step.do(spec.name, stepConfig(spec.timeoutMinutes), (ctx) =>
        this.executeStep(req, prepared, {
          spec,
          parent,
          chain,
          chainResults,
          snapshot,
          attempt: ctx.attempt,
          readyAt,
        }),
      );
    } catch (error) {
      const result = notRun(
        spec,
        "errored",
        errorMessage(error),
        RunKeys.log(req.runId, spec.name),
      );
      await writeStepRecord(this.store(), req.runId, toStepStatus(result)).catch(() => {});
      return result;
    }
  }

  /** The body of one pipeline/evidence step's `step.do`. Throws to make Workflows retry. */
  protected async executeStep(
    req: CiRunParams,
    prepared: Prepared,
    s: {
      spec: ExecSpec;
      parent: StepResult | null;
      chain: ExecSpec[];
      chainResults: StepResult[];
      snapshot: boolean;
      attempt: number;
      readyAt: number;
    },
  ): Promise<StepResult> {
    const { spec, parent, chain, chainResults, attempt } = s;
    const store = this.store();
    const limits = resolveLimits(req);
    const bodyStart = Date.now();
    const startedAt = new Date(bodyStart).toISOString();
    const queueMs = Math.max(0, bodyStart - s.readyAt);
    const logKey = RunKeys.log(req.runId, spec.name);
    const base: StepResult = { ...notRun(spec, "skipped", "", logKey), reason: null, startedAt };
    await writeStepRecord(store, req.runId, { ...toStepStatus(base), status: "running" });
    const done = async (r: StepResult): Promise<StepResult> => {
      await writeStepRecord(store, req.runId, toStepStatus(r));
      return r;
    };

    const remaining = prepared.deadline - Date.now();
    if (remaining < MIN_STEP_BUDGET_MS) {
      return done({
        ...base,
        logKey: null,
        status: "skipped",
        finishedAt: new Date().toISOString(),
        reason: `the run's ${limits.maxMinutes}-minute limit is exhausted`,
        timings: { queueMs, totalMs: Date.now() - bodyStart },
      });
    }
    const timeoutSeconds = Math.max(
      60,
      Math.min(spec.timeoutMinutes * 60, Math.floor(remaining / 1000) - 60),
    );

    const keys = prepared.cacheKeys[spec.name] ?? null;
    if (keys !== null) {
      const hit = await this.usableCacheHit(keys.read, spec.artifacts);
      if (hit !== null) {
        const seeded = hit.seededBy === undefined ? "" : ` (seeded for template ${hit.seededBy})`;
        await store.put(
          logKey,
          `[gittifacts] cache hit (${hit.scope === "global" ? "global" : "repo"} scope): reusing snapshot ${hit.snapshotId} from run ${hit.runId}${seeded} (commit ${hit.producedBySha}, ${hit.createdAt})\n`,
        );
        return done({
          ...base,
          status: "passed",
          exitCode: 0,
          cacheHit: true,
          durationMs: 0,
          finishedAt: new Date().toISOString(),
          snapshot: { id: hit.snapshotId, sha: hit.producedBySha },
          cacheKey: hit.key,
          cacheScope: hit.scope === "global" ? "global" : "repo",
          timings: { queueMs, totalMs: Date.now() - bodyStart },
          artifacts: pickArtifacts(hit.artifacts ?? {}, spec.artifacts),
        });
      }
    }

    const job: RunnerJobInput = {
      runId: req.runId,
      step: spec.name,
      kind: spec.kind,
      attempt,
      command: spec.command,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: stepEnv(spec.kind, spec.env, req.testTargets),
      instance: spec.instance,
      timeoutSeconds,
      artifactsRepo: req.artifactsRepo,
      remote: req.repo.remote,
      headSha: req.headSha,
      ...(spec.kind === "evidence" ? { baseSha: req.baseSha } : {}),
      from:
        parent?.snapshot != null
          ? { kind: "snapshot", snapshotId: parent.snapshot.id, sha: parent.snapshot.sha }
          : { kind: "image" },
      replay: [],
      snapshot: s.snapshot || spec.artifacts.length > 0 || (keys !== null && keys.write !== null),
      logKey,
      ...(spec.kind === "evidence" ? { evidenceKey: RunKeys.evidence(req.runId, spec.name) } : {}),
      maxLogBytes: limits.maxLogBytes,
      maxArtifactBytes: limits.maxArtifactBytes,
      artifacts: spec.artifacts.map((a) => ({
        ...a,
        key: RunKeys.artifact(req.runId, spec.name, a.name),
      })),
      network: req.network,
      ...(keys?.hermeticInputs != null ? { hermeticInputs: keys.hermeticInputs } : {}),
    };
    const runner = this.runner(req.runId, spec.name);
    let calls = 0;
    let computeMs = 0;
    const call = async (j: RunnerJobInput): Promise<RunnerOutcome> => {
      const outcome = parseOutcome(await runner.run(j));
      calls += 1;
      computeMs += outcome.computeMs;
      await writeUsage(store, req.runId, `${attempt}-${calls}`, {
        step: spec.name,
        instance: spec.instance,
        computeMs: outcome.computeMs,
        logBytes: outcome.log?.bytes ?? 0,
        artifactBytes: outcome.ok
          ? Object.values(outcome.artifacts).reduce((sum, a) => sum + a.bytes, 0)
          : 0,
      });
      return outcome;
    };
    let outcome = await call(job);

    if (!outcome.ok && outcome.code === "snapshot-unavailable" && chain.length > 0) {
      // The parent's snapshot is gone (expired or evicted). Forget cache pointers that led to
      // it and rebuild the lineage from the base image inside this step.
      for (const r of chainResults) {
        if (r.cacheHit && r.cacheKey !== null) await deleteCachePointer(store, r.cacheKey);
      }
      const replay: ReplayStep[] = chain.map((c) => ({
        name: c.name,
        command: c.command,
        ...(c.cwd === undefined ? {} : { cwd: c.cwd }),
        ...(c.env === undefined ? {} : { env: c.env }),
      }));
      outcome = await call({ ...job, from: { kind: "image" }, replay });
    }

    let write =
      keys === null || keys.write === null ? null : { key: keys.write, scope: keys.writeScope };
    let scope: CacheScope | null = keys?.scope ?? null;
    let note: string | null = null;
    if (outcome.ok && outcome.exitCode !== 0 && outcome.hermetic && keys?.fallback != null) {
      // With only its cache inputs present the command failed, so it needs other repository
      // files: run it again on the full checkout and cache it for this repository only.
      note = `cached per repository: "${spec.name}" needs files outside its cache inputs (add them to cache.inputs to share it across repositories)`;
      const { hermeticInputs: _hermetic, ...full } = job;
      outcome = await call(full);
      write = { key: keys.fallback.write, scope: keys.fallback.writeScope };
      scope = "repo";
    }

    if (!outcome.ok) {
      const tail = outcome.tail === "" ? "" : `\n…${outcome.tail.slice(-TAIL_IN_ERROR)}`;
      const message = `[${outcome.code}] ${outcome.message}${tail}`;
      if (outcome.code === "aborted" || outcome.code === "invalid-job") {
        throw new NonRetryableError(message);
      }
      throw new Error(message);
    }

    const artifactProblems = Object.entries(outcome.artifactErrors).map(
      ([name, e]) =>
        `${e.optional ? "optional artifact" : "artifact"} "${name}" ${e.optional ? "skipped" : "missing"}: ${e.error}`,
    );
    const requiredMissing = Object.values(outcome.artifactErrors).some((e) => !e.optional);
    const passed = outcome.exitCode === 0 && !requiredMissing;
    let cacheKey: string | null = null;
    if (passed && write !== null && outcome.snapshot !== null) {
      await writeCachePointer(store, {
        v: 1,
        key: write.key,
        snapshotId: outcome.snapshot.id,
        step: spec.name,
        scope: write.scope,
        producedBySha: req.headSha,
        runId: req.runId,
        createdAt: new Date().toISOString(),
        ...(Object.keys(outcome.artifacts).length === 0 ? {} : { artifacts: outcome.artifacts }),
        ...(req.seed === undefined || scope !== "global" ? {} : { seededBy: req.seed.templateId }),
      });
      cacheKey = write.key;
    }
    const reasons = [
      outcome.timedOut ? `timed out after ${timeoutSeconds}s` : null,
      note,
      ...artifactProblems,
    ].filter((r): r is string => r !== null);
    return done({
      ...base,
      status: passed ? "passed" : "failed",
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      finishedAt: new Date().toISOString(),
      logKey: outcome.log.key,
      snapshot: outcome.snapshot === null ? null : { id: outcome.snapshot.id, sha: req.headSha },
      cacheKey,
      cacheScope: cacheKey === null ? null : scope,
      tail: passed ? "" : outcome.tail,
      reason: reasons.length === 0 ? null : reasons.join("; "),
      evidence: outcome.evidence,
      timings: { queueMs, ...outcome.timings, totalMs: Date.now() - bodyStart },
      computeMs,
      egressDenied:
        outcome.egress.denied === 0
          ? null
          : { count: outcome.egress.denied, hosts: outcome.egress.hosts },
      artifacts: outcome.artifacts,
    });
  }

  /**
   * The first fresh pointer among `keys` that carries every required artifact the step declares
   * (an entry produced before the step declared an artifact can't stand in for it).
   */
  private async usableCacheHit(
    keys: readonly string[],
    artifacts: readonly ArtifactSpec[],
  ): Promise<CachePointer | null> {
    for (const key of keys) {
      const hit = await readCachePointer(this.store(), key, Date.now());
      if (hit === null) continue;
      const missing = artifacts.some(
        (a) => a.optional !== true && hit.artifacts?.[a.name] === undefined,
      );
      if (!missing) return hit;
    }
    return null;
  }

  /** `plan` step body: decide the pipeline and evidence steps for this run. */
  protected async resolvePipeline(req: CiRunParams): Promise<ResolvedPipeline> {
    const t0 = Date.now();
    const sha = req.pipelineFrom === "head" ? req.headSha : req.baseSha;
    const facts = await this.withRepo(req.artifactsRepo, async (repo) => {
      const root = await listRoot(repo, sha);
      const text = await readRootFile(repo, root, "package.json");
      let packageJson: unknown = null;
      try {
        packageJson = text === null ? null : (JSON.parse(text) as unknown);
      } catch {
        packageJson = null;
      }
      const templateText = await readRootFile(repo, root, "template.json", 64 * 1024);
      let templateJson: unknown = null;
      try {
        templateJson = templateText === null ? null : (JSON.parse(templateText) as unknown);
      } catch {
        templateJson = null;
      }
      return {
        rootEntries: root.entries.map((e) => e.name),
        packageJson,
        templateJson,
        platformEntries: await listDirectory(repo, root, ".platform"),
      };
    });
    const features = detectRepoFeatures(facts);

    let pipeline: PipelineSpec;
    let source: PipelineSource;
    if (req.pipeline !== undefined) {
      pipeline = req.pipeline;
      source = "request";
    } else if (features.hasPipelineFile) {
      const planned = await this.planFromFile(req, sha);
      if (!planned.ok) return { ...planned, durationMs: Date.now() - t0 };
      pipeline = planned.pipeline;
      source = "file";
    } else {
      pipeline = defaultPipeline(facts);
      source = "default";
    }
    const evidenceSteps =
      req.seed !== undefined
        ? []
        : (req.evidenceSteps ?? defaultEvidenceSteps(evidenceOptionsFor(pipeline, features)));
    const issues = evidenceStepIssues(pipeline, evidenceSteps);
    if (issues.length > 0) {
      return { ok: false, error: issues.join("\n"), durationMs: Date.now() - t0 };
    }
    await writeJson(this.store(), RunKeys.pipeline(req.runId), {
      v: 1,
      source,
      pipeline: req.seed === undefined ? pipeline : seedPipeline(pipeline),
      evidenceSteps,
      resolvedAt: new Date().toISOString(),
    });
    return { ok: true, source, pipeline, evidenceSteps, durationMs: Date.now() - t0 };
  }

  private async planFromFile(
    req: CiRunParams,
    sha: string,
  ): Promise<{ ok: true; pipeline: PipelineSpec } | { ok: false; error: string }> {
    const planInstance = clampInstance("standard-1", resolveLimits(req).instance);
    const raw = await this.runner(req.runId, PLAN_RUNNER_STEP).plan({
      runId: req.runId,
      artifactsRepo: req.artifactsRepo,
      remote: req.repo.remote,
      sha,
      baseSha: req.baseSha,
      file: CI_PIPELINE_FILE,
      logKey: RunKeys.log(req.runId, PLAN_RUNNER_STEP),
      network: req.network,
      instance: planInstance,
    });
    const outcome = PlanOutcome.safeParse(raw);
    if (!outcome.success) {
      throw new Error(
        `the runner returned an invalid plan outcome\n${formatIssues(outcome.error)}`,
      );
    }
    const o = outcome.data;
    await writeUsage(this.store(), req.runId, `plan-${Date.now()}`, {
      step: PLAN_RUNNER_STEP,
      instance: planInstance,
      computeMs: o.computeMs,
      logBytes: 0,
    });
    if (!o.ok) {
      if (o.code === "aborted") throw new NonRetryableError(o.message);
      // Infrastructure problems are retried by step.do; nothing else is the author's fault.
      throw new Error(`[${o.code}] ${o.message}`);
    }
    const stderr = o.stderr.slice(-4000);
    if (o.exitCode !== 0) {
      return {
        ok: false,
        error: `gittifacts-runner plan failed (exit ${o.exitCode}) on ${CI_PIPELINE_FILE}\n${stderr}`,
      };
    }
    const parsed = parsePlanOutput(o.stdout, CI_PIPELINE_FILE);
    if (!parsed.ok) {
      return { ok: false, error: parsed.author ? parsed.error : `${parsed.error}\n${stderr}` };
    }
    return { ok: true, pipeline: { ...parsed.spec, source: "file" } };
  }

  /** The runner image reference, so a new image never reuses snapshots of the old one. */
  protected async runnerImage(req: CiRunParams): Promise<string | null> {
    const raw = await this.runner(req.runId, ENGINE_STEPS.prepare).describe();
    const parsed = RunnerDescription.safeParse(raw);
    return parsed.success ? parsed.data.image : null;
  }

  /** `prepare` step body: cache keys from the head tree, and the deadline. */
  protected async prepare(
    req: CiRunParams,
    pipeline: PipelineSpec,
    startMs: number,
  ): Promise<Prepared> {
    const t0 = Date.now();
    const limits = resolveLimits(req);
    const deadline = startMs + limits.maxMinutes * 60_000;
    const repoWrite = req.cache?.write ?? `repo:${req.artifactsRepo}`;
    const repoRead = req.cache?.read ?? [repoWrite];
    const global = req.seed !== undefined ? "read-write" : (req.cache?.global ?? "read-write");
    const namespace = this.env.CI_CACHE_NAMESPACE ?? "v1";
    const cached = pipeline.steps.filter((st) => st.cache !== undefined);
    const cacheKeys: Prepared["cacheKeys"] = {};
    const warnings: string[] = [];
    if (cached.length === 0) {
      return { deadline, image: null, cacheKeys, warnings, durationMs: Date.now() - t0 };
    }
    let image: string | null = null;
    try {
      image = await this.runnerImage(req);
    } catch (error) {
      warnings.push(`could not read the runner image reference: ${errorMessage(error)}`);
    }
    try {
      const blobs = await this.withRepo(req.artifactsRepo, (repo) => walkTree(repo, req.headSha));
      for (const st of cached) {
        const inputs = st.cache?.inputs ?? [];
        const matched = matchBlobs(blobs, inputs);
        if (matched.length === 0) {
          warnings.push(
            `step "${st.name}": no file matches cache inputs ${inputs.join(", ")}; not cached`,
          );
          cacheKeys[st.name] = null;
          continue;
        }
        const step = { name: st.name, command: st.command, cwd: st.cwd, env: st.env };
        const keyFor = async (kind: "repo" | "global", scope: string): Promise<string> =>
          (await computeCacheKey({ kind, scope, namespace, image, step, inputs, blobs })) ?? "";
        const repoReadKeys: string[] = [];
        for (const scope of repoRead) {
          const k = await keyFor("repo", scope);
          if (!repoReadKeys.includes(k)) repoReadKeys.push(k);
        }
        const repoWriteKey = await keyFor("repo", repoWrite);
        let scope = effectiveCacheScope(st) ?? "repo";
        if (scope === "global" && global === "read-write" && matched.length > MAX_HERMETIC_INPUTS) {
          warnings.push(
            `step "${st.name}": ${matched.length} cache input files exceed ${MAX_HERMETIC_INPUTS}; cached per repository`,
          );
          scope = "repo";
        }
        if (scope === "global" && global !== "off") {
          const globalKey = await keyFor("global", "global");
          cacheKeys[st.name] =
            global === "read-write"
              ? {
                  scope: "global",
                  read: [globalKey],
                  write: globalKey,
                  writeScope: "global",
                  hermeticInputs: matched.map((b) => b.path),
                  fallback: { write: repoWriteKey, writeScope: repoWrite },
                }
              : {
                  // Reads the shared entry, but publishes only for this repository.
                  scope: "repo",
                  read: [globalKey, ...repoReadKeys],
                  write: repoWriteKey,
                  writeScope: repoWrite,
                  hermeticInputs: null,
                  fallback: null,
                };
        } else {
          cacheKeys[st.name] = {
            scope: "repo",
            read: repoReadKeys,
            write: repoWriteKey,
            writeScope: repoWrite,
            hermeticInputs: null,
            fallback: null,
          };
        }
      }
    } catch (error) {
      warnings.push(`caching is disabled for this run: ${errorMessage(error)}`);
    }
    return { deadline, image, cacheKeys, warnings, durationMs: Date.now() - t0 };
  }

  private async finish(
    step: WorkflowStep,
    req: CiRunParams,
    startedAt: string,
    userResults: StepResult[],
    evidenceResults: StepResult[],
    error: string | undefined,
    resolved: ResolvedPipeline,
    extraWarnings: string[] = [],
    prepareMs?: number,
  ): Promise<RunOutput> {
    return step.do(ENGINE_STEPS.finalize, FINALIZE_CONFIG, async () => {
      const summary = await this.buildSummary(req, startedAt, {
        userResults,
        evidenceResults,
        error,
        resolved,
        extraWarnings,
        prepareMs,
      });
      await writeJson(this.store(), RunKeys.summary(req.runId), summary);
      await this.runSink(req).onRunFinished(summary);
      return {
        status: summary.status,
        finishedAt: summary.finishedAt,
        ...(summary.error === undefined ? {} : { error: summary.error.slice(0, 8000) }),
        steps: summary.steps.map((st) => ({ name: st.name, status: st.status })),
        evidenceItems: summary.evidence.length,
      };
    });
  }

  protected async buildSummary(
    req: CiRunParams,
    startedAt: string,
    r: {
      userResults: StepResult[];
      evidenceResults: StepResult[];
      error: string | undefined;
      resolved: ResolvedPipeline;
      extraWarnings: string[];
      prepareMs: number | undefined;
    },
  ): Promise<RunSummary> {
    const evidence: EvidenceItem[] = [];
    const evidenceErrors: { step: string; message: string }[] = [];
    for (const e of r.evidenceResults) {
      const capture = e.evidence;
      if (capture !== null && "key" in capture) {
        const items = z.array(EvidenceItem).safeParse(await readJson(this.store(), capture.key));
        if (items.success) evidence.push(...items.data);
        else
          evidenceErrors.push({ step: e.name, message: "stored evidence is missing or invalid" });
      } else if (capture !== null) {
        evidenceErrors.push({ step: e.name, message: capture.error });
      } else {
        evidenceErrors.push({
          step: e.name,
          message: `${e.status}${e.reason === null ? "" : `: ${e.reason}`}`,
        });
      }
    }
    const all = [...r.userResults, ...r.evidenceResults];
    const usageRecords = await readUsage(this.store(), req.runId);
    const perStep = computeByStep(usageRecords);
    const finishedAt = new Date();
    const runStart = Date.parse(startedAt);
    const starts = r.userResults
      .map((u) => (u.startedAt === null ? Number.NaN : Date.parse(u.startedAt)))
      .filter((t) => !Number.isNaN(t));
    const passed = r.error === undefined && r.userResults.every((u) => u.status === "passed");
    const warnings = [...(r.resolved.ok ? r.resolved.pipeline.warnings : []), ...r.extraWarnings];
    return {
      id: req.runId,
      changeId: req.changeId,
      headSha: req.headSha,
      baseSha: req.baseSha,
      engine: "workflows",
      status: passed ? "passed" : "failed",
      startedAt,
      finishedAt: finishedAt.toISOString(),
      steps: all.map((u) => toStepStatus(u, perStep.get(u.name) ?? u.computeMs)),
      pipelineSource: r.resolved.ok ? r.resolved.source : null,
      warnings,
      ...(r.error === undefined ? {} : { error: r.error.slice(0, 16_000) }),
      evidence,
      evidenceErrors: evidenceErrors.map((e) => ({
        step: e.step,
        message: e.message.slice(0, 4000),
      })),
      usage: summarizeUsage(usageRecords, all.filter((u) => u.cacheHit).length),
      artifacts: Object.fromEntries(
        r.userResults
          .filter((u) => u.status === "passed")
          .flatMap((u) =>
            Object.entries(u.artifacts).map(([name, ref]) => [name, { ...ref, step: u.name }]),
          ),
      ),
      snapshots: Object.fromEntries(
        r.userResults
          .filter((u) => u.status === "passed" && u.snapshot !== null)
          .map((u) => [u.name, u.snapshot?.id ?? ""]),
      ),
      timings: {
        totalMs: Math.max(0, finishedAt.getTime() - runStart),
        ...(r.resolved.durationMs > 0 ? { planMs: r.resolved.durationMs } : {}),
        ...(r.prepareMs === undefined ? {} : { prepareMs: r.prepareMs }),
        ...(starts.length === 0
          ? {}
          : { firstStepMs: Math.max(0, Math.min(...starts) - runStart) }),
      },
      ...(req.seed === undefined ? {} : { seed: { templateId: req.seed.templateId } }),
    };
  }
}

function parseOutcome(raw: unknown): RunnerOutcome {
  const parsed = RunnerOutcome.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the runner returned an invalid outcome\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** The declared artifacts present in `refs`. */
function pickArtifacts(
  refs: Record<string, ArtifactRef>,
  declared: readonly ArtifactSpec[],
): Record<string, ArtifactRef> {
  const out: Record<string, ArtifactRef> = {};
  for (const a of declared) {
    const ref = refs[a.name];
    if (ref !== undefined) out[a.name] = ref;
  }
  return out;
}
