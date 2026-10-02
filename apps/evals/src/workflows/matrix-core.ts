/**
 * A matrix: tasks × models × runs-per-cell, run with bounded concurrency. The orchestration is a
 * loop of durable ticks (start runs up to the concurrency limit, notice finished or failed ones),
 * then a matrix-wide audit sweep and a summary. The sweep is written last: a matrix with a sweep
 * is complete, which is what the gates read.
 */
import { z } from "zod";
import type { DurableStep } from "../agent/loop.js";
import { PlatformApi } from "../check/api.js";
import { sweepAudit } from "../check/safety.js";
import type { EvalConfig } from "../env.js";
import { DEFAULT_GATES, evaluateGates } from "../gates.js";
import { aggregate } from "../metrics.js";
import { findModel } from "../models.js";
import {
  type MatrixSpec,
  type RunPlan,
  type RunResult,
  type SafetySweep,
  TaskIdSchema,
} from "../results.js";
import { type ResultStore, runIdFor } from "../store.js";
import { TASK_IDS } from "../tasks.js";
import type { FetchLike } from "../tools/probe.js";
import { preflight, type RunParams, stubResult } from "./run-core.js";

export const MatrixParams = z.object({
  matrixId: z.string().min(1).max(64),
  trigger: z.enum(["cron", "manual"]),
  createdAt: z.string(),
  tasks: z.array(z.enum(TASK_IDS)).min(1),
  /** Model ids. */
  models: z.array(z.string()).min(1),
  runsPerCell: z.number().int().min(1).max(20),
  concurrency: z.number().int().min(1).max(20),
});
export type MatrixParams = z.infer<typeof MatrixParams>;

/** Interleaved (attempt-major), so the first runs in flight already cover every task × model. */
export function planRuns(p: MatrixParams): RunPlan[] {
  const runs: RunPlan[] = [];
  for (let attempt = 1; attempt <= p.runsPerCell; attempt++) {
    for (const task of p.tasks) {
      for (const model of p.models) {
        const short = findModel(model)?.short ?? model.replace(/[^a-z0-9]/gi, "").slice(-12);
        runs.push({ runId: runIdFor(p.matrixId, task, short, attempt), task, model, attempt });
      }
    }
  }
  return runs;
}

export type InstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "rollingBack"
  | "unknown";

export interface MatrixDeps {
  cfg: EvalConfig;
  store: ResultStore;
  step: DurableStep;
  sleep: (name: string, ms: number) => Promise<void>;
  fetcher: FetchLike;
  adminFetcher: FetchLike;
  adminToken: string | null;
  /** Starts a run (idempotent: an existing instance counts as started). */
  startRun: (params: RunParams) => Promise<void>;
  runStatus: (runId: string) => Promise<{ status: InstanceStatus; error?: string }>;
  stopRun: (runId: string) => Promise<void>;
  /** Pause between ticks (default 1 minute). */
  tickMs?: number;
}

export interface MatrixOutcome {
  matrixId: string;
  runs: number;
  pass: boolean;
}

const MAX_TICKS = 600;

/** Records a run no agent finished, unless the run recorded its own result meanwhile. */
async function writeStub(
  deps: MatrixDeps,
  matrixId: string,
  plan: RunPlan,
  stop: RunResult["stop"],
  note: string,
): Promise<void> {
  if (await deps.store.getRun(plan.runId)) return;
  const params = { ...plan, matrixId, task: TaskIdSchema.parse(plan.task) };
  await deps.store.putRun(stubResult(params, findModel(plan.model), stop, note));
}

export async function runMatrixCore(p: MatrixParams, deps: MatrixDeps): Promise<MatrixOutcome> {
  const { cfg, store } = deps;
  const runs = planRuns(p);
  const spec: MatrixSpec = {
    v: 1,
    matrixId: p.matrixId,
    trigger: p.trigger,
    platform: cfg.host,
    createdAt: p.createdAt,
    tasks: p.tasks,
    models: p.models,
    runsPerCell: p.runsPerCell,
    concurrency: p.concurrency,
    runs,
  };
  await deps.step("plan", "io", async () => {
    await store.putMatrix(spec);
    return true;
  });
  const blocked = await deps.step("preflight", "io", () => preflight(deps.fetcher, cfg.host));
  if (blocked !== null) {
    await deps.step("blocked", "io", async () => {
      for (const r of runs) await writeStub(deps, p.matrixId, r, "blocked", blocked);
      return true;
    });
  } else {
    const waves = Math.ceil(runs.length / p.concurrency);
    const deadline = Date.parse(p.createdAt) + waves * (cfg.maxWallMs + 10 * 60_000) + 30 * 60_000;
    let started = 0;
    for (let i = 0; i < MAX_TICKS; i++) {
      const t = await deps.step(`tick-${i}`, "io", async () => {
        const reported = await store.reportedRunIds(p.matrixId);
        const now = Date.now();
        for (const r of runs.slice(0, started)) {
          if (reported.has(r.runId)) continue;
          const s = await deps.runStatus(r.runId);
          let note: string | null = null;
          if (s.status === "errored" || s.status === "terminated") {
            note = `run workflow ${s.status}${s.error ? `: ${s.error}` : ""}`;
          } else if (s.status === "complete") {
            note = "run workflow finished without recording a result";
          } else if (now > deadline) {
            await deps.stopRun(r.runId).catch(() => {});
            note = "matrix deadline passed";
          }
          if (note !== null) {
            await writeStub(deps, p.matrixId, r, "infra-error", note);
            reported.add(r.runId);
          }
        }
        let next = started;
        let slots =
          p.concurrency - runs.slice(0, started).filter((r) => !reported.has(r.runId)).length;
        while (slots > 0 && next < runs.length) {
          const plan = runs[next]!;
          if (now > deadline) {
            await writeStub(
              deps,
              p.matrixId,
              plan,
              "infra-error",
              "never started: matrix deadline passed",
            );
            reported.add(plan.runId);
          } else {
            await deps.startRun({
              ...plan,
              matrixId: p.matrixId,
              task: TaskIdSchema.parse(plan.task),
            });
            slots--;
          }
          next++;
        }
        return { started: next, reported: reported.size };
      });
      started = t.started;
      if (t.reported >= runs.length) break;
      await deps.sleep(`wait-${i}`, deps.tickMs ?? 60_000);
    }
  }

  const sweep = await deps.step("sweep", "io", async (): Promise<SafetySweep> => {
    const from = Date.parse(p.createdAt);
    if (!deps.adminToken) {
      return {
        from: new Date(from).toISOString(),
        to: new Date().toISOString(),
        complete: false,
        events: 0,
        violations: [],
        error: "EVAL_ADMIN_TOKEN is not set",
      };
    }
    return sweepAudit(
      new PlatformApi(cfg.host, deps.adminToken, deps.adminFetcher),
      from,
      Date.now(),
    );
  });

  const pass = await deps.step("finalize", "io", async () => {
    const results = await store.listRuns(p.matrixId);
    const view = { matrix: spec, runs: results, sweep, complete: true };
    const gates = evaluateGates(view, { ...DEFAULT_GATES, maxAgeHours: null, nowMs: Date.now() });
    await store.putSummary(p.matrixId, {
      matrixId: p.matrixId,
      generatedAt: new Date().toISOString(),
      aggregate: aggregate(results, TASK_IDS),
      gates,
    });
    // Last: a matrix with a sweep is complete.
    await store.putSweep(p.matrixId, sweep);
    return gates.pass;
  });
  return { matrixId: p.matrixId, runs: runs.length, pass };
}
