/**
 * The CI engine's run sink. The CI workflow calls `onRunFinished(summary)` on the change's
 * ChangeCoordinator DO (`env.COORDINATOR.getByName(changeId)`); this persists the run and
 * delivers it to the ChangeWorkflow instance for (change, head) as a `ci-finished` event.
 * Summaries are validated leniently (the engine's schema is still moving); a summary for a
 * superseded head or for a merge-queue re-check run is stored but not forwarded.
 */
import type { PipelineRun, RunStatus } from "@app/domain";
import { Sha } from "@app/evidence";
import { z } from "zod";
import type { CoordinatorBindings } from "./bindings.js";
import { type CiFinishedEvent, EVENT_CI_FINISHED } from "./events.js";
import { changeWorkflowId, ciRunIdFor } from "./ids.js";
import type { CiRunStatus, Ports, RunSink } from "./ports.js";

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "passed",
  "failed",
  "cancelled",
  "superseded",
  "errored",
]);

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

const RUN_STATES = [
  "queued",
  "running",
  "passed",
  "failed",
  "cancelled",
  "superseded",
  "errored",
] as const;

/** The subset of the engine's `RunSummary` the coordinator relies on. */
export const CiRunSummary = z
  .object({
    id: z.string().min(1),
    changeId: z.string().min(1),
    headSha: Sha,
    baseSha: Sha.optional(),
    engine: z.string().default("workflows"),
    status: z.enum(RUN_STATES),
    startedAt: z.string().nullable().default(null),
    finishedAt: z.string().nullable().default(null),
    steps: z
      .array(
        z
          .object({
            name: z.string(),
            kind: z.enum(["user", "evidence"]).catch("user"),
            status: z.string(),
            durationMs: z.number().nonnegative().nullable().default(null),
            logRef: z.string().nullable().default(null),
            cacheHit: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    evidence: z.array(z.unknown()).default([]),
    evidenceErrors: z
      .array(z.object({ step: z.string(), message: z.string() }).passthrough())
      .default([]),
    /** Bundle produced by the pipeline's `build` step (not yet emitted by the engine). */
    outputs: z.object({ bundleRef: z.string().nullable().optional() }).passthrough().optional(),
    bundleRef: z.string().nullable().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type CiRunSummary = z.infer<typeof CiRunSummary>;

const STEP_STATUS: Record<string, PipelineRun["steps"][number]["status"]> = {
  queued: "pending",
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  errored: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
  cached: "cached",
};

/** Engine run (summary or status) → the domain `PipelineRun` the API serves. */
export function toPipelineRun(
  run: Pick<CiRunStatus, "id" | "changeId" | "headSha" | "engine" | "startedAt" | "finishedAt"> & {
    status: string;
    steps: ReadonlyArray<{
      name: string;
      kind: "user" | "evidence";
      status: string;
      durationMs: number | null;
      logRef: string | null;
      cacheHit?: boolean;
    }>;
  },
): PipelineRun {
  const status: RunStatus = (RUN_STATES as readonly string[]).includes(run.status)
    ? (run.status as RunStatus)
    : "errored";
  return {
    id: run.id,
    changeId: run.changeId,
    headSha: run.headSha,
    engine: run.engine === "cloudflare-ci" ? "cloudflare-ci" : "workflows",
    status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: run.steps.map((s) => ({
      name: s.name,
      kind: s.kind,
      status:
        s.cacheHit === true && s.status === "passed"
          ? "cached"
          : (STEP_STATUS[s.status] ?? "failed"),
      durationMs: s.durationMs,
      logRef: s.logRef,
    })),
  };
}

export function bundleRefOf(summary: CiRunSummary): string | null {
  return summary.outputs?.bundleRef ?? summary.bundleRef ?? null;
}

export type SinkOutcome =
  | { accepted: false; reason: string }
  | { accepted: true; forwarded: boolean; reason: string | null };

export interface CoordinatorRunSink extends RunSink {
  onRunFinished(summary: unknown): Promise<SinkOutcome>;
}

export function createRunSink(
  ports: Pick<Ports, "store">,
  bindings: CoordinatorBindings,
): CoordinatorRunSink {
  return {
    async onRunFinished(raw: unknown): Promise<SinkOutcome> {
      const parsed = CiRunSummary.safeParse(raw);
      if (!parsed.success) {
        return {
          accepted: false,
          reason: `invalid run summary: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        };
      }
      const summary = parsed.data;
      const run = toPipelineRun(summary);
      await ports.store.upsertRun(run);
      const instanceId = changeWorkflowId(summary.changeId, summary.headSha);
      // Only the full run of a ChangeWorkflow instance is forwarded (not merge-queue re-checks).
      if (summary.id !== ciRunIdFor(instanceId))
        return { accepted: true, forwarded: false, reason: "not a change workflow run" };
      const change = await ports.store.getChange(summary.changeId);
      if (change?.headSha !== summary.headSha)
        return { accepted: true, forwarded: false, reason: "head superseded" };
      const payload: CiFinishedEvent = {
        run,
        items: summary.evidence,
        evidenceErrors: summary.evidenceErrors.map((e) => ({
          step: e.step,
          message: e.message.slice(0, 4000),
        })),
        outputs: { bundleRef: bundleRefOf(summary) },
      };
      const instance = await bindings.changeWorkflow.get(instanceId);
      await instance.sendEvent({ type: EVENT_CI_FINISHED, payload });
      return { accepted: true, forwarded: true, reason: null };
    },
  };
}
