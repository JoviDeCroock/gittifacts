/**
 * The §6 gates and the baseline/ablation comparisons behind report.md.
 * Every gate must hold for every seed (CI fails otherwise).
 */
import { MODES, modeConfig } from "./modes.js";
import { getScenario, SCENARIOS } from "./scenarios.js";
import { type RunMetrics, simulate } from "./sim.js";
import { generate } from "./workload.js";

export interface GateResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Comparison {
  mechanism: string;
  scenario: string;
  /** Mode without the mechanism. */
  without: string;
  metric: string;
  better: "lower" | "higher";
  full: number;
  ablated: number;
  wins: boolean;
  why: string;
}

export interface GatesRun {
  seeds: number[];
  runs: RunMetrics[];
  gates: GateResult[];
  comparisons: Comparison[];
  workloads: { scenario: string; seed: number; clusters: number; density: number }[];
}

/** Which ablation shows each mechanism's value, on which scenario, by which metric. */
export const ABLATIONS: Omit<Comparison, "full" | "ablated" | "wins">[] = [
  { mechanism: "conflict graph (parallel tracks)", scenario: "gate-200", without: "batch-all", metric: "timeInQueueP95", better: "lower", why: "independent work doesn't wait behind, or get invalidated by, unrelated failures" },
  { mechanism: "speculation", scenario: "gate-200", without: "no-speculation", metric: "timeInQueueP95", better: "lower", why: "batch N+1 runs on N's tree before N finishes" },
  { mechanism: "bisection", scenario: "failure-heavy", without: "no-bisection", metric: "ciRatio", better: "lower", why: "finds the culprit in log rounds with parallel prefix probes instead of re-testing every unit" },
  { mechanism: "prediction (adaptive size, risky last)", scenario: "failure-heavy", without: "no-prediction", metric: "timeInQueueP95", better: "lower", why: "smaller batches when failures are likely; likely failures at the end so the passing prefix is found first" },
  { mechanism: "flake re-check + quarantine", scenario: "flaky-storm", without: "no-flake-recheck", metric: "falseEjectRate", better: "lower", why: "a failure that doesn't reproduce on the tree (or also fails on main) doesn't eject anyone" },
  { mechanism: "conflict resolver", scenario: "conflict-heavy", without: "no-resolver", metric: "ejectRate", better: "lower", why: "conflicts get fixed by an agent instead of bouncing back to the author" },
  { mechanism: "impacted-target revalidation", scenario: "gate-200", without: "no-revalidation", metric: "ciRatio", better: "lower", why: "a stale passed track re-runs only its own targets on the new main" },
  { mechanism: "fair queuing + in-flight cap", scenario: "runaway-agent", without: "no-fairness", metric: "othersP95", better: "lower", why: "one flooding session can't starve everyone else" },
];

export function metricOf(m: RunMetrics, metric: string): number {
  switch (metric) {
    case "timeInQueueP95":
      return m.timeInQueueMin.p95;
    case "othersP95":
      return m.timeInQueueOthersP95Min;
    case "ciRatio":
      return m.ciRatio;
    case "falseEjectRate":
      return m.falseEjectRate;
    case "ejectRate":
      return m.ejectRate;
    case "throughput":
      return m.throughputPerHour;
    default:
      throw new Error(`unknown metric ${metric}`);
  }
}

