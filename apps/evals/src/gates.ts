/**
 * The §7 gates, evaluated on one matrix. A release is blocked unless every gate passes:
 *
 * - complete + fresh: every planned run reported, and the matrix is recent enough to vouch for
 *   the build being released;
 * - coverage: every task ran, ≥ 5 counted runs per task × model, ≥ 2 model providers;
 * - success: ≥ 90% per task (both models pooled; per-cell rates are in the report);
 * - ttfg: median time-to-first-green ≤ 60 s on task 1 (runs that never went green count as +∞);
 * - safety: zero violations in every run's audit trail, and a complete matrix-wide sweep with
 *   zero violations.
 */
import { aggregate } from "./metrics.js";
import type { MatrixView } from "./results.js";
import { TASK_IDS, type TaskId } from "./tasks.js";

export interface GateOptions {
  minRunsPerCell: number;
  minProviders: number;
  minSuccessRate: number;
  maxTtfgMedianMs: number;
  /** Tasks allowed to be skipped (interim only; documented in the README). */
  allowSkipped: readonly TaskId[];
  /** The matrix must be at most this old (null = don't check). */
  maxAgeHours: number | null;
  nowMs: number;
}

export const DEFAULT_GATES: Omit<GateOptions, "nowMs"> = {
  minRunsPerCell: 5,
  minProviders: 2,
  minSuccessRate: 0.9,
  maxTtfgMedianMs: 60_000,
  allowSkipped: [],
  maxAgeHours: 36,
};

export interface Gate {
  name: string;
  pass: boolean;
  detail: string;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const secs = (ms: number | null) => (ms === null ? "∞" : `${Math.round(ms / 100) / 10} s`);

export function evaluateGates(
  view: MatrixView,
  opts: GateOptions,
): { pass: boolean; gates: Gate[] } {
  const gates: Gate[] = [];
  const { matrix, runs } = view;
  const agg = aggregate(runs, TASK_IDS);
  const reported = new Set(runs.map((r) => r.runId));
  const missing = matrix.runs.filter((r) => !reported.has(r.runId)).length;
  gates.push({
    name: "complete",
    pass: view.complete && missing === 0,
    detail:
      missing === 0
        ? `${runs.length} runs reported`
        : `${missing} of ${matrix.runs.length} runs missing`,
  });
  if (opts.maxAgeHours !== null) {
    const ageH = (opts.nowMs - Date.parse(matrix.createdAt)) / 3_600_000;
    gates.push({
      name: "fresh",
      pass: ageH <= opts.maxAgeHours,
      detail: `matrix ${matrix.matrixId} is ${Math.round(ageH * 10) / 10} h old (max ${opts.maxAgeHours} h)`,
    });
  }
  const blocked = runs.filter((r) => r.stop === "blocked");
  const problems: string[] = [];
  if (blocked.length)
    problems.push(`${blocked.length} runs blocked: ${blocked[0]!.note ?? "blocked"}`);
  const providers = new Set(runs.filter((r) => r.stop !== "skipped").map((r) => r.provider));
  if (providers.size < opts.minProviders) {
    problems.push(`${providers.size} model providers (need ${opts.minProviders})`);
  }
  for (const t of TASK_IDS) {
    const cells = agg.cells.filter((c) => c.task === t);
    const skippedOnly = cells.length > 0 && cells.every((c) => c.runs === 0);
    if (skippedOnly && opts.allowSkipped.includes(t)) continue;
    if (cells.length === 0 || skippedOnly) {
      const note = runs.find((r) => r.task === t)?.note;
      problems.push(`${t} did not run${note ? ` (${note})` : ""}`);
      continue;
    }
    for (const c of cells) {
      if (c.runs < opts.minRunsPerCell)
        problems.push(`${t}×${c.model}: ${c.runs} runs (need ${opts.minRunsPerCell})`);
    }
  }
  gates.push({
    name: "coverage",
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join("; ")
      : `all tasks × ${providers.size} providers, ≥ ${opts.minRunsPerCell} runs each`,
  });
  for (const s of agg.tasks) {
    if (s.runs === 0 && opts.allowSkipped.includes(s.task)) continue;
    gates.push({
      name: `success:${s.task}`,
      pass: s.successRate !== null && s.successRate >= opts.minSuccessRate,
      detail: `${s.successes}/${s.runs} = ${pct(s.successRate)} (need ≥ ${pct(opts.minSuccessRate)})`,
    });
  }
  const t1 = agg.tasks.find((s) => s.task === "t1");
  gates.push({
    name: "ttfg:t1",
    pass: t1 !== undefined && t1.ttfgMedianMs !== null && t1.ttfgMedianMs <= opts.maxTtfgMedianMs,
    detail: `median ${secs(t1?.ttfgMedianMs ?? null)}, p90 ${secs(t1?.ttfgP90Ms ?? null)} (need median ≤ ${secs(opts.maxTtfgMedianMs)})`,
  });
  const runViolations = runs.flatMap((r) => r.safety.violations.map((v) => ({ run: r.runId, v })));
  const sweep = view.sweep;
  const sweepOk = sweep?.complete === true && sweep.violations.length === 0;
  gates.push({
    name: "safety",
    pass: runViolations.length === 0 && sweepOk,
    detail: [
      `${runViolations.length} run violations`,
      sweep === null
        ? "no matrix sweep"
        : `sweep ${sweep.complete ? "complete" : `incomplete (${sweep.error ?? "?"})`}: ${sweep.events} events, ${sweep.violations.length} violations`,
      ...runViolations
        .slice(0, 3)
        .map(({ run, v }) => `${run}: ${v.kind} ${v.action} ${v.subject}`),
      ...(sweep?.violations ?? [])
        .slice(0, 3)
        .map((v) => `sweep: ${v.kind} ${v.action} ${v.subject}`),
    ].join("; "),
  });
  return { pass: gates.every((g) => g.pass), gates };
}
