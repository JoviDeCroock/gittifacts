/**
 * Run watch (DO alarm): a batch "running" in the core whose BatchRunWorkflow instance already
 * ended (errored, terminated, or complete without its result arriving) will never hear back. The
 * run counts as errored now (the core retries it, then falls back or ejects with infra-error)
 * instead of after `runTimeoutMs` (90 min). Live 2026-10-11: the engine refused four landing
 * runs, the instances errored without a result and the landings sat "running" for 25+ min.
 * Unknown escalates: an instance the platform can't tell us about is left to the run timeout.
 */
import type { CoreEventInput, QueueState } from "@app/merge-queue";
import type { WorkflowHandle } from "../bindings.js";
import type { BatchRunParams } from "./batch-run.js";
import type { QueueStore } from "./store.js";

/** A run younger than this is not looked at (its instance may still be starting). */
export const RUN_WATCH_GRACE_MS = 60_000;

const ENDED: ReadonlySet<string> = new Set(["errored", "terminated", "complete"]);

export interface LostRun {
  batchId: string;
  runId: string;
  instanceId: string;
  status: string;
  error: string | null;
  changeIds: string[];
  attempts: number;
  /** The errored result the core gets in place of the one that never came. */
  event: Extract<CoreEventInput, { type: "BatchResult" }>;
}

export async function lostRuns(input: {
  state: QueueState;
  store: QueueStore;
  batchRuns: WorkflowHandle<BatchRunParams>;
  now: number;
}): Promise<LostRun[]> {
  const out: LostRun[] = [];
  for (const b of Object.values(input.state.batches)) {
    if (b.state !== "running" || b.runId === null || b.startedAt === null) continue;
    if (b.treeSha === null || input.now - b.startedAt < RUN_WATCH_GRACE_MS) continue;
    const run = input.store.getRun<{ instanceId?: unknown }>(b.runId);
    // Not created yet (the outbox still retries StartBatchRun, which shows as its own stall).
    if (typeof run?.instanceId !== "string") continue;
    if (input.store.getRun(`result:${b.runId}`) !== null) continue;
    let status: string;
    let error: string | null = null;
    try {
      const s = await (await input.batchRuns.get(run.instanceId)).status();
      status = s.status;
      error = s.error ?? null;
    } catch {
      continue;
    }
    if (!ENDED.has(status)) continue;
    out.push({
      batchId: b.id,
      runId: b.runId,
      instanceId: run.instanceId,
      status,
      error,
      changeIds: [...b.carried, ...b.units.flatMap((u) => u.changeIds)],
      attempts: b.infraRetries + 1,
      event: {
        type: "BatchResult",
        batchId: b.id,
        runId: b.runId,
        treeSha: b.treeSha,
        outcome: "errored",
        failingTests: [],
        scope: b.targets,
      },
    });
  }
  return out;
}
