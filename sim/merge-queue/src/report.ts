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
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
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
      [
        "scenario",
        "arrivals",
        "merged/h",
        "time in queue p50 / p95 / p99",
        "CI ratio",
        "eject",
        "false eject",
        "resolved / conflicts",
        "main red",
        "attribution fail / regressions",
        "batch size",
        "freezes",
        "quarantines",
      ],
      rows,
    ),
  ].join("\n");
}

function baselineSection(r: GatesRun): string {
  const modes = ["full", "serial", "batch-all", "no-speculation", "no-revalidation"].filter(
    (m) => runsOf(r, "gate-200", m).length > 0,
  );
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
    table(
      [
        "configuration",
        "merged/h",
        "backlog at end of arrivals",
        "time in queue p50 / p95",
        "CI ratio",
        "eject",
        "false eject",
        "main red",
      ],
      rows,
    ),
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
    table(
      ["mechanism", "scenario", "metric", "with", "without", "earns its keep", "why it exists"],
      rows,
    ),
    "",
    losers.length === 0
      ? "Every mechanism beats its simpler alternative on the metric it exists for."
      : `Not beating the simpler alternative on this run: ${losers.map((c) => c.mechanism).join(", ")}. See "Decisions" below.`,
  ].join("\n");
}

const DECISIONS = `## Decisions the simulator forced (and mechanisms removed)

Numbers in this section are gate-200 mean p95 over 8 seeds (1–8) unless noted; each change was measured against the configuration just before it.

- **Direct carrying (§4.3 partial re-speculation).** A batch is built on main and carries only the unmerged entries its units directly conflict with (plus stacked dependencies and unit-mates), in landing order, instead of a predecessor's whole tree. Batch trees used to be transitive: a Change built on its predecessor's tip contained everything below it, and merge batches copied whole lineages (30–70 entries), so one culprit invalidated everything connected to it (≈ 11 restarts per failure, a third of all Changes restarted). Now a failure releases only the batches carrying the failed batch's entries; their own entries are placed again *ahead of* the trees that carry them, which keep running. Placement never carries an entry that must land after the unit (carried by a tree that carries it, or stacked on it), never orders an unplaced entry ahead of a tree that conflicts with it but lacks it, and never carries an entry parked behind another one or waiting for a human. With a 2-minute hold: 28.6 → 25.3; with everything below: 21.1 (tip-built) vs 19.8 on the gate seeds.
- **No batch hold by default.** Holding a batch open for joiners saved CI (0.76× vs 1.05×) but cost latency once batches carry only direct conflicts (25.3 → 21.3 without it). The hold remains a knob (\`batchHoldMs\`): held batches are built at once, so a textual conflict shows up in seconds, and are rebuilt when a joiner arrives; entries coming back never wait twice. Speculation depth 16 (20.3 → 20.0).
- **Early landing.** A batch whose full run should finish within 2.5 minutes may join the landing pipeline: its revalidation (impacted targets on the exact landing tree) runs alongside, and the CAS still waits for both verdicts; a failure voids that landing batch and those above it. 20.0 → 19.6, p50 14.0 → 12.8.
- **Tree-keyed result cache.** A batch whose built tree already passed a full run (clean verdicts only) takes that verdict instead of running, audited as \`merge-queue.result-reused\` with the original run ids: a result counts only for exactly that tree. A landing member whose revalidation needs every test (unknown affected set) lands alone, so its landing tree is usually exactly the tree its full run passed on: the barrier's second 10-minute run disappears instead of blocking the landing pipeline. 34.4 → 32.1 when added.
- **Bugs the simulator found (fixed).** Joining an open batch skipped the \`appendable\` check, so a conflicting change that had just landed was missing from its tree and it fell back to a full run (failure-free floor: max 30.5 → 18.5). A flake re-check finished on a batch a quarantine had just cancelled and bisected entries that were already waiting again. Two carried-conflict waits could point at each other and park both entries for good.
- **Removed: both-outcome speculation (twins, SubmitQueue).** A built batch got a twin built without its in-flight predecessor (or, under direct carrying, without one carried in-flight batch); if that predecessor failed, the twin replaced it. Measured: on predecessor tips 30.7 vs 30.3 at CI 0.89× vs 0.68×; under direct carrying 24.3 vs 25.3 at CI 1.49× (max 1.62×); forked only where the predicted remaining failure risk was ≥ 5% (predictions only chose where to fork): 19.1 vs 19.6 at CI 1.54× (over the CI gate); at ≥ 10%: 20.0 vs 19.6 at 1.20×. Not worth its CI. The property tests also found a twin that kept failing being forked again forever.
- **Removed: split on failure** (re-test every unit of a failed batch on its own at once instead of bisecting): 32.7 vs 25.3; the culprit is back in the index at once, new arrivals carry it and its second failure cascades. **Removed: re-placing bisection innocents on the cached probe tree**: it applied 0–1 times per run, because the batches that carried the failed batch are re-placed first and conflict with the innocents.
- **Speculation depth is the longest chain of untested predecessors**, not their count. Batches joining several components (e.g. an unknown affected set) skip the depth limit: making such a barrier wait for the deepest chain to drain would stall the whole repo.
- **Revalidation runs in small pipelined landing batches** (≤ 2 members each, up to 16 stacked); one landing batch per sweep made "impacted targets" ≈ the whole suite.
- **A batch can't grow once anything carries its entries**: the carrier's tree would miss the newcomer.
- **A quarantined test's failure is still re-checked; only failures that also happen on main are excused.** Masking every failure of a quarantined test let a real regression land.
- **Removed (earlier): prediction-driven batch sizing and ordering** (lost to a fixed size: p95 33.0 vs 54.0 min), **a cap on what a merge batch may carry** (54 → 102 min), and **holding merge batches until what they carry has passed** (p95 ≈ 257 min). Predictions are computed, returned to agents and logged against outcomes; they never skip a check and don't steer scheduling.
- **While frozen, only work that can land goes first** (reverts and incident fixes not stacked on ordinary work; exempt from the per-session fair share).
- **The global in-flight cap** (128) is a safety limit, not a batching device.

The CI model assumes **fail-fast** runs (a failing run reports when its failing test finishes): the engine reports step status, so the BatchRunWorkflow can report a failure as soon as a required step fails.`;

