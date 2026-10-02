/**
 * report.md: gates, per-scenario results, baselines, what each mechanism earns, and the knobs.
 * Deterministic: depends only on the runs (no wall-clock values).
 */
import { type GatesRun, mean } from "./gates.js";
import { MODES } from "./modes.js";
import { SCENARIOS } from "./scenarios.js";
import type { RunMetrics } from "./sim.js";

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${(100 * x).toFixed(2)}%`;

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function runsOf(r: GatesRun, scenario: string, mode: string): RunMetrics[] {
  return r.runs.filter((x) => x.scenario === scenario && x.mode === mode);
}

function avg(rs: RunMetrics[], f: (m: RunMetrics) => number): number {
  return mean(rs.map(f));
}

function gatesSection(r: GatesRun): string {
  return [
    "## Gates (§6)",
    "",
    `Every gate must hold for every seed (${r.seeds.join(", ")}). \`pnpm --filter @sim/merge-queue gates\` exits non-zero otherwise.`,
    "",
    table(
      ["", "gate", "result"],
      r.gates.map((g) => [g.pass ? "PASS" : "**FAIL**", g.name, g.detail]),
    ),
  ].join("\n");
}

function scenarioSection(r: GatesRun): string {
  const rows = Object.keys(SCENARIOS)
    .map((s) => [s, runsOf(r, s, "full")] as const)
    .filter(([, rs]) => rs.length > 0)
    .map(([s, rs]) => [
      s,
      f1(avg(rs, (m) => m.arrivals)),
      f1(avg(rs, (m) => m.throughputPerHour)),
      `${f1(avg(rs, (m) => m.timeInQueueMin.p50))} / ${f1(avg(rs, (m) => m.timeInQueueMin.p95))} / ${f1(avg(rs, (m) => m.timeInQueueMin.p99))}`,
      f2(avg(rs, (m) => m.ciRatio)),
      pct(avg(rs, (m) => m.ejectRate)),
      pct(avg(rs, (m) => m.falseEjectRate)),
      `${avg(rs, (m) => m.resolver.textual.resolved + m.resolver.semantic.resolved).toFixed(0)}/${avg(rs, (m) => m.resolver.textual.incidents + m.resolver.semantic.incidents).toFixed(0)}`,
      String(rs.reduce((a, m) => a + m.mainRedEvents, 0)),
      `${rs.reduce((a, m) => a + m.attributionFailures, 0)}/${rs.reduce((a, m) => a + m.regressions, 0)}`,
      f2(avg(rs, (m) => m.avgBatchSize)),
      f1(avg(rs, (m) => m.freezes)),
      f1(avg(rs, (m) => m.quarantines)),
    ]);
  return [
    "## Results per scenario (full queue, mean over seeds)",
    "",
    "Time in queue is enqueue → merged, in minutes; Changes still unmerged when the run ends count with their wait so far (conservative). CI ratio = CI minutes per merged Change ÷ one isolated full run (the scenario's median CI duration). False eject = ejected for a test failure although the Change is not broken and has no unresolved semantic partner in main or the queue (a flake or a misattribution).",
    "",
    table(
      ["scenario", "arrivals", "merged/h", "time in queue p50 / p95 / p99", "CI ratio", "eject", "false eject", "resolved / conflicts", "main red", "attribution fail / regressions", "batch size", "freezes", "quarantines"],
      rows,
    ),
  ].join("\n");
}

