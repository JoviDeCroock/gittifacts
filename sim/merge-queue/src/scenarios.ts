/**
 * Workload knobs (§6) and the named scenarios. Every knob is explicit so the report can print
 * exactly what each scenario means.
 */

export interface Scenario {
  name: string;
  description: string;
  /** Change arrivals per hour (Poisson). §6 range: 50–500. */
  arrivalsPerHour: number;
  /** Arrival window. */
  hours: number;
  /** Extra simulated time allowed to drain the queue after arrivals stop. */
  drainHours: number;
  /** Target probability that two random Changes' affected sets overlap. */
  conflictDensity: number;
  /** P(two overlapping Changes, neither authored on top of the other, fail together). */
  semanticConflictRate: number;
  /** P(two Changes touching the same file, neither authored on top of the other, conflict textually). */
  textualConflictRate: number;
  /** P(a Change is broken on any tree; it passed its own (narrower) CI). */
  trueFailureRate: number;
  /** P(a full CI run hits at least one flaky failure). */
  flakyRate: number;
  /** A few very flaky tests (exercise quarantine): count and per-run failure probability. */
  hotFlaky: { tests: number; failProb: number };
  ci: {
    /** Median full CI run, minutes. */
    medianMinutes: number;
    /** Lognormal sigma of the full run duration. */
    sigma: number;
    /** Fixed part of a run (container start, checkout, install from snapshot), fraction of a full run. */
    overheadFraction: number;
  };
  /** Change size (lines): lognormal. */
  size: { medianLines: number; sigma: number };
  /** Fraction of arrivals that are stacks (2–4 Changes), and of those, atomic. */
  stacks: { rate: number; atomicShare: number };
  /** Fraction of arrivals that are land-together plan groups (2–3 Changes). */
  planGroups: { rate: number };
  /** P(the affected-set analyzer fails for a Change: unknown set). */
  unknownAffectedRate: number;
  /** Agent sessions producing the workload. */
  sessions: number;
  /** One session floods the queue (fairness). */
  runaway: { atHour: number; count: number } | null;
  priorityMix: { security: number; incident: number };
  laneMix: [number, number, number];
  resolver: {
    textualSuccess: number;
    semanticSuccess: number;
    minutes: [number, number];
    budgetExhaustRate: number;
    outsideHunksRate: number;
    /** P(the resolver's re-classification reports a lower lane than the Change had). */
    lowerLaneRate: number;
    /** P(a "successful" resolution is itself broken). */
    bugRate: number;
  };
  /** P(a merged Change regresses in production (passes CI, throws live)). */
  prodRegressionRate: number;
  /** P(a Change is behind its own flag). */
  flagCoverage: number;
  /** Post-merge check failures injected during the arrival window (each triggers an automatic revert). */
  postMergeFailures: number;
  workers: number;
  trains: { watchMinutes: number; maxTrainSize: number };
  analyzerMinutes: number;
  humanReviewMinutes: number;
}

const base: Scenario = {
  name: "base",
  description: "",
  arrivalsPerHour: 200,
  hours: 6,
  drainHours: 6,
  conflictDensity: 0.1,
  semanticConflictRate: 0.01,
  textualConflictRate: 0.3,
  trueFailureRate: 0.02,
  flakyRate: 0.05,
  hotFlaky: { tests: 0, failProb: 0 },
  ci: { medianMinutes: 10, sigma: 0.15, overheadFraction: 0.1 },
  size: { medianLines: 80, sigma: 1 },
  stacks: { rate: 0.05, atomicShare: 0.3 },
  planGroups: { rate: 0.02 },
  unknownAffectedRate: 0.01,
  sessions: 25,
  runaway: null,
  priorityMix: { security: 0.03, incident: 0.005 },
  laneMix: [0.5, 0.4, 0.1],
  resolver: {
    textualSuccess: 0.9,
    semanticSuccess: 0.6,
    minutes: [2, 6],
    budgetExhaustRate: 0.01,
    outsideHunksRate: 0.1,
    lowerLaneRate: 0.1,
    bugRate: 0.01,
  },
  prodRegressionRate: 0,
  flagCoverage: 0.8,
  postMergeFailures: 0,
  workers: 3,
  trains: { watchMinutes: 10, maxTrainSize: 25 },
  analyzerMinutes: 0.5,
  humanReviewMinutes: 30,
};

function scenario(name: string, description: string, over: Partial<Scenario>): Scenario {
  return { ...base, ...over, name, description };
}

export const SCENARIOS: Record<string, Scenario> = {
  "gate-200": scenario(
    "gate-200",
    "§6 gate scenario: 200/h, 10% conflict density, 5% flaky runs (2% truly broken Changes; 1% of concurrent overlapping pairs conflict semantically, 30% of file-sharing pairs textually).",
    {},
  ),
  "low-50": scenario("low-50", "Quiet repo: 50/h.", { arrivalsPerHour: 50 }),
  "high-500": scenario("high-500", "Peak agent load: 500/h.", { arrivalsPerHour: 500, hours: 4 }),
  "conflict-heavy": scenario(
    "conflict-heavy",
    "Hot codebase: 30% conflict density, more textual and semantic conflicts.",
    { conflictDensity: 0.3, textualConflictRate: 0.5, semanticConflictRate: 0.03 },
  ),
  "failure-heavy": scenario("failure-heavy", "Sloppy agents: 8% truly broken Changes.", { trueFailureRate: 0.08 }),
  "flaky-storm": scenario(
    "flaky-storm",
    "15% flaky runs plus 3 very flaky tests (30% per run) that must get quarantined.",
    { flakyRate: 0.15, hotFlaky: { tests: 3, failProb: 0.3 } },
  ),
  "stacks-groups": scenario(
    "stacks-groups",
    "Many stacked Changes (25% of arrivals) and land-together plan groups (10%).",
    { stacks: { rate: 0.25, atomicShare: 0.4 }, planGroups: { rate: 0.1 } },
  ),
  incidents: scenario(
    "incidents",
    "Production regressions (2% of merges, 80% flagged), 3 post-merge check failures with automatic reverts: trains, attribution, freezes.",
    { prodRegressionRate: 0.02, postMergeFailures: 3 },
  ),
  "runaway-agent": scenario(
    "runaway-agent",
    "100/h background from 25 sessions; one session floods 300 Changes at hour 1 (fair queuing + in-flight cap).",
    { arrivalsPerHour: 100, runaway: { atHour: 1, count: 300 } },
  ),
  "textual-corpus": scenario(
    "textual-corpus",
    "Resolver gate stand-in: high textual conflict rate in a hot codebase (the real fixture corpus comes from the resolver agent).",
    { conflictDensity: 0.25, textualConflictRate: 0.8, semanticConflictRate: 0, arrivalsPerHour: 150, hours: 4 },
  ),
};

export function getScenario(name: string): Scenario {
  const s = SCENARIOS[name];
  if (s === undefined) throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`);
  return s;
}
