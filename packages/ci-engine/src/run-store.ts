/**
 * Run state in R2. Every object has exactly one writer, so there are no read-modify-write races:
 *
 *   ci-runs/<runId>/run.json          RunRecord        engine.start()
 *   ci-runs/<runId>/pipeline.json     PipelineRecord   engine.start() or the Workflow's plan step
 *   ci-runs/<runId>/steps/<step>.json StepRecord       the step itself (inside its step.do)
 *   ci-runs/<runId>/cancel.json       CancelRecord     engine.cancel()
 *   ci-runs/<runId>/summary.json      RunSummary       the finalize step
 *   ci-logs/<runId>/<step>.log        redacted log     the Runner
 *   ci-evidence/<runId>/<step>.json   EvidenceItem[]   the Runner
 *
 * `status()` folds these together with the Workflow instance status.
 */
import { Sha } from "@app/evidence";
import { z } from "zod";
import {
  EngineKind,
  RunId,
  type RunState,
  type RunStatus,
  RunSummary,
  StepStatus,
  SUPERSEDED_PREFIX,
} from "./engine.js";
import { EvidenceStepSpec } from "./evidence-steps.js";
import { PipelineSpec } from "./plan/spec.js";
import { listKeys, type ObjectStore, readJson, writeJson } from "./storage.js";

export const RunKeys = {
  run: (runId: string) => `ci-runs/${runId}/run.json`,
  pipeline: (runId: string) => `ci-runs/${runId}/pipeline.json`,
  stepsPrefix: (runId: string) => `ci-runs/${runId}/steps/`,
  step: (runId: string, step: string) => `ci-runs/${runId}/steps/${step}.json`,
  cancel: (runId: string) => `ci-runs/${runId}/cancel.json`,
  summary: (runId: string) => `ci-runs/${runId}/summary.json`,
  log: (runId: string, step: string) => `ci-logs/${runId}/${step}.log`,
  evidence: (runId: string, step: string) => `ci-evidence/${runId}/${step}.json`,
};

const IsoDate = z.string().datetime();

export const RunRecord = z
  .object({
    v: z.literal(1),
    runId: RunId,
    changeId: z.string(),
    headSha: Sha,
    baseSha: Sha,
    engine: EngineKind,
    createdAt: IsoDate,
  })
  .strict();
export type RunRecord = z.infer<typeof RunRecord>;

export const PipelineSource = z.enum(["file", "default", "request"]);
export type PipelineSource = z.infer<typeof PipelineSource>;

export const PipelineRecord = z
  .object({
    v: z.literal(1),
    source: PipelineSource,
    pipeline: PipelineSpec,
    evidenceSteps: z.array(EvidenceStepSpec),
    resolvedAt: IsoDate,
  })
  .strict();
export type PipelineRecord = z.infer<typeof PipelineRecord>;

export const StepRecord = StepStatus.extend({ v: z.literal(1) });
export type StepRecord = z.infer<typeof StepRecord>;

export const CancelRecord = z
  .object({ v: z.literal(1), reason: z.string().max(2000), at: IsoDate, superseded: z.boolean() })
  .strict();
export type CancelRecord = z.infer<typeof CancelRecord>;

/** The small value a Workflow instance returns (its full summary lives in R2). */
export const RunOutput = z.object({
  status: z.enum(["passed", "failed"]),
  finishedAt: IsoDate,
  error: z.string().optional(),
  steps: z.array(z.object({ name: z.string(), status: StepStatus.shape.status })),
  evidenceItems: z.number().int().nonnegative(),
});
export type RunOutput = z.infer<typeof RunOutput>;

/** Structural subset of `InstanceStatus`. */
export interface InstanceStatusLike {
  status: string;
  error?: { name?: string; message: string } | undefined;
  output?: unknown;
}

export async function readRecord<T>(
  store: ObjectStore,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const parsed = schema.safeParse(await readJson(store, key));
  return parsed.success ? parsed.data : null;
}

export async function readStepRecords(
  store: ObjectStore,
  runId: string,
): Promise<Map<string, StepRecord>> {
  const prefix = RunKeys.stepsPrefix(runId);
  const keys = await listKeys(store, prefix);
  const records = await Promise.all(keys.map((k) => readRecord(store, k, StepRecord)));
  const out = new Map<string, StepRecord>();
  for (const r of records) if (r !== null) out.set(r.name, r);
  return out;
}

