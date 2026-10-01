/**
 * `CiRunWorkflow`: one Workflow instance per CI run (instance id = runId).
 *
 *   plan      resolve the pipeline when the request didn't carry one (`.platform/ci.ts` evaluated
 *             in a sandbox, or the default JS/TS pipeline) and the evidence steps
 *   prepare   walk the head tree, compute cache keys, fix the budget deadline
 *   <step>…   one `step.do` per pipeline step, named exactly like the step, each as soon as its
 *             dependencies passed (so levels run in parallel); a dependency that did not pass
 *             skips the step
 *   evidence:* platform evidence steps after the user steps; `requiresGreen` ones only when all
 *             user steps passed
 *   finalize  write the summary to R2 and report it to the `RunSink`
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
import { computeCacheKey } from "../cache/key.js";
import { deleteCachePointer, lookupCache, writeCachePointer } from "../cache/pointer.js";
import { listDirectory, listRoot, type RepoReader, readRootFile, walkTree } from "../cache/tree.js";
import {
  type CiRunParams,
  RunRequest,
  type RunSink,
  type RunSummary,
  type StepStatus,
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
  DEFAULT_INSTANCE,
  DEFAULT_STEP_TIMEOUT_MINUTES,
  formatIssues,
  type InstanceType,
  type PipelineSpec,
  parsePipelineSpec,
  type StepSpec,
  stepDependencies,
} from "../plan/spec.js";
import { type PipelineSource, RunKeys, type RunOutput, writeStepRecord } from "../run-store.js";
import { errorMessage } from "../runner/container.js";
import {
  type EvidenceCapture,
  PLAN_RUNNER_STEP,
  PlanOutcome,
  type ReplayStep,
  type RunnerJobInput,
  RunnerOutcome,
  type RunnerRpc,
  runnerName,
} from "../runner/job.js";
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
  /** Cache-key salt; bump it when the runner image changes. Default "v1". */
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
  tail: string;
  reason: string | null;
  evidence: EvidenceCapture | null;
};

export type ResolvedPipeline =
  | { ok: true; source: PipelineSource; pipeline: PipelineSpec; evidenceSteps: EvidenceStepSpec[] }
  | { ok: false; error: string };

export type Prepared = {
  /** Epoch ms after which no new step starts. */
  deadline: number;
  cacheKeys: Record<string, { write: string; writeScope: string; read: string[] } | null>;
  warnings: string[];
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
};

function userExec(s: StepSpec): ExecSpec {
  return {
    name: s.name,
    kind: "user",
    command: s.command,
    cwd: s.cwd,
    env: s.env,
    instance: s.instance ?? DEFAULT_INSTANCE,
    timeoutMinutes: s.timeoutMinutes ?? DEFAULT_STEP_TIMEOUT_MINUTES,
    parent: s.parent,
    deps: stepDependencies(s),
  };
}

function evidenceExec(e: EvidenceStepSpec): ExecSpec {
  return {
    name: e.name,
    kind: "evidence",
    command: e.command,
    instance: e.instance ?? DEFAULT_INSTANCE,
    timeoutMinutes: e.timeoutMinutes ?? DEFAULT_STEP_TIMEOUT_MINUTES,
    parent: e.parent,
    deps: e.parent === null ? [] : [e.parent],
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
    tail: "",
    reason,
    evidence: null,
  };
}

