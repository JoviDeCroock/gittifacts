/**
 * Aggregates per task × model (and per task across models): success rate, time-to-first-green
 * (median / p90), tool calls, wall clock, errors, cost. Pure; shared by the Worker, the report and
 * the gates script.
 *
 * Counting rules:
 * - `skipped` runs (task can't run here) are not counted; every other run is, including
 *   `blocked`, `model-error` and `infra-error` ones, which count as failures.
 * - TTFG statistics treat a run that never went green as +∞, so failures push the median up
 *   instead of disappearing from it. A statistic that lands on +∞ is reported as null.
 */
import type { RunResult } from "./results.js";
import type { TaskId } from "./tasks.js";

/** Nearest-rank percentile (p in (0, 100]); null for no data. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const v = s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
  return Number.isFinite(v) ? v : null;
}

/** Median (mean of the middle two for even counts); null for no data or an infinite median. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  const v = s.length % 2 === 1 ? s[Math.floor(mid)]! : (s[mid - 1]! + s[mid]!) / 2;
  return Number.isFinite(v) ? v : null;
}

export interface Stats {
  task: TaskId;
  /** Model short name, or "all" for the per-task pool. */
  model: string;
  runs: number;
  skipped: number;
  successes: number;
  successRate: number | null;
  ttfgMedianMs: number | null;
  ttfgP90Ms: number | null;
  medianToolCalls: number | null;
  medianWallMs: number | null;
  toolErrors: number;
  /** Most frequent platform error codes, descending. */
  topCodes: [string, number][];
  stops: Record<string, number>;
  neurons: number;
  costUsd: number;
}

export function stats(task: TaskId, model: string, all: readonly RunResult[]): Stats {
  const counted = all.filter((r) => r.stop !== "skipped");
  const successes = counted.filter((r) => r.success).length;
  const ttfg = counted.map((r) =>
    r.success && r.ttfgMs !== null ? r.ttfgMs : Number.POSITIVE_INFINITY,
  );
  const codes = new Map<string, number>();
  for (const r of counted) for (const c of r.errors.codes) codes.set(c, (codes.get(c) ?? 0) + 1);
  const stops: Record<string, number> = {};
  for (const r of all) stops[r.stop] = (stops[r.stop] ?? 0) + 1;
  return {
    task,
    model,
    runs: counted.length,
    skipped: all.length - counted.length,
    successes,
    successRate: counted.length ? successes / counted.length : null,
    ttfgMedianMs: median(ttfg),
    ttfgP90Ms: percentile(ttfg, 90),
    medianToolCalls: median(counted.map((r) => r.toolCalls)),
    medianWallMs: median(counted.map((r) => r.wallMs)),
    toolErrors: counted.reduce((n, r) => n + r.errors.tool, 0),
    topCodes: [...codes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5),
    stops,
    neurons: all.reduce((n, r) => n + r.neurons, 0),
    costUsd: Math.round(all.reduce((n, r) => n + r.costUsd, 0) * 10_000) / 10_000,
  };
}

export interface Aggregate {
  /** One row per task × model, tasks in order then models in order of first appearance. */
  cells: Stats[];
  /** One row per task, all models pooled. */
  tasks: Stats[];
  totals: { runs: number; neurons: number; costUsd: number };
}

export function aggregate(runs: readonly RunResult[], taskOrder: readonly TaskId[]): Aggregate {
  const models = [...new Set(runs.map((r) => r.modelShort))];
  const cells: Stats[] = [];
  const tasks: Stats[] = [];
  for (const t of taskOrder) {
    const forTask = runs.filter((r) => r.task === t);
    for (const m of models) {
      const rs = forTask.filter((r) => r.modelShort === m);
      if (rs.length) cells.push(stats(t, m, rs));
    }
    tasks.push(stats(t, "all", forTask));
  }
  return {
    cells,
    tasks,
    totals: {
      runs: runs.length,
      neurons: runs.reduce((n, r) => n + r.neurons, 0),
      costUsd: Math.round(runs.reduce((n, r) => n + r.costUsd, 0) * 10_000) / 10_000,
    },
  };
}