function baselineSection(r: GatesRun): string {
  const modes = ["full", "serial", "batch-all", "no-speculation", "no-revalidation"].filter((m) => runsOf(r, "gate-200", m).length > 0);
  const rows = modes.map((mode) => {
    const rs = runsOf(r, "gate-200", mode);
    return [
      `${mode}${MODES[mode] ? ` (${MODES[mode]?.label})` : ""}`,
      f1(avg(rs, (m) => m.throughputPerHour)),
      f1(avg(rs, (m) => m.backlogAtArrivalEnd)),
      `${f1(avg(rs, (m) => m.timeInQueueMin.p50))} / ${f1(avg(rs, (m) => m.timeInQueueMin.p95))}`,
      f2(avg(rs, (m) => m.ciRatio)),
      pct(avg(rs, (m) => m.ejectRate)),
      pct(avg(rs, (m) => m.falseEjectRate)),
      String(rs.reduce((a, m) => a + m.mainRedEvents, 0)),
    ];
  });
  return [
    "## Baselines on gate-200",
    "",
    "Same workload (same seeds) for every configuration. *Strictly serial* is the coordinator's original queue expressed as a configuration of the core (FIFO, one Change at a time, rebase + full re-test + CAS, conflicts and red runs eject). *Batch everything* keeps every mechanism except the conflict graph: one speculative chain.",
    "",
    table(["configuration", "merged/h", "backlog at end of arrivals", "time in queue p50 / p95", "CI ratio", "eject", "false eject", "main red"], rows),
  ].join("\n");
}

function mechanismSection(r: GatesRun): string {
  const rows = r.comparisons.map((c) => [
    c.mechanism,
    c.scenario,
    `${c.metric} (${c.better} is better)`,
    c.metric.endsWith("Rate") ? pct(c.full) : f2(c.full),
    c.metric.endsWith("Rate") ? pct(c.ablated) : f2(c.ablated),
    c.wins ? "yes" : "**no**",
    c.why,
  ]);
  const losers = r.comparisons.filter((c) => !c.wins);
  return [
    "## What each mechanism earns",
    "",
    "Each row switches one mechanism off (`no-*` modes in `src/modes.ts`) on the scenario where it should matter most, and compares the metric it exists for (mean over seeds).",
    "",
    table(["mechanism", "scenario", "metric", "with", "without", "earns its keep", "why it exists"], rows),
    "",
    losers.length === 0
      ? "Every mechanism beats its simpler alternative on the metric it exists for."
      : `Not beating the simpler alternative on this run: ${losers.map((c) => c.mechanism).join(", ")}. See "Decisions" below.`,
  ].join("\n");
}

const DECISIONS = `## Decisions the simulator forced (and mechanisms removed)

- **Tracks are a speculation DAG, not chains that drain.** The first design made a Change that conflicts with two tracks wait until both drained. With 5% cross-cutting Changes, tracks were draining permanently (gate-200 throughput ≈ 25/h). Now each batch is built on exactly the batches it conflicts with: on one predecessor's tip, or as a merge batch rebuilt on main carrying the predecessors' unmerged entries. Independent work never waits for unrelated work.
- **Speculation depth is the longest chain of untested ancestors**, not their count. Counting all of them made a Change with an unknown affected set (conflicts with everything) exceed the depth limit and, through priority order, block the whole repo twice an hour. Merge batches skip the depth limit (everything after them still respects it).
- **Revalidation runs in small pipelined landing batches** (≤ 2 passed batches each, up to 16 stacked). One landing batch per sweep of all ready batches meant "impacted targets" ≈ the whole suite and every landing took a full run (passed → merged p50 8 min instead of 2.5).
- **A batch built on an in-flight predecessor stays open for joiners for 2 minutes.** It can't land before its parent anyway: CI ratio 1.11× → 0.73× on the failure-free workload for +1.4 min of p95.
- **A batch can't grow once anything descends from it.** A unit joining an unbuilt batch after a merge batch had copied its lineage made the descendant's lineage incomplete (found by the simulator as repeated full-run fallbacks; would have been unsound).
- **A quarantined test's failure is still re-checked; only failures that also happen on main are excused.** Masking every failure of a quarantined test let a real regression land (a main-red event once the flaky test was fixed and un-quarantined).
- **Removed: a cap on what a merge batch may carry** (wait for the in-flight set to shrink, then force a drain). Cross-cutting Changes tripped it constantly; forced drains cost more than the invalidations they avoided (gate-200 p95 54 → 102 min).
- **Demoted: the global in-flight cap** is a safety limit (128), not a batching device: at 16 it serialized independent components instead of growing batches.

The CI model assumes **fail-fast** runs (a failing run reports when its failing test finishes): the engine reports step status, so the BatchRunWorkflow can report a failure as soon as a required step fails.`;