export function toStepStatus(r: StepResult): StepStatus {
  const showTail = (r.status === "failed" || r.status === "errored") && r.tail !== "";
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
    ...(r.reason === null ? {} : { reason: r.reason.slice(0, 4000) }),
    ...(showTail ? { tail: r.tail.slice(-16 * 1024) } : {}),
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
    if (!parsed.success)
      throw new NonRetryableError(`invalid CI run params\n${formatIssues(parsed.error)}`);
    const req = parsed.data;
    const startedAt = event.timestamp.toISOString();

    let resolved: ResolvedPipeline;
    if (req.pipeline !== undefined && req.evidenceSteps !== undefined) {
      resolved = {
        ok: true,
        source: "request",
        pipeline: req.pipeline,
        evidenceSteps: req.evidenceSteps,
      };
    } else {
      try {
        resolved = await step.do(ENGINE_STEPS.plan, PLAN_CONFIG, () => this.resolvePipeline(req));
      } catch (error) {
        resolved = { ok: false, error: `could not resolve the pipeline: ${errorMessage(error)}` };
      }
    }
    if (!resolved.ok) return this.finish(step, req, startedAt, [], [], resolved.error);
    const { pipeline, evidenceSteps } = resolved;

    let prepared: Prepared;
    try {
      prepared = await step.do(ENGINE_STEPS.prepare, PREPARE_CONFIG, () =>
        this.prepare(req, pipeline, event.timestamp.getTime()),
      );
    } catch (error) {
      return this.finish(
        step,
        req,
        startedAt,
        [],
        [],
        `prepare failed: ${errorMessage(error)}`,
        resolved,
      );
    }

    const needsSnapshot = snapshotSources(pipeline.steps);
    for (const e of evidenceSteps) if (e.parent !== null) needsSnapshot.add(e.parent);

    const results = new Map<string, Promise<StepResult>>();
    const byName = new Map(pipeline.steps.map((s) => [s.name, s] as const));
    for (const name of topologicalOrder(pipeline.steps)) {
      const spec = userExec(byName.get(name)!);
      const chain = parentChain(pipeline.steps, name).map(userExec);
      results.set(
        name,
        this.schedule(step, req, prepared, spec, chain, results, needsSnapshot.has(name), null),
      );
    }
    const userResults = await Promise.all(pipeline.steps.map((s) => results.get(s.name)!));
    const green = userResults.every((r) => r.status === "passed");

    const evidenceResults = await Promise.all(
      evidenceSteps.map((e) => {
        const spec = evidenceExec(e);
        const chain =
          e.parent === null
            ? []
            : [...parentChain(pipeline.steps, e.parent), byName.get(e.parent)!].map(userExec);
        const gate = e.requiresGreen && !green ? "requires every pipeline step to pass" : null;
        return this.schedule(step, req, prepared, spec, chain, results, false, gate);
      }),
    );

    return this.finish(
      step,
      req,
      startedAt,
      userResults,
      evidenceResults,
      undefined,
      resolved,
      prepared.warnings,
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
    if (blocked !== undefined)
      return notRun(spec, "skipped", `"${blocked.name}" ${blocked.status}`, null);
    if (gate !== null) return notRun(spec, "skipped", gate, null);
    const parent = spec.parent === null ? null : (deps[spec.deps.indexOf(spec.parent)] ?? null);
    const chainResults = await Promise.all(chain.map((c) => results.get(c.name)!));
    try {
      return await step.do(spec.name, stepConfig(spec.timeoutMinutes), (ctx) =>
        this.executeStep(req, prepared, spec, parent, chain, chainResults, snapshot, ctx.attempt),
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
    spec: ExecSpec,
    parent: StepResult | null,
    chain: ExecSpec[],
    chainResults: StepResult[],
    snapshot: boolean,
    attempt: number,
  ): Promise<StepResult> {
    const store = this.store();
    const startedAt = new Date().toISOString();
    const logKey = RunKeys.log(req.runId, spec.name);
    const base = { ...notRun(spec, "skipped", "", logKey), reason: null, startedAt };
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
        reason: `the run's ${req.budget.maxMinutes}-minute budget is exhausted`,
      });
    }
    const timeoutSeconds = Math.max(
      60,
      Math.min(spec.timeoutMinutes * 60, Math.floor(remaining / 1000) - 60),
    );

    const keys = prepared.cacheKeys[spec.name] ?? null;
    if (keys !== null) {
      const hit = await lookupCache(store, keys.read, Date.now());
      if (hit !== null) {
        await store.put(
          logKey,
          `[gittifacts] cache hit: reusing snapshot ${hit.snapshotId} from run ${hit.runId} (commit ${hit.producedBySha}, ${hit.createdAt})\n`,
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
      env: spec.env ?? {},
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
      snapshot: snapshot || keys !== null,
      logKey,
      ...(spec.kind === "evidence" ? { evidenceKey: RunKeys.evidence(req.runId, spec.name) } : {}),
    };
    const runner = this.runner(req.runId, spec.name);
    let outcome = parseOutcome(await runner.run(job));

    if (!outcome.ok && outcome.code === "snapshot-unavailable" && chain.length > 0) {
      // The parent's snapshot is gone (expired or evicted). Forget cache pointers that led to
      // it and rebuild the lineage from the base image inside this step.
      for (const r of chainResults)
        if (r.cacheHit && r.cacheKey !== null) await deleteCachePointer(store, r.cacheKey);
      const replay: ReplayStep[] = chain.map((c) => ({
        name: c.name,
        command: c.command,
        ...(c.cwd === undefined ? {} : { cwd: c.cwd }),
        ...(c.env === undefined ? {} : { env: c.env }),
      }));
      outcome = parseOutcome(await runner.run({ ...job, from: { kind: "image" }, replay }));
    }

    if (!outcome.ok) {
      const message = `[${outcome.code}] ${outcome.message}${outcome.tail === "" ? "" : `\n…${outcome.tail.slice(-TAIL_IN_ERROR)}`}`;
      if (outcome.code === "aborted" || outcome.code === "invalid-job")
        throw new NonRetryableError(message);
      throw new Error(message);
    }

    const passed = outcome.exitCode === 0;
    let cacheKey: string | null = null;
    if (passed && keys !== null && outcome.snapshot !== null) {
      await writeCachePointer(store, {
        v: 1,
        key: keys.write,
        snapshotId: outcome.snapshot.id,
        step: spec.name,
        scope: keys.writeScope,
        producedBySha: req.headSha,
        runId: req.runId,
        createdAt: new Date().toISOString(),
      });
      cacheKey = keys.write;
    }
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
      tail: passed ? "" : outcome.tail,
      reason: outcome.timedOut ? `timed out after ${timeoutSeconds}s` : null,
      evidence: outcome.evidence,
    });
  }

  /** `plan` step body: decide the pipeline and evidence steps for this run. */
  protected async resolvePipeline(req: CiRunParams): Promise<ResolvedPipeline> {
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
      return {
        rootEntries: root.entries.map((e) => e.name),
        packageJson,
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
      if (!planned.ok) return planned;
      pipeline = planned.pipeline;
      source = "file";
    } else {
      pipeline = defaultPipeline(facts);
      source = "default";
    }
    const evidenceSteps =
      req.evidenceSteps ?? defaultEvidenceSteps(evidenceOptionsFor(pipeline, features));
    const issues = evidenceStepIssues(pipeline, evidenceSteps);
    if (issues.length > 0) return { ok: false, error: issues.join("\n") };
    await writeJson(this.store(), RunKeys.pipeline(req.runId), {
      v: 1,
      source,
      pipeline,
      evidenceSteps,
      resolvedAt: new Date().toISOString(),
    });
    return { ok: true, source, pipeline, evidenceSteps };
  }

  private async planFromFile(
    req: CiRunParams,
    sha: string,
  ): Promise<{ ok: true; pipeline: PipelineSpec } | { ok: false; error: string }> {
    const raw = await this.runner(req.runId, PLAN_RUNNER_STEP).plan({
      runId: req.runId,
      artifactsRepo: req.artifactsRepo,
      remote: req.repo.remote,
      sha,
      baseSha: req.baseSha,
      file: CI_PIPELINE_FILE,
      logKey: RunKeys.log(req.runId, PLAN_RUNNER_STEP),
    });
    const outcome = PlanOutcome.safeParse(raw);
    if (!outcome.success)
      throw new Error(
        `the runner returned an invalid plan outcome\n${formatIssues(outcome.error)}`,
      );
    const o = outcome.data;
    if (!o.ok) {
      if (o.code === "aborted") throw new NonRetryableError(o.message);
      // Infrastructure problems are retried by step.do; nothing else is the author's fault.
      throw new Error(`[${o.code}] ${o.message}`);
    }
    const stderr = o.stderr.slice(-4000);
    if (o.exitCode !== 0) {
      return {
        ok: false,
        error: `${CI_PIPELINE_FILE} failed in plan mode (exit ${o.exitCode})\n${stderr}`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(o.stdout);
    } catch {
      return { ok: false, error: `${CI_PIPELINE_FILE}: plan output is not JSON\n${stderr}` };
    }
    const spec = parsePipelineSpec(json);
    if (!spec.ok)
      return {
        ok: false,
        error: `${CI_PIPELINE_FILE} describes an invalid pipeline\n${spec.error}`,
      };
    return { ok: true, pipeline: { ...spec.value, source: "file" } };
  }

  /** `prepare` step body: cache keys from the head tree, and the budget deadline. */
  protected async prepare(
    req: CiRunParams,
    pipeline: PipelineSpec,
    startMs: number,
  ): Promise<Prepared> {
    const deadline = startMs + req.budget.maxMinutes * 60_000;
    const scopes = req.cache ?? {
      write: `repo:${req.artifactsRepo}`,
      read: [`repo:${req.artifactsRepo}`],
    };
    const namespace = this.env.CI_CACHE_NAMESPACE ?? "v1";
    const cached = pipeline.steps.filter((s) => s.cache !== undefined);
    const cacheKeys: Prepared["cacheKeys"] = {};
    const warnings: string[] = [];
    if (cached.length === 0) return { deadline, cacheKeys, warnings };
    try {
      const blobs = await this.withRepo(req.artifactsRepo, (repo) => walkTree(repo, req.headSha));
      for (const s of cached) {
        const inputs = s.cache?.inputs ?? [];
        const keyFor = (scope: string) =>
          computeCacheKey({
            scope,
            namespace,
            step: { name: s.name, command: s.command, cwd: s.cwd, env: s.env },
            inputs,
            blobs,
          });
        const write = await keyFor(scopes.write);
        if (write === null) {
          warnings.push(
            `step "${s.name}": no file matches cache inputs ${inputs.join(", ")}; not cached`,
          );
          cacheKeys[s.name] = null;
          continue;
        }
        const read: string[] = [];
        for (const scope of scopes.read) {
          const k = await keyFor(scope);
          if (k !== null && !read.includes(k)) read.push(k);
        }
        cacheKeys[s.name] = { write, writeScope: scopes.write, read };
      }
    } catch (error) {
      warnings.push(`caching is disabled for this run: ${errorMessage(error)}`);
    }
    return { deadline, cacheKeys, warnings };
  }

  private async finish(
    step: WorkflowStep,
    req: CiRunParams,
    startedAt: string,
    userResults: StepResult[],
    evidenceResults: StepResult[],
    error?: string,
    resolved?: ResolvedPipeline,
    extraWarnings: string[] = [],
  ): Promise<RunOutput> {
    return step.do(ENGINE_STEPS.finalize, FINALIZE_CONFIG, async () => {
      const summary = await this.buildSummary(
        req,
        startedAt,
        userResults,
        evidenceResults,
        error,
        resolved,
        extraWarnings,
      );
      await writeJson(this.store(), RunKeys.summary(req.runId), summary);
      await this.runSink(req).onRunFinished(summary);
      return {
        status: summary.status,
        finishedAt: summary.finishedAt,
        ...(summary.error === undefined ? {} : { error: summary.error.slice(0, 8000) }),
        steps: summary.steps.map((s) => ({ name: s.name, status: s.status })),
        evidenceItems: summary.evidence.length,
      };
    });
  }

  protected async buildSummary(
    req: CiRunParams,
    startedAt: string,
    userResults: StepResult[],
    evidenceResults: StepResult[],
    error: string | undefined,
    resolved: ResolvedPipeline | undefined,
    extraWarnings: string[],
  ): Promise<RunSummary> {
    const evidence: EvidenceItem[] = [];
    const evidenceErrors: { step: string; message: string }[] = [];
    for (const r of evidenceResults) {
      const capture = r.evidence;
      if (capture !== null && "key" in capture) {
        const items = z.array(EvidenceItem).safeParse(await readJson(this.store(), capture.key));
        if (items.success) evidence.push(...items.data);
        else
          evidenceErrors.push({ step: r.name, message: "stored evidence is missing or invalid" });
      } else if (capture !== null) {
        evidenceErrors.push({ step: r.name, message: capture.error });
      } else {
        evidenceErrors.push({
          step: r.name,
          message: `${r.status}${r.reason === null ? "" : `: ${r.reason}`}`,
        });
      }
    }
    const passed = error === undefined && userResults.every((r) => r.status === "passed");
    const warnings = [
      ...(resolved?.ok === true ? resolved.pipeline.warnings : []),
      ...extraWarnings,
    ];
    return {
      id: req.runId,
      changeId: req.changeId,
      headSha: req.headSha,
      baseSha: req.baseSha,
      engine: "workflows",
      status: passed ? "passed" : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: [...userResults, ...evidenceResults].map(toStepStatus),
      pipelineSource: resolved?.ok === true ? resolved.source : null,
      warnings,
      ...(error === undefined ? {} : { error: error.slice(0, 16_000) }),
      evidence,
      evidenceErrors: evidenceErrors.map((e) => ({
        step: e.step,
        message: e.message.slice(0, 4000),
      })),
    };
  }
}

function parseOutcome(raw: unknown): RunnerOutcome {
  const parsed = RunnerOutcome.safeParse(raw);
  if (!parsed.success)
    throw new Error(`the runner returned an invalid outcome\n${formatIssues(parsed.error)}`);
  return parsed.data;
}
