/**
 * Synthetic agent workload + hidden ground truth.
 *
 * Repo model: K clusters × 4 modules × 6 files, one test target per module. Module 0 of a cluster
 * is its core: touching it puts the whole cluster in the reverse-dependency closure (and makes the
 * change a public-API change). K is calibrated so that two random Changes' affected sets overlap
 * with the scenario's conflict density.
 *
 * Ground truth (never shown to the queue):
 * - `bad`: broken on any tree (fails one of its own test targets). Likelier for sloppy sessions and
 *   big Changes, so the predictor has a real but imperfect signal.
 * - semantic partners: overlapping pairs that fail one shared test when both are present and neither
 *   was authored on top of the other.
 * - textual partners: pairs sharing a file that git can't merge (same condition).
 * - `prodBad`: passes CI but throws in production.
 * The analyzer is sound: interactions only happen between overlapping affected sets.
 */
import type { AffectedSet, Lane, PriorityClass } from "@app/merge-queue";
import { conflicts } from "@app/merge-queue";
import { draw, Rng } from "./rng.js";
import type { Scenario } from "./scenarios.js";

export const MODULES_PER_CLUSTER = 4;
export const FILES_PER_MODULE = 12;
const CROSS_CLUSTER_RATE = 0.05;
const SECOND_MODULE_RATE = 0.3;

export interface SimChange {
  id: string;
  arrival: number;
  session: string;
  author: string;
  runaway: boolean;
  clusters: number[];
  /** The true affected set (what a sound analyzer computes). */
  affected: AffectedSet;
  analyzerFails: boolean;
  lines: number;
  lane: Lane;
  priority: PriorityClass;
  dependsOn: string[];
  landMode: "atomic" | "incremental";
  plangroup: string | null;
  landTogether: boolean;
  groupSize: number | null;
  /** Members of the same stack/group (authored together: never conflict with each other). */
  family: string;
  bad: boolean;
  badTest: string;
  prodBad: boolean;
  flagKey: string | null;
  evidence: { redGreen: boolean | null; coverage: number | null; mutationScore: number | null };
  semantic: Set<string>;
  textual: Set<string>;
  revertOf: string | null;
}

export interface Workload {
  scenario: Scenario;
  seed: number;
  clusters: number;
  measuredDensity: number;
  changes: SimChange[];
  byId: Map<string, SimChange>;
  tests: string[];
  /** Per-test probability of a flaky failure in one run. */
  flaky: Map<string, number>;
  workers: string[];
  postMergeFailuresAt: number[];
}

const moduleName = (k: number, j: number) => `c${k}/m${j}`;
const fileName = (k: number, j: number, i: number) => `src/c${k}/m${j}/f${i}.ts`;
const testName = (k: number, j: number) => `test/c${k}/m${j}.test.ts`;

interface Shape {
  touched: [number, number][];
  files: string[];
}

function shape(rng: Rng, K: number, cluster: number): Shape {
  const touched: [number, number][] = [[cluster, rng.int(MODULES_PER_CLUSTER)]];
  if (rng.bool(SECOND_MODULE_RATE)) touched.push([cluster, rng.int(MODULES_PER_CLUSTER)]);
  if (K > 1 && rng.bool(CROSS_CLUSTER_RATE)) {
    let other = rng.int(K - 1);
    if (other >= cluster) other++;
    touched.push([other, rng.int(MODULES_PER_CLUSTER)]);
  }
  const files = new Set<string>();
  const nFiles = 1 + rng.int(3);
  for (let i = 0; i < nFiles; i++) {
    const [k, j] = rng.pick(touched);
    files.add(fileName(k, j, rng.int(FILES_PER_MODULE)));
  }
  return { touched, files: [...files].sort() };
}

function affectedOf(s: Shape, workers: string[]): AffectedSet {
  const modules = new Set<string>();
  const tests = new Set<string>();
  const deploys = new Set<string>();
  let publicApi = false;
  for (const [k, j] of s.touched) {
    const closure = j === 0 ? [0, 1, 2, 3] : [j];
    if (j === 0) publicApi = true;
    for (const m of closure) {
      modules.add(moduleName(k, m));
      tests.add(testName(k, m));
    }
    const w = workers[k % workers.length];
    if (w !== undefined) deploys.add(w);
  }
  return {
    files: s.files,
    modules: [...modules].sort(),
    testTargets: [...tests].sort(),
    publicApi,
    deploysTo: [...deploys].sort(),
    complete: true,
    analyzers: [{ name: "sim", version: "1", complete: true }],
  };
}

