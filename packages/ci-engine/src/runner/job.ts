/**
 * The RPC contract between the CI Workflow and the `Runner` Durable Object. Both directions are
 * validated: jobs on entry to the Runner, outcomes on return to the Workflow.
 */
import { Sha } from "@app/evidence";
import { z } from "zod";
import { NetworkPolicy } from "../engine.js";
import { InstanceType, MAX_STEP_TIMEOUT_MINUTES, RelativePath } from "../plan/spec.js";

export const MAX_TIMEOUT_SECONDS = (MAX_STEP_TIMEOUT_MINUTES + 5) * 60;

const Env = z.record(z.string(), z.string());

/** Above this many matched input files a step is cached per repository instead of globally. */
export const MAX_HERMETIC_INPUTS = 5_000;

/** Milliseconds per Runner phase (see `StepTimings`). */
export const RunnerTimings = z
  .object({
    containerStartMs: z.number().nonnegative().optional(),
    checkoutMs: z.number().nonnegative().optional(),
    hermeticMs: z.number().nonnegative().optional(),
    replayMs: z.number().nonnegative().optional(),
    commandMs: z.number().nonnegative().optional(),
    evidenceMs: z.number().nonnegative().optional(),
    snapshotMs: z.number().nonnegative().optional(),
  })
  .strict();
export type RunnerTimings = z.infer<typeof RunnerTimings>;

export const EgressReport = z.object({
  denied: z.number().int().nonnegative(),
  hosts: z.array(z.string()).max(20),
});
export type EgressReport = z.infer<typeof EgressReport>;

/** Accounting fields every Runner outcome carries. */
const Accounting = {
  /** Container start → destroy. */
  computeMs: z.number().nonnegative(),
  timings: RunnerTimings,
  egress: EgressReport,
};

export const ReplayStep = z
  .object({
    name: z.string().min(1).max(100),
    command: z.string().min(1),
    cwd: RelativePath.optional(),
    env: Env.optional(),
  })
  .strict();
export type ReplayStep = z.infer<typeof ReplayStep>;

export const StartFrom = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image") }).strict(),
  z
    .object({
      kind: z.literal("snapshot"),
      snapshotId: z.string().min(1).max(512),
      /** Commit the snapshot's workspace was at (differs from head on a cache hit). */
      sha: Sha,
    })
    .strict(),
]);
export type StartFrom = z.infer<typeof StartFrom>;

export const RunnerJob = z
  .object({
    runId: z.string().min(1).max(100),
    step: z.string().min(1).max(100),
    kind: z.enum(["user", "evidence"]),
    attempt: z.number().int().min(1).default(1),
    command: z.string().min(1),
    cwd: RelativePath.optional(),
    env: Env.default({}),
    instance: InstanceType,
    timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS),
    artifactsRepo: z.string().min(1).max(100),
    remote: z.string().url(),
    headSha: Sha,
    /** Also fetch this commit (with blobs) so the step can compare against it. */
    baseSha: Sha.optional(),
    from: StartFrom,
    /** Ancestor commands to re-run first when the parent snapshot is gone (fallback path). */
    replay: z.array(ReplayStep).max(50).default([]),
    /** Take a container snapshot when the command succeeds. */
    snapshot: z.boolean(),
    logKey: z.string().min(1).max(512),
    /** Evidence steps: where to store the validated evidence JSON. */
    evidenceKey: z.string().min(1).max(512).optional(),
    /** Cap on the stored log. */
    maxLogBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(100 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    network: NetworkPolicy.default("open"),
    /**
     * Global-scope cached steps: run the command with only these repository paths in
     * `/workspace` (their cache inputs), so the snapshot holds nothing else from the repository.
     */
    hermeticInputs: z.array(RelativePath).max(MAX_HERMETIC_INPUTS).optional(),
  })
  .strict();
export type RunnerJob = z.output<typeof RunnerJob>;
export type RunnerJobInput = z.input<typeof RunnerJob>;

export const RunnerErrorCode = z.enum([
  "invalid-job",
  "aborted",
  "token",
  "container-start",
  "snapshot-unavailable",
  "checkout",
  "replay",
  "exec",
  "snapshot",
  "internal",
]);
export type RunnerErrorCode = z.infer<typeof RunnerErrorCode>;

export const LogInfo = z.object({
  key: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type LogInfo = z.infer<typeof LogInfo>;

export const EvidenceCapture = z.union([
  z.object({ key: z.string(), count: z.number().int().nonnegative() }).strict(),
  z.object({ error: z.string().max(4000) }).strict(),
]);
export type EvidenceCapture = z.infer<typeof EvidenceCapture>;

export const RunnerOutcome = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      exitCode: z.number().int(),
      timedOut: z.boolean(),
      durationMs: z.number().nonnegative(),
      log: LogInfo,
      tail: z.string(),
      snapshot: z.object({ id: z.string(), size: z.number().nonnegative() }).nullable(),
      evidence: EvidenceCapture.nullable(),
      /** The command ran with only the hermetic inputs present. */
      hermetic: z.boolean(),
      ...Accounting,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: RunnerErrorCode,
      message: z.string(),
      durationMs: z.number().nonnegative(),
      log: LogInfo.nullable(),
      tail: z.string(),
      ...Accounting,
    })
    .strict(),
]);
export type RunnerOutcome = z.infer<typeof RunnerOutcome>;

export const PlanJob = z
  .object({
    runId: z.string().min(1).max(100),
    artifactsRepo: z.string().min(1).max(100),
    remote: z.string().url(),
    sha: Sha,
    baseSha: Sha.optional(),
    file: RelativePath,
    timeoutSeconds: z.number().int().min(10).max(600).default(120),
    logKey: z.string().min(1).max(512),
    /**
     * `registries-only` fails closed without the egress gateway. With `open`, plan mode still
     * locks egress down to the git host when the gateway is available: it never needs more.
     */
    network: NetworkPolicy.default("open"),
    instance: InstanceType.default("standard-1"),
  })
  .strict();
export type PlanJob = z.output<typeof PlanJob>;
export type PlanJobInput = z.input<typeof PlanJob>;

export const PlanOutcome = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int(),
      computeMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: RunnerErrorCode,
      message: z.string(),
      stderr: z.string(),
      computeMs: z.number().nonnegative(),
    })
    .strict(),
]);
export type PlanOutcome = z.infer<typeof PlanOutcome>;

/** What the Workflow needs from a Runner stub. Results are `unknown` and validated on arrival. */
export interface RunnerRpc {
  run(job: RunnerJobInput): Promise<unknown>;
  plan(job: PlanJobInput): Promise<unknown>;
  abort(reason: string): Promise<unknown>;
  clearAbort(): Promise<unknown>;
  /** `{ image: string | null }`: the image `start()` would use (no container is started). */
  describe(): Promise<unknown>;
}

export const RunnerDescription = z.object({ image: z.string().nullable() });

/** Durable Object name of the runner for one step of one run. */
export function runnerName(runId: string, step: string): string {
  return `${runId}:${step}`;
}

export const PLAN_RUNNER_STEP = "plan";