function latencySection(r: GatesRun): string {
  const g = runsOf(r, "gate-200", "full");
  if (g.length === 0) return "";
  const gate = r.gates.find((x) => x.name.startsWith("gate-200: p95"));
  return `## The latency gate, honestly

${gate?.pass ? "The p95 gate holds on every seed." : `The p95 gate **does not hold** (${gate?.detail}). Median time in queue is ${f1(avg(g, (m) => m.timeInQueueMin.p50))} min (≈ one CI run + landing), and CI cost, false ejects and main-red are well inside their gates; the tail is not.`}

Where the tail comes from (measured with \`MQ_DEBUG_TAIL=1\`): in gate-200 a Component receives ~25 conflicting Changes/hour against a 10-minute run, so 4–5 Changes are always speculating on top of each other. A real failure (a broken Change or a semantic conflict, ≈3% of Changes here) invalidates every batch built on it: about ten entries restart per failure, so roughly a third of all Changes absorb at least one restart (≈ +15 min). The fixed part of the pipeline (analyzer, run p95 ≈ 12.8 min, revalidation and CAS) is ≈ 16 min, so the 20-minute budget leaves room for almost no restarts. At 0.5% broken / 1% semantic the p95 is ≈ 25–30 min; only below ≈ 0.5% failing Changes does it approach 20.

Shallower speculation makes it worse (depth 3: p95 222 min, depth 5: 79 min: arrivals wait for slots). What would move it: speculating on both outcomes for batches the predictor marks risky (SubmitQueue's speculation tree: build the next batch on the parent too, so a failure costs no restart), and re-using cached results of targets the culprit doesn't touch when a victim re-runs. Neither is implemented; they are the next step if the 2× target stands.`;
}

function knobsSection(): string {
  const rows = Object.values(SCENARIOS).map((s) => [
    s.name,
    String(s.arrivalsPerHour),
    `${s.hours}h`,
    pct(s.conflictDensity),
    pct(s.trueFailureRate),
    pct(s.flakyRate) + (s.hotFlaky.tests > 0 ? ` + ${s.hotFlaky.tests}×${pct(s.hotFlaky.failProb)}` : ""),
    `${s.semanticConflictRate} / ${s.textualConflictRate}`,
    `${s.ci.medianMinutes}m σ${s.ci.sigma}`,
    `${pct(s.stacks.rate)} / ${pct(s.planGroups.rate)}`,
    pct(s.unknownAffectedRate),
    pct(s.prodRegressionRate),
    String(s.postMergeFailures),
    s.description,
  ]);
  return [
    "## Workload knobs",
    "",
    "Conflict density is calibrated: the repo model (K clusters × 4 modules × 12 files, module 0 is each cluster's core and puts the whole cluster in the reverse-dependency closure) picks K so two random Changes' affected sets overlap with that probability. Semantic/textual rates are per *concurrent* overlapping (file-sharing) pair; the analyzer is sound (interactions only happen between overlapping sets, which is what impacted-target revalidation relies on).",
    "",
    table(["scenario", "arrivals/h", "window", "conflict density", "broken", "flaky runs", "semantic / textual pair rate", "CI", "stacks / plan groups", "unknown affected", "prod regressions", "post-merge failures", "description"], rows),
  ].join("\n");
}

export function renderReport(r: GatesRun): string {
  return [
    "# Merge-queue simulator report",
    "",
    "Generated by `pnpm --filter @sim/merge-queue gates` (deterministic: same seeds ⇒ identical report). The simulator drives the real `@app/merge-queue` core and deploy-train machine against a seeded fake world (see `src/sim.ts`, `src/workload.ts`).",
    "",
    gatesSection(r),
    "",
    scenarioSection(r),
    "",
    baselineSection(r),
    "",
    mechanismSection(r),
    "",
    latencySection(r),
    "",
    DECISIONS,
    "",
    knobsSection(),
    "",
    `Workloads: ${r.workloads.map((w) => `${w.scenario}#${w.seed} K=${w.clusters} (density ${pct(w.density)})`).join("; ")}.`,
    "",
  ].join("\n");
}