/** Pairwise overlap probability of random changes for K clusters (Monte Carlo, deterministic). */
function densityFor(K: number, seed: number): number {
  const rng = new Rng(`density|${seed}|${K}`);
  const sets = Array.from({ length: 300 }, () => affectedOf(shape(rng, K, rng.int(K)), ["w"]));
  let hits = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      pairs++;
      if (conflicts(sets[i] ?? null, sets[j] ?? null)) hits++;
    }
  return hits / pairs;
}

function calibrate(target: number, seed: number): number {
  let lo = 1;
  let hi = 2000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (densityFor(mid, seed) > target) lo = mid + 1;
    else hi = mid;
  }
  // pick the closer of lo-1 / lo
  if (
    lo > 1 &&
    Math.abs(densityFor(lo - 1, seed) - target) < Math.abs(densityFor(lo, seed) - target)
  )
    return lo - 1;
  return lo;
}

export function generate(scenario: Scenario, seed: number): Workload {
  const rng = new Rng(`workload|${scenario.name}|${seed}`);
  const K = calibrate(scenario.conflictDensity, seed);
  const workers = Array.from({ length: Math.max(1, scenario.workers) }, (_, i) => `worker-${i}`);
  const sessions = Array.from({ length: scenario.sessions }, (_, i) => ({
    id: `s${i}`,
    quality: 0.5 + rng.next(),
  }));
  const hourMs = 3_600_000;
  const end = scenario.hours * hourMs;
  const perEvent = 1 + scenario.stacks.rate * 2 + scenario.planGroups.rate * 1.5;
  const eventRate = scenario.arrivalsPerHour / perEvent;
  const changes: SimChange[] = [];
  let n = 0;
  let families = 0;
  const make = (
    arrival: number,
    session: { id: string; quality: number },
    runaway: boolean,
    cluster: number,
    family: string,
  ): SimChange => {
    const s = shape(rng, K, cluster);
    const affected = affectedOf(s, workers);
    const r = rng.next();
    const lane: Lane =
      r < scenario.laneMix[0] ? 0 : r < scenario.laneMix[0] + scenario.laneMix[1] ? 1 : 2;
    const p = rng.next();
    const priority: PriorityClass =
      p < scenario.priorityMix.incident
        ? "incident"
        : p < scenario.priorityMix.incident + scenario.priorityMix.security
          ? "security"
          : "normal";
    const id = `x${(n++).toString(36)}`;
    return {
      id,
      arrival,
      session: session.id,
      author: `agent-${session.id}`,
      runaway,
      clusters: [...new Set(s.touched.map(([k]) => k))],
      affected,
      analyzerFails: rng.bool(scenario.unknownAffectedRate),
      lines: Math.max(1, Math.round(rng.lognormal(scenario.size.medianLines, scenario.size.sigma))),
      lane,
      priority,
      dependsOn: [],
      landMode: "incremental",
      plangroup: null,
      landTogether: false,
      groupSize: null,
      family,
      bad: false,
      badTest: affected.testTargets[rng.int(affected.testTargets.length)] ?? "test/unknown",
      prodBad: false,
      flagKey: null,
      evidence: {
        redGreen: rng.bool(0.9),
        coverage: Math.round(rng.range(0.4, 1) * 100) / 100,
        mutationScore: Math.round(rng.range(0.3, 1) * 100) / 100,
      },
      semantic: new Set(),
      textual: new Set(),
      revertOf: null,
    };
  };
  for (let t = rng.exp(hourMs / eventRate); t < end; t += rng.exp(hourMs / eventRate)) {
    const session = rng.pick(sessions);
    const cluster = rng.int(K);
    const kind = rng.next();
    const family = `f${families++}`;
    if (kind < scenario.stacks.rate) {
      const depth = 2 + rng.int(3);
      const atomic = rng.bool(scenario.stacks.atomicShare);
      let prev: SimChange | null = null;
      for (let d = 0; d < depth; d++) {
        const c = make(t, session, false, cluster, family);
        // Stack members build on each other: same module, so they overlap.
        if (prev !== null) {
          c.dependsOn = [prev.id];
          const p = prev.affected;
          c.affected = {
            ...c.affected,
            files: [...new Set([...c.affected.files, ...p.files.slice(0, 1)])].sort(),
            modules: [...new Set([...c.affected.modules, ...p.modules])].sort(),
            testTargets: [...new Set([...c.affected.testTargets, ...p.testTargets])].sort(),
          };
        }
        c.landMode = atomic ? "atomic" : "incremental";
        changes.push(c);
        prev = c;
      }
    } else if (kind < scenario.stacks.rate + scenario.planGroups.rate) {
      const size = 2 + rng.int(2);
      const plan = `plan-${family}`;
      for (let g = 0; g < size; g++) {
        const c = make(t, session, false, rng.int(K), family);
        c.plangroup = plan;
        c.landTogether = true;
        c.groupSize = size;
        changes.push(c);
      }
    } else {
      changes.push(make(t, session, false, cluster, family));
    }
  }
  if (scenario.runaway !== null) {
    const at = scenario.runaway.atHour * hourMs;
    const runaway = { id: "runaway", quality: 1 };
    for (let i = 0; i < scenario.runaway.count; i++)
      changes.push(make(at + rng.next() * 60_000, runaway, true, rng.int(K), `f${families++}`));
  }
  changes.sort((a, b) => a.arrival - b.arrival || (a.id < b.id ? -1 : 1));
  // Truly broken changes: risk-weighted, normalized to the scenario's rate.
  const quality = new Map(sessions.map((s) => [s.id, s.quality]));
  const risk = (c: SimChange) =>
    (quality.get(c.session) ?? 1) * (c.lines > 400 ? 2 : 1) * (c.lane === 2 ? 1.5 : 1);
  const meanRisk = changes.reduce((acc, c) => acc + risk(c), 0) / Math.max(1, changes.length);
  for (const c of changes) {
    c.bad = draw(seed, "bad", c.id) < (scenario.trueFailureRate * risk(c)) / meanRisk;
    c.prodBad =
      !c.bad &&
      c.affected.deploysTo.length > 0 &&
      draw(seed, "prod", c.id) < scenario.prodRegressionRate;
    c.flagKey = draw(seed, "flag", c.id) < scenario.flagCoverage ? `change-${c.id}` : null;
  }
  // Pairwise interactions among overlapping changes (bucketed by module).
  const byModule = new Map<string, SimChange[]>();
  for (const c of changes)
    for (const m of c.affected.modules) {
      const list = byModule.get(m) ?? [];
      list.push(c);
      byModule.set(m, list);
    }
  const seen = new Set<string>();
  for (const list of byModule.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a === undefined || b === undefined || a.family === b.family) continue;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (draw(seed, "sem", key) < scenario.semanticConflictRate) {
          a.semantic.add(b.id);
          b.semantic.add(a.id);
        }
        const sharedFile = a.affected.files.some((f) => b.affected.files.includes(f));
        if (sharedFile && draw(seed, "txt", key) < scenario.textualConflictRate) {
          a.textual.add(b.id);
          b.textual.add(a.id);
        }
      }
  const tests: string[] = [];
  for (let k = 0; k < K; k++)
    for (let j = 0; j < MODULES_PER_CLUSTER; j++) tests.push(testName(k, j));
  const flaky = new Map<string, number>();
  const pool = tests.filter((t) => draw(seed, "flaky-pool", t) < 0.2);
  const perTest = pool.length === 0 ? 0 : 1 - (1 - scenario.flakyRate) ** (1 / pool.length);
  for (const t of pool) flaky.set(t, perTest);
  const hot = [...tests]
    .sort((a, b) => draw(seed, "hot", a) - draw(seed, "hot", b))
    .slice(0, scenario.hotFlaky.tests);
  for (const t of hot) flaky.set(t, scenario.hotFlaky.failProb);
  const postMergeFailuresAt = Array.from(
    { length: scenario.postMergeFailures },
    (_, i) => ((i + 1) / (scenario.postMergeFailures + 1)) * end,
  );
  return {
    scenario,
    seed,
    clusters: K,
    measuredDensity: densityFor(K, seed),
    changes,
    byId: new Map(changes.map((c) => [c.id, c])),
    tests,
    flaky,
    workers,
    postMergeFailuresAt,
  };
}
