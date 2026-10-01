/**
 * `WorkflowsCiEngine`: the default `CiEngine`, backed by `CiRunWorkflow` + `Runner`.
 * Constructed with structural bindings so it works from any Worker or Durable Object (the
 * coordinator) and can be unit-tested with fakes. No `cloudflare:*` imports.
 *
 * `WorkflowBackedEngine` holds what both engines share: one Workflow instance per run
 * (instance id = runId), run records in R2, status folding, cancel, restart-from-step.
 */
import {
  type CiEngine,
  type CiRunParams,
  deriveRunId,
  type EngineKind,
  InvalidRunRequestError,
  RunConflictError,
  RunNotFoundError,
  RunRequest,
  type RunStatus,
  SeedCacheRequest,
} from "../engine.js";
import { evidenceStepIssues } from "../evidence-steps.js";
import { dependents, topologicalOrder } from "../plan/dag.js";
import { formatIssues, seedPipeline } from "../plan/spec.js";
import {
  buildRunStatus,
  type CancelRecord,
  type InstanceStatusLike,
  isSupersededReason,
  loadRunSnapshot,
  RunKeys,
  RunRecord,
  readRecord,
} from "../run-store.js";
import { PLAN_RUNNER_STEP, runnerName } from "../runner/job.js";
import { type ObjectStore, writeJson } from "../storage.js";
import { ENGINE_STEPS } from "./constants.js";

export interface WorkflowInstanceLike {
  status(): Promise<InstanceStatusLike>;
  terminate(): Promise<void>;
  restart(options?: { from?: { name: string } }): Promise<void>;
}

/** Structural subset of `Workflow<P>`. */
export interface WorkflowLike<P = CiRunParams> {
  create(options: { id: string; params: P }): Promise<unknown>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

/** Structural subset of `DurableObjectNamespace<Runner>`. */
export interface RunnerControlNamespace {
  getByName(name: string): {
    abort(reason: string): Promise<unknown>;
    clearAbort(): Promise<unknown>;
  };
}

export interface WorkflowBackedEngineOptions<P> {
  workflow: WorkflowLike<P>;
  bucket: ObjectStore;
  /** Lets `cancel()` stop containers immediately (Workflow termination alone does not). */
  runners?: RunnerControlNamespace;
  /** Upper bound on how long `cancel()` waits for runners to acknowledge. Default 10 s. */
  cancelTimeoutMs?: number;
}

export type WorkflowsCiEngineOptions = WorkflowBackedEngineOptions<CiRunParams>;

export abstract class WorkflowBackedEngine<P> implements CiEngine {
  abstract readonly kind: EngineKind;

  constructor(protected readonly opts: WorkflowBackedEngineOptions<P>) {}

  /** The Workflow params for a validated request. */
  protected abstract params(req: CiRunParams): P;

  /** Engine-specific request checks; throw `InvalidRunRequestError`. */
  protected validate(_req: CiRunParams): void {}

  async start(input: RunRequest): Promise<{ runId: string }> {
    const parsed = RunRequest.safeParse(input);
    if (!parsed.success) throw new InvalidRunRequestError(formatIssues(parsed.error));
    const req = parsed.data;
    this.validate(req);
    if (req.pipeline !== undefined && req.evidenceSteps !== undefined) {
      const issues = evidenceStepIssues(req.pipeline, req.evidenceSteps);
      if (issues.length > 0) throw new InvalidRunRequestError(issues.join("\n"));
    }
    const { bucket, workflow } = this.opts;
    const existing = await readRecord(bucket, RunKeys.run(req.runId), RunRecord);
    if (existing !== null) {
      if (existing.changeId !== req.changeId || existing.headSha !== req.headSha) {
        throw new RunConflictError(
          `run ${req.runId} already exists for change ${existing.changeId} at ${existing.headSha}`,
        );
      }
      if ((await this.instance(req.runId)) !== null) return { runId: req.runId };
    } else {
      await writeJson(bucket, RunKeys.run(req.runId), {
        v: 1,
        runId: req.runId,
        changeId: req.changeId,
        headSha: req.headSha,
        baseSha: req.baseSha,
        engine: this.kind,
        createdAt: new Date().toISOString(),
      } satisfies RunRecord);
      if (
        req.pipeline !== undefined &&
        (req.evidenceSteps !== undefined || req.seed !== undefined)
      ) {
        await writeJson(bucket, RunKeys.pipeline(req.runId), {
          v: 1,
          source: "request",
          pipeline: req.seed === undefined ? req.pipeline : seedPipeline(req.pipeline),
          evidenceSteps: req.seed === undefined ? (req.evidenceSteps ?? []) : [],
          resolvedAt: new Date().toISOString(),
        });
      }
    }
    try {
      await workflow.create({ id: req.runId, params: this.params(req) });
    } catch (error) {
      // Lost a race with another start() for the same run: that's the idempotent case.
      if ((await this.instance(req.runId)) !== null) return { runId: req.runId };
      throw error;
    }
    return { runId: req.runId };
  }

