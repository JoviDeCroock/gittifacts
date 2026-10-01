/**
 * The `CiEngine` contract shared by both implementations, and the wire types that cross it.
 * Everything here is zod-validated: requests come from the coordinator, statuses go to the API.
 */
import { EvidenceItem, Sha } from "@app/evidence";
import { z } from "zod";
import { EvidenceStepList } from "./evidence-steps.js";
import { InstanceType, PipelineSpec } from "./plan/spec.js";

export const ENGINE_KINDS = ["workflows", "cloudflare-ci"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];
export const EngineKind = z.enum(ENGINE_KINDS);

/** Also the Workflow instance id: letters, digits, `_`, `-`; at most 100 characters. */
export const RunId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "run ids are [A-Za-z0-9_-]{1,100}");

/**
 * Cache policy for a run.
 *
 * Repo-scoped steps: a Change should write only to its own scope (`write`) and read its own scope
 * first, then the default branch's (`read`), so a Change can never poison another Change's cache.
 * Default: the fork's own scope.
 *
 * Global-scoped steps (install-like root steps by default) share snapshots across repositories
 * whose cache inputs are byte-identical; they run hermetically (only their inputs present), so
 * the snapshot is a function of its key. `global` controls whether this run may read and write
 * them; unclaimed projects might get `read-only`.
 */
export const CacheScopes = z
  .object({
    write: z.string().min(1).max(200).optional(),
    read: z.array(z.string().min(1).max(200)).min(1).max(4).optional(),
    global: z.enum(["read-write", "read-only", "off"]).default("read-write"),
  })
  .strict();
export type CacheScopes = z.infer<typeof CacheScopes>;

/**
 * Per-run quotas. Every step's timeout is bounded by the minutes left; steps are clamped to
 * `instance`; each step's log is capped at `maxLogBytes`.
 */
export const RunLimits = z
  .object({
    maxMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    maxLogBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(100 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    instance: InstanceType.default("standard-4"),
    /** Cap on each uploaded build artifact (compressed). */
    maxArtifactBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(2 * 1024 * 1024 * 1024)
      .default(100 * 1024 * 1024),
  })
  .strict();
export type RunLimits = z.infer<typeof RunLimits>;

/**
 * Container egress. `registries-only`: every outbound HTTP(S) request goes through
 * `CiEgressGateway`, which allows the package registries and the repository's git host
 * (read-only) and answers everything else with 403 (logged in the step log). Other protocols
 * have no route at all.
 */
export const NetworkPolicy = z.enum(["open", "registries-only"]);
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

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
    cache: CacheScopes.optional(),
    limits: RunLimits.optional(),
    /** Deprecated: use `limits.maxMinutes`. */
    budget: z
      .object({
        maxMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
      })
      .strict()
      .optional(),
    network: NetworkPolicy.default("open"),
    /**
     * Seed run for a template: only the global-scoped cached steps run, no evidence, and their
     * snapshots are published for every repository with identical inputs.
     */
    seed: z
      .object({ templateId: z.string().min(1).max(100) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.limits === undefined && req.budget === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "limits (or the deprecated budget) is required",
        path: ["limits"],
      });
    }
  });
/** What callers pass to `start()`. */
export type RunRequest = z.input<typeof RunRequest>;
/** Validated request; also the Workflow params. */
export type CiRunParams = z.output<typeof RunRequest>;

/** Effective limits: `limits`, else the deprecated `budget` with default caps. */
export function resolveLimits(req: Pick<CiRunParams, "limits" | "budget">): RunLimits {
  if (req.limits !== undefined) return req.limits;
  return RunLimits.parse({ maxMinutes: req.budget?.maxMinutes ?? 30 });
}

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