export async function writeStepRecord(
  store: ObjectStore,
  runId: string,
  status: StepStatus,
): Promise<void> {
  await writeJson(store, RunKeys.step(runId, status.name), { v: 1, ...status });
}

export interface RunSnapshot {
  run: RunRecord;
  pipeline: PipelineRecord | null;
  steps: Map<string, StepRecord>;
  cancel: CancelRecord | null;
  summary: RunSummary | null;
  /** null when the engine has no instance for the run (yet). */
  instance: InstanceStatusLike | null;
}

export async function loadRunSnapshot(
  store: ObjectStore,
  runId: string,
  instance: InstanceStatusLike | null,
): Promise<RunSnapshot | null> {
  const run = await readRecord(store, RunKeys.run(runId), RunRecord);
  if (run === null) return null;
  const [pipeline, steps, cancel, summary] = await Promise.all([
    readRecord(store, RunKeys.pipeline(runId), PipelineRecord),
    readStepRecords(store, runId),
    readRecord(store, RunKeys.cancel(runId), CancelRecord),
    readRecord(store, RunKeys.summary(runId), RunSummary),
  ]);
  return { run, pipeline, steps, cancel, summary, instance };
}

const TERMINAL_STEP = new Set(["passed", "failed", "errored", "skipped", "cancelled"]);

function emptyStep(name: string, kind: "user" | "evidence"): StepStatus {
  return {
    name,
    kind,
    status: "queued",
    durationMs: null,
    logRef: null,
    cacheHit: false,
    exitCode: null,
    startedAt: null,
    finishedAt: null,
  };
}

function stripRecord(r: StepRecord): StepStatus {
  const { v: _v, ...rest } = r;
  return rest;
}

export function summaryToStatus(summary: RunSummary): RunStatus {
  const { evidence: _e, evidenceErrors: _ee, ...status } = summary;
  return status;
}

/** Folds the stored records and the instance status into a `RunStatus`. Pure. */
export function buildRunStatus(s: RunSnapshot): RunStatus {
  if (s.summary !== null) return summaryToStatus(s.summary);

  const declared: StepStatus[] = [];
  const seen = new Set<string>();
  if (s.pipeline !== null) {
    for (const step of s.pipeline.pipeline.steps) {
      declared.push(
        s.steps.has(step.name)
          ? stripRecord(s.steps.get(step.name)!)
          : emptyStep(step.name, "user"),
      );
      seen.add(step.name);
    }
    for (const step of s.pipeline.evidenceSteps) {
      declared.push(
        s.steps.has(step.name)
          ? stripRecord(s.steps.get(step.name)!)
          : emptyStep(step.name, "evidence"),
      );
      seen.add(step.name);
    }
  }
  for (const [name, record] of s.steps) if (!seen.has(name)) declared.push(stripRecord(record));

  let status: RunState;
  let error: string | undefined;
  let finishedAt: string | null = null;
  const inst = s.instance?.status ?? null;
  if (s.cancel !== null) {
    status = s.cancel.superseded ? "superseded" : "cancelled";
    finishedAt = s.cancel.at;
  } else if (inst === null || inst === "queued") {
    status = "queued";
  } else if (inst === "errored") {
    status = "failed";
    error = s.instance?.error?.message ?? "the CI workflow failed";
  } else if (inst === "terminated") {
    status = "cancelled";
  } else if (inst === "complete") {
    const out = RunOutput.safeParse(s.instance?.output);
    status = out.success ? out.data.status : "failed";
    if (out.success) {
      finishedAt = out.data.finishedAt;
      if (out.data.error !== undefined) error = out.data.error;
    } else {
      error = "the CI workflow finished without a summary";
    }
  } else {
    status = "running";
  }

  const ended =
    status === "cancelled" || status === "superseded" || status === "failed" || status === "passed";
  const steps = ended
    ? declared.map((st) =>
        TERMINAL_STEP.has(st.status) ? st : { ...st, status: "cancelled" as const },
      )
    : declared;

  return {
    id: s.run.runId,
    changeId: s.run.changeId,
    headSha: s.run.headSha,
    baseSha: s.run.baseSha,
    engine: s.run.engine,
    status,
    startedAt: s.run.createdAt,
    finishedAt,
    steps,
    pipelineSource: s.pipeline?.source ?? null,
    warnings: s.pipeline?.pipeline.warnings ?? [],
    ...(error === undefined ? {} : { error }),
  };
}

export function isSupersededReason(reason: string): boolean {
  return reason.trim().toLowerCase().startsWith(SUPERSEDED_PREFIX);
}
