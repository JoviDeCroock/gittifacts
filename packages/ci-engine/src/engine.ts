/**
 * The `CiEngine` contract shared by both implementations, and the wire types that cross it.
 * Everything here is zod-validated: requests come from the coordinator, statuses go to the API.
 */
import { EvidenceItem, Sha } from "@app/evidence";
import { z } from "zod";
import { EvidenceStepList } from "./evidence-steps.js";
import { PipelineSpec } from "./plan/spec.js";

export const ENGINE_KINDS = ["workflows", "cloudflare-ci"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];
export const EngineKind = z.enum(ENGINE_KINDS);

/** Also the Workflow instance id: letters, digits, `_`, `-`; at most 100 characters. */
export const RunId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "run ids are [A-Za-z0-9_-]{1,100}");

/**
 * Who may reuse cached snapshots. A Change should write only to its own scope and read its own
 * scope first, then the default branch's: a Change can then never poison another Change's cache.
 */
export const CacheScopes = z
  .object({
    write: z.string().min(1).max(200),
    read: z.array(z.string().min(1).max(200)).min(1).max(4),
  })
  .strict();
export type CacheScopes = z.infer<typeof CacheScopes>;

export const RunRequest = z
  .object({
    runId: RunId,
    changeId: z.string().min(1).max(64),
    repo: z
      .object({ remote: z.string().url().max(500), tokenProvider: z.literal("artifacts") })
      .strict(),
    /** Artifacts repository (the Change's fork) to check out and to mint read tokens for. */
    artifactsRepo: z.string().min(1).max(100),
    headSha: Sha,
    baseSha: Sha,
    /**
     * The user pipeline. When omitted the run resolves it in a `plan` step: `.platform/ci.ts`
     * evaluated in a sandbox, or the default pipeline, read at `pipelineFrom`.
     */
    pipeline: PipelineSpec.optional(),
    /** Platform-mandated steps appended after the user steps. Omitted: `defaultEvidenceSteps()`. */
    evidenceSteps: EvidenceStepList.optional(),
    /** Where an omitted pipeline is read from. `base` (default) keeps a Change from editing its own CI. */
    pipelineFrom: z.enum(["base", "head"]).default("base"),
    /** Omitted: the fork's own scope only. */
    cache: CacheScopes.optional(),
    budget: z
      .object({
        maxMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
      })
      .strict(),
  })
  .strict();
/** What callers pass to `start()`. */
export type RunRequest = z.input<typeof RunRequest>;
/** Validated request; also the Workflow params. */
export type CiRunParams = z.output<typeof RunRequest>;

export const RunState = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "cancelled",
  "superseded",
]);
export type RunState = z.infer<typeof RunState>;

/** `errored`: the platform could not run the step (container, checkout, ...), as opposed to a non-zero exit. */
export const StepState = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "errored",
  "skipped",
  "cancelled",
]);
export type StepState = z.infer<typeof StepState>;

const IsoDate = z.string().datetime();

export const StepStatus = z.object({
  name: z.string(),
  kind: z.enum(["user", "evidence"]),
  status: StepState,
  durationMs: z.number().nonnegative().nullable(),
  /** R2 key of the redacted combined log. */
  logRef: z.string().nullable(),
  cacheHit: z.boolean(),
  exitCode: z.number().int().nullable(),
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  /** Why the step was skipped/errored, or that it timed out. */
  reason: z.string().max(4000).optional(),
  /** Last part of the redacted output (failed and errored steps only). */
  tail: z
    .string()
    .max(16 * 1024)
    .optional(),
});
export type StepStatus = z.infer<typeof StepStatus>;

/** Mirrors `PipelineRun` in docs/api.md, with extra fields. */
export const RunStatus = z.object({
  id: RunId,
  changeId: z.string(),
  headSha: Sha,
  baseSha: Sha,
  engine: EngineKind,
  status: RunState,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  steps: z.array(StepStatus),
  pipelineSource: z.enum(["file", "default", "request"]).nullable(),
  warnings: z.array(z.string()),
  /** Run-level failure that is not a step's (e.g. the pipeline file is invalid). */
  error: z.string().optional(),
});
export type RunStatus = z.infer<typeof RunStatus>;

export const EvidenceError = z.object({ step: z.string(), message: z.string().max(4000) });
export type EvidenceError = z.infer<typeof EvidenceError>;

/** What the coordinator receives when a run finishes (not when it is cancelled). */
export const RunSummary = RunStatus.extend({
  status: z.enum(["passed", "failed"]),
  finishedAt: IsoDate,
  evidence: z.array(EvidenceItem),
  /** Evidence steps that ran but produced no valid evidence, or did not run. Unknown → escalate. */
  evidenceErrors: z.array(EvidenceError),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** Where finished runs are reported. The coordinator implements it (e.g. on its Durable Object). */
export interface RunSink {
  onRunFinished(summary: RunSummary): Promise<unknown>;
}

export interface CiEngine {
  readonly kind: EngineKind;
  /** Idempotent per `runId`; a second call for the same run returns the same run. */
  start(req: RunRequest): Promise<{ runId: string }>;
  status(runId: string): Promise<RunStatus>;
  /**
   * Stops the run and its containers. Safe to call repeatedly and on finished runs (no-op).
   * A reason starting with "superseded" reports the run as `superseded`.
   */
  cancel(runId: string, reason: string): Promise<void>;
  /** Re-runs `step` and everything after it, keeping earlier results. */
  restartFrom(runId: string, step: string): Promise<void>;
}

export const SUPERSEDED_PREFIX = "superseded";

export class RunNotFoundError extends Error {
  override readonly name = "RunNotFoundError";
  constructor(readonly runId: string) {
    super(`CI run ${runId} not found`);
  }
}

export class RunConflictError extends Error {
  override readonly name = "RunConflictError";
}

export class InvalidRunRequestError extends Error {
  override readonly name = "InvalidRunRequestError";
}

/** A deterministic run id per (changeId, headSha): `r-<32 hex>`. */
export async function deriveRunId(changeId: string, headSha: string, attempt = 0): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${changeId}\n${headSha}\n${attempt}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `r-${hex.slice(0, 32)}`;
}