/** An uploaded build artifact: `tar -cz` of the declared paths, in `CI_BUCKET`. */
export const ArtifactRef = z.object({
  key: z.string().min(1).max(512),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** Milliseconds per phase of one step. Phases a step didn't have are omitted. */
export const StepTimings = z.object({
  /** Dependencies satisfied → step body started (Workflow scheduling). */
  queueMs: z.number().nonnegative().optional(),
  /** `start()` → container ready (includes snapshot restore). */
  containerStartMs: z.number().nonnegative().optional(),
  checkoutMs: z.number().nonnegative().optional(),
  /** Reducing the workspace to the cache inputs (global-scope steps). */
  hermeticMs: z.number().nonnegative().optional(),
  /** Re-running ancestors when a parent snapshot was gone. */
  replayMs: z.number().nonnegative().optional(),
  commandMs: z.number().nonnegative().optional(),
  evidenceMs: z.number().nonnegative().optional(),
  /** Packing and uploading build artifacts. */
  artifactsMs: z.number().nonnegative().optional(),
  snapshotMs: z.number().nonnegative().optional(),
  /** Step body start → end, all of the above plus overhead. */
  totalMs: z.number().nonnegative(),
});
export type StepTimings = z.infer<typeof StepTimings>;

/** Resource use of a run, for per-project quotas. */
export const RunUsage = z.object({
  /** Container time across every step and attempt (cache hits cost nothing). */
  computeMs: z.number().nonnegative(),
  /** `computeMs` in minutes, rounded up to 0.01. */
  ciMinutes: z.number().nonnegative(),
  /** Container time per instance type, for weighting by size. */
  byInstance: z.record(z.string(), z.number().nonnegative()),
  /** Runner invocations (attempts and lineage replays included). */
  containers: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  logBytes: z.number().int().nonnegative(),
  /** Build artifacts uploaded by this run (cache-hit reuse costs nothing). */
  artifactBytes: z.number().int().nonnegative(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const RunTimings = z.object({
  /** Run created → finished. For a passed run this is its time-to-green. */
  totalMs: z.number().nonnegative(),
  planMs: z.number().nonnegative().optional(),
  prepareMs: z.number().nonnegative().optional(),
  /** Run created → first pipeline step started. */
  firstStepMs: z.number().nonnegative().optional(),
});
export type RunTimings = z.infer<typeof RunTimings>;

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
  /** Where the step's time went (for time-to-first-green). Absent for steps that never ran. */
  timings: StepTimings.optional(),
  /** Container time billed to the step, all attempts included. */
  computeMs: z.number().nonnegative().optional(),
  instance: InstanceType.optional(),
  /** Scope of the cache entry the step hit or wrote. */
  cacheScope: z.enum(["global", "repo"]).optional(),
  /** Build artifacts of the step, by name. */
  artifacts: z.record(z.string(), ArtifactRef).optional(),
  /** Outbound requests the egress gateway refused (network: registries-only). */
  egressDenied: z
    .object({ count: z.number().int().nonnegative(), hosts: z.array(z.string()).max(20) })
    .optional(),
});
export type StepStatus = z.infer<typeof StepStatus>;

export const RunArtifact = ArtifactRef.extend({ step: z.string() });
export type RunArtifact = z.infer<typeof RunArtifact>;

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
  /** Present once the run finished. */
  usage: RunUsage.optional(),
  timings: RunTimings.optional(),
  /** Build artifacts of passed steps, by artifact name (names are unique per pipeline). */
  artifacts: z.record(z.string(), RunArtifact).optional(),
  /** Container snapshot of each passed step that has one (e.g. `build`, for previews). */
  snapshots: z.record(z.string(), z.string()).optional(),
});
export type RunStatus = z.infer<typeof RunStatus>;

export const EvidenceError = z.object({ step: z.string(), message: z.string().max(4000) });
export type EvidenceError = z.infer<typeof EvidenceError>;

/** What the coordinator receives when a run finishes (not when it is cancelled). */
export const RunSummary = RunStatus.extend({
  status: z.enum(["passed", "failed"]),
  finishedAt: IsoDate,
  evidence: z.array(EvidenceItem),
  usage: RunUsage,
  timings: RunTimings,
  artifacts: z.record(z.string(), RunArtifact),
  snapshots: z.record(z.string(), z.string()),
  /** Set for template seed runs. */
  seed: z.object({ templateId: z.string() }).optional(),
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
  /**
   * Pre-builds a template's global-scope cached steps (its install) at `sha` and publishes the
   * snapshots, so every project created from the template hits them on its first run. Engines
   * that cannot do this leave it undefined.
   */
  seedCache?(req: SeedCacheRequest): Promise<{ runId: string }>;
}

export const SeedCacheRequest = z
  .object({
    templateId: z.string().min(1).max(100),
    /** The template's Artifacts repository and commit. */
    artifactsRepo: z.string().min(1).max(100),
    remote: z.string().url().max(500),
    sha: Sha,
    /** Omitted: resolved from the template like any run (`.platform/ci.ts` or defaults). */
    pipeline: PipelineSpec.optional(),
    limits: RunLimits.optional(),
    network: NetworkPolicy.default("open"),
  })
  .strict();
export type SeedCacheRequest = z.input<typeof SeedCacheRequest>;

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