export const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Evaluate the §6 gates over full-mode runs. */
export function evaluateGates(runs: RunMetrics[]): GateResult[] {
  const full = runs.filter((r) => r.mode === "full");
  const gates: GateResult[] = [];
  const bad = (pred: (r: RunMetrics) => boolean) => full.filter(pred).map((r) => `${r.scenario}#${r.seed}`);
  const red = bad((r) => r.mainRedEvents > 0);
  gates.push({ name: "any scenario: main-red events = 0", pass: red.length === 0, detail: red.length === 0 ? `0 in ${full.length} runs` : `red in ${red.join(", ")}` });
  const attr = bad((r) => r.attributionFailures > 0);
  const regressions = full.reduce((a, r) => a + r.regressions, 0);
  gates.push({ name: "any scenario: attribution failures = 0", pass: attr.length === 0, detail: attr.length === 0 ? `0 failures over ${regressions} production regressions` : `failures in ${attr.join(", ")}` });
  const inv = bad((r) => r.invariantViolations.length > 0 || r.refsLeaked > 0 || r.resolver.laneDecreases > 0);
  gates.push({ name: "any scenario: no invariant violation, no leaked refs/queue/*, no lane decrease", pass: inv.length === 0, detail: inv.length === 0 ? "clean" : inv.join(", ") });
  const g = full.filter((r) => r.scenario === "gate-200");
  const ciMedian = getScenario("gate-200").ci.medianMinutes;
  const worst = (f: (r: RunMetrics) => number) => Math.max(...g.map(f));
  const p95 = worst((r) => r.timeInQueueMin.p95);
  gates.push({ name: `gate-200: p95 time-in-queue ≤ 2× median CI (${2 * ciMedian} min)`, pass: g.length > 0 && p95 <= 2 * ciMedian, detail: `worst seed ${p95.toFixed(1)} min (per seed: ${g.map((r) => r.timeInQueueMin.p95.toFixed(1)).join(", ")})` });
  const ci = worst((r) => r.ciRatio);
  gates.push({ name: "gate-200: CI minutes per merged Change ≤ 1.5× an isolated run", pass: g.length > 0 && ci <= 1.5, detail: `worst seed ${ci.toFixed(2)}× (per seed: ${g.map((r) => r.ciRatio.toFixed(2)).join(", ")})` });
  const fe = worst((r) => r.falseEjectRate);
  gates.push({ name: "gate-200: false-eject rate ≤ 1%", pass: g.length > 0 && fe <= 0.01, detail: `worst seed ${(100 * fe).toFixed(2)}% (per seed: ${g.map((r) => (100 * r.falseEjectRate).toFixed(2)).join(", ")})` });
  const t = full.filter((r) => r.scenario === "textual-corpus");
  const rate = (r: RunMetrics) => r.resolver.textual.resolved / Math.max(1, r.resolver.textual.incidents);
  const worstRate = Math.min(...t.map(rate));
  const downgrades = t.reduce((a, r) => a + r.resolver.laneDecreases, 0);
  gates.push({
    name: "textual conflicts (simulator resolver model): resolver success ≥ 80%, zero lane downgrades",
    pass: t.length > 0 && worstRate >= 0.8 && downgrades === 0,
    detail: `worst seed ${(100 * worstRate).toFixed(1)}% over ${t.map((r) => r.resolver.textual.incidents).join("/")} incidents; ${downgrades} lane decreases (${t.reduce((a, r) => a + r.resolver.laneDowngradesIgnored, 0)} lower re-classifications ignored)`,
  });
  return gates;
}

export interface GateJob {
  scenario: string;
  seed: number;
  mode: string;
}

/** Every (scenario, seed, mode) the gates and the report need. */
export function gateJobs(seeds: number[], scenarios: string[] = Object.keys(SCENARIOS), ablations = true): GateJob[] {
  const want = new Map<string, Set<string>>();
  for (const s of scenarios) want.set(s, new Set(["full"]));
  if (ablations) {
    want.get("gate-200")?.add("serial");
    for (const a of ABLATIONS) want.get(a.scenario)?.add(a.without);
  }
  const jobs: GateJob[] = [];
  for (const seed of seeds) for (const [scenario, modes] of want) for (const mode of modes) jobs.push({ scenario, seed, mode });
  return jobs;
}

export function runJob(j: GateJob): { metrics: RunMetrics; workload: GatesRun["workloads"][number] } {
  const w = generate(getScenario(j.scenario), j.seed);
  const metrics = simulate(w, { mode: j.mode, config: modeConfig(j.mode) });
  return { metrics, workload: { scenario: j.scenario, seed: j.seed, clusters: w.clusters, density: w.measuredDensity } };
}

export function summarizeGates(seeds: number[], runs: RunMetrics[], workloads: GatesRun["workloads"]): GatesRun {
  const has = (scenario: string, mode: string) => runs.some((r) => r.scenario === scenario && r.mode === mode);
  const comparisons: Comparison[] = ABLATIONS.filter((a) => has(a.scenario, "full") && has(a.scenario, a.without)).map((a) => {
    const f = mean(runs.filter((r) => r.scenario === a.scenario && r.mode === "full").map((r) => metricOf(r, a.metric)));
    const x = mean(runs.filter((r) => r.scenario === a.scenario && r.mode === a.without).map((r) => metricOf(r, a.metric)));
    return { ...a, full: f, ablated: x, wins: a.better === "lower" ? f < x : f > x };
  });
  const uniq = new Map(workloads.map((w) => [`${w.scenario}#${w.seed}`, w]));
  return { seeds, runs, gates: evaluateGates(runs), comparisons, workloads: [...uniq.values()] };
}

/** Sequential run (tests, small subsets). The CLI runs jobs in parallel processes. */
export function runGates(o: { seeds: number[]; log: (s: string) => void; scenarios?: string[]; ablations?: boolean }): GatesRun {
  const runs: RunMetrics[] = [];
  const workloads: GatesRun["workloads"] = [];
  for (const j of gateJobs(o.seeds, o.scenarios, o.ablations !== false)) {
    if (MODES[j.mode] === undefined) continue;
    const r = runJob(j);
    runs.push(r.metrics);
    workloads.push(r.workload);
    o.log(`${j.scenario} #${j.seed} ${j.mode}: p95 ${r.metrics.timeInQueueMin.p95.toFixed(1)}m ci ${r.metrics.ciRatio.toFixed(2)}x red ${r.metrics.mainRedEvents}`);
  }
  return summarizeGates(o.seeds, runs, workloads);
}