function latencySection(r: GatesRun): string {
  const g = runsOf(r, "gate-200", "full");
  if (g.length === 0) return "";
  const gate = r.gates.find((x) => x.name.startsWith("gate-200: p95"));
  return `## The latency gate, honestly

${gate?.pass ? "The p95 gate holds on every seed." : `The p95 gate **does not hold** (${gate?.detail}).`} Median time in queue is ${f1(avg(g, (m) => m.timeInQueueMin.p50))} min (≈ one CI run + landing); CI cost, false ejects, main-red and attribution are inside their gates.

How it got here (gate-200 mean p95 over seeds 1–8, each step against the one before; see "Decisions"): 34.4 min at the start → result cache 32.1 → joins check \`appendable\` (bug) 30.3 → held batches built at once, no second hold 28.0 → all-tests members land alone 28.6 (noise) → direct carrying 25.3 → no hold 21.3 → stale-order fix 20.3 → depth 16 20.0 → early landing 19.6 (max 22.6, CI 1.08×). Seeds 1–3 are 33.0/32.8/30.6 → ${g.map((m) => f1(m.timeInQueueMin.p95)).join("/")}.

What is left (\`MQ_DEBUG_TAIL=1\`; seed 1: 39 of 607 merged Changes over 20 min, 30 allowed):
- About a third are costs of the workload rather than of scheduling: a conflict resolution that touched lines outside its hunks waits for a fresh human approval (≈ 30 min review), its stack or plan-group mates wait with it, and resolved Changes spend the resolver's 2–6 min plus a fresh run.
- One-level cascades: a Change whose batch carried a failed batch's entries is re-run without them and loses the time its run had (≈ 4 entries per failure on seeds 1–3, instead of ≈ 11 before direct carrying).
- Bisection innocents: units batched with a culprit wait for the probes and then run again (rare now: batches average ≈ 1.15 units).
- Landing stalls: a revalidation that fails twice on a flaky test is treated as real (§4.7) and falls back to a full run; everything that carries those entries waits for it.

Without real failures (no broken Changes, no semantic conflicts; unknown sets, textual conflicts and flakes kept) the p95 is 15.5–18.8 min on seeds 1–8 (mean 16.4), so ≈ 3 min of the p95 is the cost of the ≈ 3% of Changes that really fail. p95 is the 30th-slowest of ≈ 600 Changes, so a seed moves by ±3 min with tiny scheduling changes; the 8-seed mean sits at the threshold. What would still move it is both-outcome speculation on the carried batches (the cascades above), measured at 19.1 vs 19.6 min but only at 1.54× CI (see "Decisions").`;
}

function knobsSection(): string {
  const rows = Object.values(SCENARIOS).map((s) => [
    s.name,
    String(s.arrivalsPerHour),
    `${s.hours}h`,
    pct(s.conflictDensity),
    pct(s.trueFailureRate),
    pct(s.flakyRate) +
      (s.hotFlaky.tests > 0 ? ` + ${s.hotFlaky.tests}×${pct(s.hotFlaky.failProb)}` : ""),
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
    table(
      [
        "scenario",
        "arrivals/h",
        "window",
        "conflict density",
        "broken",
        "flaky runs",
        "semantic / textual pair rate",
        "CI",
        "stacks / plan groups",
        "unknown affected",
        "prod regressions",
        "post-merge failures",
        "description",
      ],
      rows,
    ),
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
