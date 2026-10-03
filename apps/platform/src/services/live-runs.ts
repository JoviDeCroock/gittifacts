/**
 * Live step status for runs in flight. D1 holds a run's steps only once the run sink records its
 * summary (until then they are `[]`); the CI engine writes each step's record to R2 as it starts
 * and finishes (`ci-runs/<run>/steps/<step>.json`), next to the resolved pipeline. Folding those
 * gives queued/running/passed/failed per step, with elapsed time, while the run is still going.
 */
import { buildRunStatus, loadRunSnapshot, type ObjectStore } from "@app/ci-engine";
import type { PipelineRun } from "@app/domain";

type Step = PipelineRun["steps"][number];

const STEP_STATUS: Record<string, Step["status"]> = {
  queued: "pending",
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  errored: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
};

export interface EngineStep {
  name: string;
  kind: "user" | "evidence";
  status: string;
  durationMs: number | null;
  logRef: string | null;
  cacheHit?: boolean | undefined;
  startedAt?: string | null | undefined;
}

/** One engine step as the API serves it, with elapsed time as of `now`. */
export function liveStep(s: EngineStep, now: number): Step {
  const status =
    s.cacheHit === true && s.status === "passed" ? "cached" : (STEP_STATUS[s.status] ?? "failed");
  const started = s.startedAt == null ? Number.NaN : Date.parse(s.startedAt);
  const elapsedMs =
    status === "running" && !Number.isNaN(started)
      ? Math.max(0, now - started)
      : (s.durationMs ?? undefined);
  return {
    name: s.name,
    kind: s.kind,
    status,
    durationMs: s.durationMs,
    logRef: s.logRef,
    startedAt: s.startedAt ?? null,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
  };
}

/** `runs` with the steps of every queued/running run read live from the engine's records. */
export async function withLiveSteps(
  bucket: ObjectStore,
  runs: readonly PipelineRun[],
  now: number,
): Promise<PipelineRun[]> {
  return Promise.all(
    runs.map(async (run) => {
      if (run.status !== "queued" && run.status !== "running") return run;
      try {
        const snapshot = await loadRunSnapshot(bucket, run.id, { status: "running" });
        if (snapshot === null) return run;
        const live = buildRunStatus(snapshot);
        if (live.steps.length === 0) return run;
        return { ...run, steps: live.steps.map((s) => liveStep(s, now)) };
      } catch {
        // Live detail is best effort: the stored run is still right, only less detailed.
        return run;
      }
    }),
  );
}