  async status(runId: string): Promise<RunStatus> {
    const inst = await this.instance(runId);
    let instanceStatus: InstanceStatusLike | null = null;
    if (inst !== null) {
      try {
        instanceStatus = await inst.status();
      } catch {
        instanceStatus = null;
      }
    }
    const snapshot = await loadRunSnapshot(this.opts.bucket, runId, instanceStatus);
    if (snapshot === null) throw new RunNotFoundError(runId);
    return buildRunStatus(snapshot);
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const { bucket } = this.opts;
    // A finished run (finalize wrote its summary) has nothing left to stop.
    if ((await bucket.get(RunKeys.summary(runId))) !== null) return;
    const snapshot = await loadRunSnapshot(bucket, runId, null);
    if (snapshot === null) return;
    if (snapshot.cancel === null) {
      await writeJson(bucket, RunKeys.cancel(runId), {
        v: 1,
        reason: reason.slice(0, 2000),
        at: new Date().toISOString(),
        superseded: isSupersededReason(reason),
      } satisfies CancelRecord);
    }
    const tasks: Promise<unknown>[] = [];
    const inst = await this.instance(runId);
    // terminate() throws for instances that already finished; that is fine.
    if (inst !== null) tasks.push(inst.terminate().catch(() => undefined));
    const runners = this.opts.runners;
    if (runners !== undefined) {
      const steps = [PLAN_RUNNER_STEP];
      if (snapshot.pipeline !== null) {
        steps.push(...snapshot.pipeline.pipeline.steps.map((s) => s.name));
        steps.push(...snapshot.pipeline.evidenceSteps.map((s) => s.name));
      }
      for (const s of steps) {
        tasks.push(
          runners
            .getByName(runnerName(runId, s))
            .abort(reason)
            .catch(() => undefined),
        );
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.opts.cancelTimeoutMs ?? 10_000);
      }),
    ]);
    clearTimeout(timer);
  }

  async restartFrom(runId: string, step: string): Promise<void> {
    const { bucket } = this.opts;
    const snapshot = await loadRunSnapshot(bucket, runId, null);
    if (snapshot === null) throw new RunNotFoundError(runId);
    const inst = await this.instance(runId);
    if (inst === null) throw new RunNotFoundError(runId);
    const pipeline = snapshot.pipeline;
    const engineSteps: string[] = [ENGINE_STEPS.plan, ENGINE_STEPS.prepare];

    let from = step;
    let affected: string[];
    if (pipeline === null || engineSteps.includes(step)) {
      if (!engineSteps.includes(step))
        throw new Error(`run ${runId} has no resolved pipeline; restart from "plan"`);
      affected = [...snapshot.steps.keys()];
    } else {
      const userSteps = pipeline.pipeline.steps;
      const evidence: string[] = pipeline.evidenceSteps.map((e) => e.name);
      const isUser = userSteps.some((s) => s.name === step);
      if (!isUser && !evidence.includes(step))
        throw new Error(`run ${runId} has no step "${step}"`);
      if (isUser) {
        // A step that never ran (skipped behind a failure) is not in the instance history:
        // restart from its first ancestor that failed instead.
        const record = snapshot.steps.get(step);
        if (record === undefined || record.status === "skipped" || record.status === "queued") {
          const failed = topologicalOrder(userSteps).find((name) => {
            const r = snapshot.steps.get(name);
            return (
              r !== undefined && (r.status === "failed" || r.status === "errored") && name !== step
            );
          });
          if (failed !== undefined) from = failed;
        }
        affected = [from, ...dependents(userSteps, from), ...evidence];
      } else {
        affected = [step];
      }
    }

    await Promise.all([
      bucket.delete([
        RunKeys.summary(runId),
        RunKeys.cancel(runId),
        ...affected.map((s) => RunKeys.step(runId, s)),
      ]),
      ...(this.opts.runners === undefined
        ? []
        : affected.map((s) =>
            this.opts
              .runners!.getByName(runnerName(runId, s))
              .clearAbort()
              .catch(() => undefined),
          )),
    ]);
    await inst.restart({ from: { name: from } });
  }

  private async instance(runId: string): Promise<WorkflowInstanceLike | null> {
    try {
      return await this.opts.workflow.get(runId);
    } catch {
      return null;
    }
  }
}

export class WorkflowsCiEngine extends WorkflowBackedEngine<CiRunParams> {
  readonly kind = "workflows" as const;

  protected params(req: CiRunParams): CiRunParams {
    return req;
  }

  /**
   * Runs the template's global-scope cached steps at `sha` (hermetically, as every global step
   * does) and publishes their snapshots under the input-addressed global keys. Idempotent per
   * (template, sha).
   */
  async seedCache(input: SeedCacheRequest): Promise<{ runId: string }> {
    const parsed = SeedCacheRequest.safeParse(input);
    if (!parsed.success) throw new InvalidRunRequestError(formatIssues(parsed.error));
    const seed = parsed.data;
    const changeId = `seed-${seed.templateId}`.slice(0, 64);
    return this.start({
      runId: await deriveRunId(changeId, seed.sha),
      changeId,
      repo: { remote: seed.remote, tokenProvider: "artifacts" },
      artifactsRepo: seed.artifactsRepo,
      headSha: seed.sha,
      baseSha: seed.sha,
      pipelineFrom: "head",
      ...(seed.pipeline === undefined ? {} : { pipeline: seed.pipeline }),
      limits: seed.limits ?? { maxMinutes: 30 },
      network: seed.network,
      cache: { global: "read-write" },
      seed: { templateId: seed.templateId },
    });
  }
}
