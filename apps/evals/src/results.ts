/**
 * What the eval records: one RunResult per run, one MatrixSpec + SafetySweep per matrix. These are
 * the JSON documents in R2 (src/store.ts) and what `GET /matrices/:id` returns to the report and
 * gates scripts, so every reader validates them with these schemas.
 */
import { z } from "zod";
import { TASK_IDS } from "./tasks.js";

export const TaskIdSchema = z.enum(TASK_IDS);

export const StopReason = z.enum([
  /** The model answered without calling a tool. */
  "final",
  "step-cap",
  "time-cap",
  "token-cap",
  /** The model call kept failing after retries (infrastructure, not the platform). */
  "model-error",
  /** The task can't run here (e.g. task 2 without a published fixture). */
  "skipped",
  /** The platform refuses credential-less creation right now (kill switch): nothing ran. */
  "blocked",
  /** The run's Workflow failed or never reported (counted as a failure). */
  "infra-error",
]);
export type StopReason = z.infer<typeof StopReason>;

export const CheckItem = z.object({
  name: z.string(),
  pass: z.boolean(),
  detail: z.string(),
});
export type CheckItem = z.infer<typeof CheckItem>;

export const Violation = z.object({
  kind: z.enum(["agent-approval", "unclaimed-production", "unreviewed-merge", "unverifiable"]),
  seq: z.number().int().nullable(),
  action: z.string(),
  subject: z.string(),
  principalId: z.string().nullable(),
  detail: z.string(),
});
export type Violation = z.infer<typeof Violation>;

export const RunIds = z.object({
  repoIds: z.array(z.string()),
  changeIds: z.array(z.string()),
  planIds: z.array(z.string()),
  previewUrls: z.array(z.string()),
});
export type RunIds = z.infer<typeof RunIds>;

export const RunResult = z.object({
  v: z.literal(1),
  runId: z.string(),
  matrixId: z.string(),
  task: TaskIdSchema,
  model: z.string(),
  modelShort: z.string(),
  provider: z.string(),
  attempt: z.number().int(),
  stop: StopReason,
  /** Why the run was skipped / blocked / errored, when it was. */
  note: z.string().nullable(),
  success: z.boolean(),
  checks: z.array(CheckItem),
  startedAt: z.string(),
  endedAt: z.string(),
  wallMs: z.number(),
  turns: z.number().int(),
  toolCalls: z.number().int(),
  toolCounts: z.record(z.string(), z.number().int()),
  errors: z.object({
    /** Tool calls that failed (HTTP ≥ 400, MCP isError, bad arguments, unknown tool, network). */
    tool: z.number().int(),
    /** Platform `error.code`s seen in tool results, in order. */
    codes: z.array(z.string()),
  }),
  /** Time to first green: first preview 200 with a current ISO timestamp − run start. */
  ttfgMs: z.number().nullable(),
  ttfgSource: z.enum(["probe", "evidence", "check"]).nullable(),
  tokens: z.object({ prompt: z.number(), completion: z.number(), cached: z.number() }),
  neurons: z.number(),
  costUsd: z.number(),
  safety: z.object({ violations: z.array(Violation), subjects: z.number().int() }),
  ids: RunIds,
  finalMessage: z.string().nullable(),
});
export type RunResult = z.infer<typeof RunResult>;

export const RunPlan = z.object({
  runId: z.string(),
  task: TaskIdSchema,
  model: z.string(),
  attempt: z.number().int(),
});
export type RunPlan = z.infer<typeof RunPlan>;

export const MatrixSpec = z.object({
  v: z.literal(1),
  matrixId: z.string(),
  trigger: z.enum(["cron", "manual"]),
  platform: z.string(),
  createdAt: z.string(),
  tasks: z.array(TaskIdSchema),
  models: z.array(z.string()),
  runsPerCell: z.number().int(),
  concurrency: z.number().int(),
  runs: z.array(RunPlan),
});
export type MatrixSpec = z.infer<typeof MatrixSpec>;

/** The matrix-wide audit sweep over [from, to] (src/check/safety.ts). */
export const SafetySweep = z.object({
  from: z.string(),
  to: z.string(),
  /** False when the sweep could not reach `from` (page cap, API error): counts as a failure. */
  complete: z.boolean(),
  events: z.number().int(),
  violations: z.array(Violation),
  error: z.string().nullable(),
});
export type SafetySweep = z.infer<typeof SafetySweep>;

/** `GET /matrices/:id` and `/matrices/latest`. */
export const MatrixView = z.object({
  matrix: MatrixSpec,
  runs: z.array(RunResult),
  sweep: SafetySweep.nullable(),
  complete: z.boolean(),
});
export type MatrixView = z.infer<typeof MatrixView>;
