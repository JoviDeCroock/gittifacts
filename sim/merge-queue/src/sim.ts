/**
 * The discrete-event simulator: drives the REAL core (`step`) and the real deploy-train machine
 * (`trainStep`) against a fake world that executes their commands with outcomes derived from the
 * workload's hidden ground truth.
 */
import {
  type Command,
  CoreEvent,
  type CoreEventInput,
  checkStateInvariants,
  initialState,
  initialTrainState,
  InvariantViolation,
  type QueueConfig,
  type QueueState,
  step,
  type TrainCommand,
  TrainEvent,
  type TrainEventInput,
  type TrainState,
  trainStep,
} from "@app/merge-queue";
import { EventHeap } from "./heap.js";
import { draw, fakeSha, h32, lognormal } from "./rng.js";
import type { SimChange, Workload } from "./workload.js";

type Ev =
  | { k: "core"; e: CoreEventInput }
  | { k: "train"; e: TrainEventInput }
  | { k: "arrive"; c: SimChange }
  | { k: "tick" }
  | { k: "pmf" }
  | { k: "run-done"; runId: string; e: CoreEventInput }
  | { k: "issue"; issueId: string; e: TrainEventInput };

export interface ChangeRecord {
  id: string;
  session: string;
  runaway: boolean;
  revert: boolean;
  bad: boolean;
  enqueuedAt: number;
  firstBatchAt: number | null;
  /** Last time a full run on a tree containing it passed. */
  passedAt: number | null;
  mergedAt: number | null;
  ejectedAt: number | null;
  ejectCode: string | null;
  falseEject: boolean;
  dequeued: boolean;
}

export interface RunMetrics {
  scenario: string;
  mode: string;
  seed: number;
  arrivals: number;
  merged: number;
  ejected: number;
  unfinished: number;
  backlogAtArrivalEnd: number;
  simHours: number;
  throughputPerHour: number;
  timeInQueueMin: { p50: number; p95: number; p99: number };
  /** Enqueue → first batch, and first batch → merged (merged entries). */
  phasesMin: { toBatchP50: number; toBatchP95: number; batchToMergeP50: number; batchToMergeP95: number; passedToMergeP50: number; passedToMergeP95: number };
  /** p95 of entries from non-runaway sessions (fairness). */
  timeInQueueOthersP95Min: number;
  ciMinutes: number;
  ciMinutesByKind: Record<string, number>;
  ciMinutesPerMerged: number;
  isolatedRunMin: number;
  ciRatio: number;
  ejectRate: number;
  falseEjectRate: number;
  ejectCodes: Record<string, number>;
  resolver: { textual: { incidents: number; resolved: number }; semantic: { incidents: number; resolved: number }; laneDowngradesIgnored: number; laneDecreases: number };
  mainRedEvents: number;
  maskedByQuarantine: number;
  attributionFailures: number;
  regressions: number;
  flagKills: number;
  rollbacks: number;
  reverts: number;
  freezes: number;
  frozenMinutes: number;
  quarantines: number;
  fallbacks: number;
  batches: number;
  avgBatchSize: number;
  probes: number;
  landings: number;
  maxQueueLength: number;
  predictionBrier: number | null;
  predictions: number;
  refsLeaked: number;
  invariantViolations: string[];
  steps: number;
  wallMs: number;
}

interface Commit {
  parent: string | null;
  entry: string | null;
  t0: number;
  t1: number;
}

const NOISE_FRAMES = ["node_modules/hono/dist/hono-base.js", "runtime/worker-entry.js"];
const MINUTE = 60_000;

export interface SimOptions {
  mode: string;
  config: QueueConfig;
  /** Run checkStateInvariants every N core steps (0 = never). */
  invariantEvery?: number;
}

export function simulate(w: Workload, opts: SimOptions): RunMetrics {
  return new Sim(w, opts).run();
}

class Sim {
  private readonly sc;
  private readonly seed: number;
  private now = 0;
  private heap = new EventHeap<Ev>();
  private pendingNonTick = 0;
  private core: QueueState;
  private trains: TrainState;
  private steps = 0;
  // git world
  private commits = new Map<string, Commit>();
  private contentCache = new Map<string, Map<string, number>>();
  private failureCache = new Map<string, string[]>();
  private mainSha: string;
  private mainIds = new Map<string, number>();
  private versions = new Map<string, number>();
  private heads = new Map<string, { id: string; v: number }>();
  private authored = new Map<string, Set<string>>();
  private resolvedPairs = new Set<string>();
  private buggy = new Set<string>();
  private refs = new Set<string>();
  private fixedTests = new Set<string>();
  private changes: Map<string, SimChange>;
  private revertOf = new Map<string, string>();
  private reverted = new Set<string>();
  // CI accounting
  private runs = new Map<string, { start: number; dur: number; kind: string; done: boolean; entries: string[] }>();
  private ciMinutes = 0;
  private ciByKind: Record<string, number> = {};
  // trains
  private flagOff = new Set<string>();
  private rolledBack = new Set<string>();
  private issues = new Map<string, { culprit: string; trainId: string }>();
  // metrics
  private records = new Map<string, ChangeRecord>();
  private batchSizes = new Map<string, number>();
  private laneSeen = new Map<string, number>();
  private m = {
    mainRed: 0,
    masked: 0,
    attributionFailures: 0,
    regressions: 0,
    flagKills: 0,
    rollbacks: 0,
    reverts: 0,
    freezes: 0,
    frozenSince: null as number | null,
    frozenMs: 0,
    quarantines: 0,
    fallbacks: 0,
    probes: 0,
    landings: 0,
    maxQueue: 0,
    laneDowngradesIgnored: 0,
    laneDecreases: 0,
    backlogAtArrivalEnd: -1,
    violations: [] as string[],
    textual: { incidents: 0, resolved: 0 },
    semantic: { incidents: 0, resolved: 0 },
    openIncident: new Map<string, "textual" | "semantic">(),
    predictions: new Map<string, number>(),
    brier: [] as number[],
  };
  private readonly arrivalEnd: number;
  private readonly endTime: number;
  private revertSeq = 0;

  constructor(
    private readonly w: Workload,
    private readonly opts: SimOptions,
  ) {
    this.sc = w.scenario;
    this.seed = w.seed;
    this.changes = new Map(w.byId);
    this.mainSha = fakeSha("genesis");
    this.commits.set(this.mainSha, { parent: null, entry: null, t0: 0, t1: 0 });
    this.contentCache.set(this.mainSha, new Map());
    this.core = initialState(this.mainSha, opts.config, 0);
    this.trains = initialTrainState({ watchMs: this.sc.trains.watchMinutes * MINUTE, maxTrainSize: this.sc.trains.maxTrainSize });
    this.arrivalEnd = this.sc.hours * 3_600_000;
    this.endTime = this.arrivalEnd + this.sc.drainHours * 3_600_000;
  }

  // ------------------------------------------------------------------ loop

  private push(at: number, ev: Ev): void {
    if (ev.k !== "tick") this.pendingNonTick++;
    this.heap.push(at, ev);
  }

  run(): RunMetrics {
    const started = performance.now();
    for (const c of this.w.changes) this.push(c.arrival, { k: "arrive", c });
    for (const at of this.w.postMergeFailuresAt) this.push(at, { k: "pmf" });
    this.push(MINUTE, { k: "tick" });
    try {
      for (;;) {
        const next = this.heap.pop();
        if (next === undefined) break;
        if (next.v.k !== "tick") this.pendingNonTick--;
        if (next.at > this.endTime) break;
        if (this.m.backlogAtArrivalEnd < 0 && next.at > this.arrivalEnd) this.m.backlogAtArrivalEnd = this.liveEntries();
        this.now = next.at;
        this.handle(next.v);
        if (next.v.k === "tick") {
          const idle = this.now > this.arrivalEnd && this.pendingNonTick === 0 && this.liveEntries() === 0;
          if (!idle) this.push(this.now + MINUTE, { k: "tick" });
        }
      }
    } catch (e) {
      if (e instanceof InvariantViolation) this.m.violations.push(e.message);
      else throw e;
    }
    if (this.m.backlogAtArrivalEnd < 0) this.m.backlogAtArrivalEnd = this.liveEntries();
    if (this.m.frozenSince !== null) this.m.frozenMs += this.now - this.m.frozenSince;
    return this.metrics(performance.now() - started);
  }

  private liveEntries(): number {
    let n = 0;
    for (const e of Object.values(this.core.entries)) if (e.state !== "merged" && e.state !== "ejected" && e.state !== "dequeued") n++;
    return n;
  }

  private handle(ev: Ev): void {
    switch (ev.k) {
      case "arrive":
        this.arrive(ev.c);
        return;
      case "core":
        this.sendCore(ev.e);
        return;
      case "run-done": {
        const r = this.runs.get(ev.runId);
        if (r === undefined || r.done) return; // cancelled
        r.done = true;
        this.charge(r.kind, r.dur);
        if (r.kind === "chain" && ev.e.type === "BatchResult" && ev.e.outcome === "passed")
          for (const id of r.entries) {
            const rec = this.records.get(id);
            if (rec !== undefined) rec.passedAt = this.now;
          }
        this.sendCore(ev.e);
        return;
      }
      case "train":
        this.sendTrain(ev.e);
        return;
      case "issue": {
        const issue = this.issues.get(ev.issueId);
        if (issue === undefined || this.rolledBack.has(issue.trainId) || this.flagOff.has(issue.culprit) || this.reverted.has(issue.culprit)) return;
        this.m.regressions++;
        const cmds = this.sendTrain(ev.e);
        const attributed =
          cmds.find((c) => c.type === "KillFlag")?.changeId ??
          cmds.find((c) => c.type === "RequestRevert")?.changeId ??
          null;
        if (attributed !== issue.culprit) this.m.attributionFailures++;
        return;
      }
      case "tick":
        this.sendCore({ type: "Tick" });
        this.sendTrain({ type: "Tick" });
        this.m.maxQueue = Math.max(this.m.maxQueue, this.liveEntries());
        return;
      case "pmf": {
        const last = [...this.records.values()].filter((r) => r.mergedAt !== null && !r.revert).sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))[0];
        if (last === undefined) return;
        this.sendCore({ type: "PostMergeCheckFailed", sha: this.mainSha, checks: ["deploy-smoke"] });
        this.requestRevert(last.id);
        return;
      }
    }
  }

  private charge(kind: string, ms: number): void {
    const min = ms / MINUTE;
    this.ciMinutes += min;
    this.ciByKind[kind] = (this.ciByKind[kind] ?? 0) + min;
  }

  // ------------------------------------------------------------------ core

  private sendCore(input: CoreEventInput): void {
    const ev = CoreEvent.parse(input);
    const r = step(this.core, ev, { now: this.now });
    this.core = r.state;
    this.steps++;
    const every = this.opts.invariantEvery ?? 0;
    if (every > 0 && this.steps % every === 0) checkStateInvariants(this.core);
    for (const e of Object.values(this.core.entries)) {
      const prev = this.laneSeen.get(e.changeId);
      if (prev !== undefined && e.lane < prev) this.m.laneDecreases++;
      if (prev === undefined || e.lane > prev) this.laneSeen.set(e.changeId, e.lane);
    }
    for (const c of r.commands) this.exec(c);
  }

  private arrive(c: SimChange): void {
    const v = 1;
    this.versions.set(c.id, v);
    const head = fakeSha(`head|${c.id}|${v}`);
    this.heads.set(head, { id: c.id, v });
    this.authored.set(c.id, new Set(this.mainIds.keys()));
    this.records.set(c.id, {
      id: c.id,
      session: c.session,
      runaway: c.runaway,
      revert: c.revertOf !== null,
      bad: c.bad,
      enqueuedAt: this.now,
      firstBatchAt: null,
      passedAt: null,
      mergedAt: null,
      ejectedAt: null,
      ejectCode: null,
      falseEject: false,
      dequeued: false,
    });
    const deps = c.dependsOn.filter((d) => this.core.entries[d]?.state !== "merged");
    this.sendCore({
      type: "Enqueued",
      changeId: c.id,
      headSha: head,
      authorId: c.author,
      enqueuedBy: { principalId: c.author, kind: c.revertOf !== null ? "system" : "agent", sessionId: c.revertOf !== null ? null : c.session },
      priority: c.priority,
      lane: c.lane,
      dependsOn: deps,
      landMode: c.landMode,
      plangroup: c.plangroup,
      landTogether: c.landTogether,
      groupSize: c.groupSize,
      revertOf: c.revertOf,
      automaticRevert: c.revertOf !== null,
      flagKey: c.flagKey,
      affected: null,
      size: { lines: c.lines, files: c.affected.files.length },
      evidence: c.evidence,
    });
  }

  private requestRevert(changeId: string): void {
    if (this.reverted.has(changeId)) return;
    const orig = this.changes.get(changeId);
    if (orig === undefined) return;
    this.reverted.add(changeId);
    this.m.reverts++;
    const id = `revert-${changeId}-${this.revertSeq++}`;
    const c: SimChange = {
      ...orig,
      id,
      session: "system",
      author: "system:rollout",
      runaway: false,
      lane: 0,
      priority: "revert",
      dependsOn: [],
      landMode: "incremental",
      plangroup: null,
      landTogether: false,
      groupSize: null,
      family: `rev-${id}`,
      bad: false,
      prodBad: false,
      flagKey: null,
      analyzerFails: false,
      semantic: new Set(),
      textual: new Set(),
      revertOf: changeId,
      arrival: this.now + MINUTE,
    };
    this.changes.set(id, c);
    this.revertOf.set(id, changeId);
    this.push(this.now + MINUTE, { k: "arrive", c });
  }

  // ------------------------------------------------------------------ git world

  private treeOf(sha: string): string {
    const c = this.commits.get(sha);
    if (c === undefined) throw new Error(`unknown commit ${sha}`);
    return (c.t0 >>> 0).toString(16).padStart(8, "0") + (c.t1 >>> 0).toString(16).padStart(8, "0") + "0".repeat(24);
  }

  private contentOf(sha: string): Map<string, number> {
    const hit = this.contentCache.get(sha);
    if (hit !== undefined) return hit;
    const path: Commit[] = [];
    let cur: string | null = sha;
    let base: Map<string, number> | undefined;
    while (cur !== null) {
      const cached = this.contentCache.get(cur);
      if (cached !== undefined) {
        base = cached;
        break;
      }
      const c = this.commits.get(cur);
      if (c === undefined) throw new Error(`unknown commit ${cur}`);
      path.push(c);
      cur = c.parent;
    }
    const out = new Map(base ?? []);
    for (let i = path.length - 1; i >= 0; i--) {
      const e = path[i]?.entry;
      if (e === null || e === undefined) continue;
      const at = e.lastIndexOf("@");
      out.set(e.slice(0, at), Number(e.slice(at + 1)));
    }
    this.contentCache.set(sha, out);
    if (this.contentCache.size > 400) {
      const first = this.contentCache.keys().next().value;
      if (first !== undefined && first !== this.mainSha) this.contentCache.delete(first);
    }
    return out;
  }

  private neutralized(ids: Map<string, number>): Set<string> {
    const out = new Set<string>();
    for (const id of ids.keys()) {
      const of = this.revertOf.get(id);
      if (of !== undefined) out.add(of);
    }
    return out;
  }

  private isBad(id: string, v: number): boolean {
    const c = this.changes.get(id);
    if (c === undefined || c.revertOf !== null) return false;
    return c.bad || this.buggy.has(`${id}@${v}`);
  }

  private resolved(x: string, vx: number | undefined, y: string, vy: number | undefined): boolean {
    return this.resolvedPairs.has(`${x}@${vx}|${y}`) || this.resolvedPairs.has(`${y}@${vy}|${x}`);
  }

  private interacts(x: string, y: string): boolean {
    return !(this.authored.get(x)?.has(y) ?? false) && !(this.authored.get(y)?.has(x) ?? false);
  }

  /** Deterministic failures of a tree (memoized by tree sha). */
  private failures(sha: string): string[] {
    const tree = this.treeOf(sha);
    const hit = this.failureCache.get(tree);
    if (hit !== undefined) return hit;
    const ids = this.contentOf(sha);
    const gone = this.neutralized(ids);
    const out = new Set<string>();
    for (const [id, v] of ids) {
      if (gone.has(id)) continue;
      const c = this.changes.get(id);
      if (c === undefined) continue;
      if (this.isBad(id, v)) out.add(c.badTest);
      for (const p of c.semantic) {
        if (!ids.has(p) || gone.has(p) || !this.interacts(id, p) || this.resolved(id, v, p, ids.get(p))) continue;
        const pc = this.changes.get(p);
        const shared = c.affected.testTargets.find((t) => pc?.affected.testTargets.includes(t));
        out.add(shared ?? c.badTest);
      }
    }
    const list = [...out].sort();
    this.failureCache.set(tree, list);
    return list;
  }

  private flakes(runKey: string, tests: Iterable<string>): string[] {
    const out: string[] = [];
    for (const t of tests) {
      if (this.fixedTests.has(t)) continue;
      const p = this.w.flaky.get(t);
      if (p !== undefined && draw(this.seed, "flake", runKey, t) < p) out.push(t);
    }
    return out;
  }

  private fullDuration(key: string): number {
    return lognormal(this.sc.ci.medianMinutes * MINUTE, this.sc.ci.sigma, draw(this.seed, "dur1", key), draw(this.seed, "dur2", key));
  }

  // ------------------------------------------------------------------ command execution

  private exec(c: Command): void {
    switch (c.type) {
      case "ComputeAffectedSet": {
        const h = this.heads.get(c.headSha);
        const ch = this.changes.get(h?.id ?? c.changeId);
        if (ch === undefined) return;
        const affected = ch.analyzerFails ? { ...ch.affected, complete: false } : ch.affected;
        const delay = this.sc.analyzerMinutes * MINUTE * (0.5 + draw(this.seed, "an", c.changeId, c.headSha));
        this.push(this.now + delay, { k: "core", e: { type: "AffectedSetComputed", changeId: c.changeId, headSha: c.headSha, affected } });
        return;
      }
      case "BuildBatchTree":
        return this.build(c);
      case "StartBatchRun": {
        const full = this.fullDuration(c.runId);
        const ov = this.sc.ci.overheadFraction;
        const dur = c.targets === "all" ? full : ov * full + (1 - ov) * full * (c.targets.length / Math.max(1, this.w.tests.length));
        const scope = c.targets === "all" ? this.w.tests : c.targets;
        const scopeSet = new Set(scope);
        const real = this.failures(c.commitSha).filter((t) => c.targets === "all" || scopeSet.has(t));
        const failing = [...new Set([...real, ...this.flakes(c.runId, scope)])];
        this.runs.set(c.runId, { start: this.now, dur, kind: c.kind, done: false, entries: c.entries });
        if (c.kind === "probe") this.m.probes++;
        if (c.kind === "landing") this.m.landings++;
        this.push(this.now + dur, {
          k: "run-done",
          runId: c.runId,
          e: { type: "BatchResult", batchId: c.batchId, runId: c.runId, treeSha: c.treeSha, outcome: failing.length > 0 ? "failed" : "passed", failingTests: failing, scope: c.targets, durationMs: dur },
        });
        return;
      }
      case "CancelBatchRun": {
        const r = this.runs.get(c.runId);
        if (r === undefined || r.done) return;
        r.done = true;
        this.charge(r.kind, Math.min(r.dur, this.now - r.start));
        return;
      }
      case "RunFlakeRecheck": {
        const ov = this.sc.ci.overheadFraction;
        const dur = this.sc.ci.medianMinutes * MINUTE * (ov + (1 - ov) * (c.tests.length / Math.max(1, this.w.tests.length)));
        const onBatch = new Set([...this.failures(c.commitSha), ...this.flakes(`${c.runId}|b`, c.tests)]);
        const onMain = new Set([...this.failures(c.mainSha), ...this.flakes(`${c.runId}|m`, c.tests)]);
        const results = c.tests.map((t) => ({ test: t, onBatch: onBatch.has(t) ? ("failed" as const) : ("passed" as const), onMain: onMain.has(t) ? ("failed" as const) : ("passed" as const) }));
        // Batch-tree and main-head re-runs execute in parallel: two containers.
        this.runs.set(c.runId, { start: this.now, dur: 2 * dur, kind: "recheck", done: false, entries: [] });
        this.push(this.now + dur, { k: "run-done", runId: c.runId, e: { type: "FlakeRecheckResult", batchId: c.batchId, runId: c.runId, results } });
        return;
      }
      case "RequestResolution":
        return this.resolve(c);
      case "Cas": {
        if (c.expectedOld !== this.mainSha) {
          this.push(this.now + 2000, { k: "core", e: { type: "CasResult", casId: c.casId, result: "stale", actualSha: this.mainSha } });
          return;
        }
        this.mainSha = c.newSha;
        this.mainIds = this.contentOf(c.newSha);
        const red = this.failures(c.newSha);
        const quarantined = new Set(Object.keys(this.core.quarantine));
        const visible = red.filter((t) => !quarantined.has(t));
        if (visible.length > 0) {
          this.m.mainRed++;
          this.m.violations.push(`main red at ${this.now}: ${visible.join(", ")} via ${c.entries.map((e) => e.changeId).join(",")}`);
        } else if (red.length > 0) this.m.masked++;
        this.push(this.now + 2000, { k: "core", e: { type: "CasResult", casId: c.casId, result: "ok" } });
        return;
      }
      case "DeleteQueueRef":
        this.refs.delete(c.refName);
        return;
      case "RequestApproval": {
        const delay = lognormal(this.sc.humanReviewMinutes * MINUTE, 0.5, draw(this.seed, "rv1", c.changeId, this.now), draw(this.seed, "rv2", c.changeId, this.now));
        this.push(this.now + delay, { k: "core", e: { type: "Approved", changeId: c.changeId, lane: c.lane, approver: { principalId: "human-reviewer", kind: "human" } } });
        return;
      }
      case "OpenPlan":
        // The fix-the-flaky-test Plan lands two hours later.
        this.push(this.now + 120 * MINUTE, { k: "core", e: { type: "Unquarantined", test: c.test, by: "fix-plan" } });
        this.fixedTests.add(c.test);
        return;
      case "Emit":
        return this.onEmit(c.event);
      case "Audit":
        if (c.action === "merge-queue.test-quarantined") this.m.quarantines++;
        if (c.action === "merge-queue.full-run-fallback") this.m.fallbacks++;
        return;
      case "Telemetry":
        if (c.kind === "lane-downgrade-ignored") this.m.laneDowngradesIgnored++;
        if (c.kind === "prediction") this.m.predictions.set(String(c.data.changeId), Number(c.data.p));
        if (c.kind === "outcome") {
          const p = this.m.predictions.get(String(c.data.changeId));
          const outcome = String(c.data.outcome);
          const y = outcome === "merged" ? 1 : outcome === "ejected:tests-failed" || outcome === "ejected:semantic-conflict" ? 0 : null;
          if (p !== undefined && y !== null) this.m.brier.push((p - y) ** 2);
        }
        return;
      default:
        return;
    }
  }

  private build(c: Extract<Command, { type: "BuildBatchTree" }>): void {
    const delay = (5 + 10 * draw(this.seed, "build", c.batchId)) * 1000;
    const ids = new Map(this.contentOf(c.baseSha));
    const gone = this.neutralized(ids);
    let parent = c.baseSha;
    const commits: { changeId: string; commitSha: string; treeSha: string }[] = [];
    for (const e of c.entries) {
      const h = this.heads.get(e.headSha);
      const ch = this.changes.get(e.changeId);
      if (h === undefined || ch === undefined) throw new Error(`unknown head for ${e.changeId}`);
      const blocker = [...ch.textual].find((p) => ids.has(p) && !gone.has(p) && this.interacts(e.changeId, p) && !this.resolved(e.changeId, h.v, p, ids.get(p)));
      if (blocker !== undefined) {
        const files = ch.affected.files.filter((f) => this.changes.get(blocker)?.affected.files.includes(f));
        this.push(this.now + delay, { k: "core", e: { type: "RebaseResult", batchId: c.batchId, result: { status: "conflict", changeId: e.changeId, files, upstream: [blocker] } } });
        return;
      }
      const entry = `${e.changeId}@${h.v}`;
      const pc = this.commits.get(parent);
      if (pc === undefined) throw new Error(`unknown base ${parent}`);
      const sha = fakeSha(`commit|${parent}|${entry}`);
      if (!this.commits.has(sha)) this.commits.set(sha, { parent, entry, t0: pc.t0 ^ h32(`t0|${entry}`), t1: pc.t1 ^ h32(`t1|${entry}`) });
      ids.set(e.changeId, h.v);
      commits.push({ changeId: e.changeId, commitSha: sha, treeSha: this.treeOf(sha) });
      parent = sha;
    }
    const last = commits[commits.length - 1];
    if (last === undefined) return;
    this.refs.add(c.refName);
    this.push(this.now + delay, { k: "core", e: { type: "RebaseResult", batchId: c.batchId, result: { status: "clean", tipSha: last.commitSha, treeSha: last.treeSha, commits } } });
  }

  private resolve(c: Extract<Command, { type: "RequestResolution" }>): void {
    const r = this.sc.resolver;
    const ch = this.changes.get(c.changeId);
    if (ch === undefined) return;
    const v = this.versions.get(c.changeId) ?? 1;
    const key = `${c.changeId}|${c.attempt}|${v}`;
    const delay = (r.minutes[0] + (r.minutes[1] - r.minutes[0]) * draw(this.seed, "rdelay", key)) * MINUTE;
    if (c.attempt === 1) {
      this.m.openIncident.set(c.changeId, c.kind);
      this.m[c.kind].incidents++;
    }
    const send = (outcome: Extract<CoreEventInput, { type: "ResolutionResult" }>["outcome"]) =>
      this.push(this.now + delay, { k: "core", e: { type: "ResolutionResult", changeId: c.changeId, attempt: c.attempt, resolverId: "resolver-agent", outcome } });
    if (draw(this.seed, "budget", key) < r.budgetExhaustRate) {
      send({ status: "budget-exhausted", message: "AI Gateway budget exhausted" });
      return;
    }
    const upstream = new Set([...c.upstream, ...c.preceding]);
    let blamed: string | null = null;
    let partners: string[] = [];
    if (c.kind === "textual") {
      partners = [...ch.textual].filter((p) => upstream.has(p) || this.mainIds.has(p));
      if (draw(this.seed, "rtext", key) >= r.textualSuccess) {
        send({ status: "failed", message: "could not combine both sides" });
        return;
      }
      blamed = partners[0] ?? c.upstream[0] ?? null;
    } else {
      if (this.isBad(c.changeId, v)) {
        send(draw(this.seed, "nac", key) < 0.9 ? { status: "not-a-conflict", message: "the Change fails on its own" } : { status: "failed", message: "no fix found" });
        return;
      }
      partners = [...ch.semantic].filter((p) => upstream.has(p));
      if (partners.length === 0 || draw(this.seed, "rsem", key) >= r.semanticSuccess) {
        send({ status: "failed", message: partners.length === 0 ? "could not reproduce the failure or find an upstream cause" : "could not fix the interaction" });
        return;
      }
      blamed = partners[0] ?? null;
    }
    const nv = v + 1;
    this.versions.set(c.changeId, nv);
    const head = fakeSha(`head|${c.changeId}|${nv}`);
    this.heads.set(head, { id: c.changeId, v: nv });
    for (const p of partners) this.resolvedPairs.add(`${c.changeId}@${nv}|${p}`);
    if (draw(this.seed, "rbug", key) < r.bugRate) this.buggy.add(`${c.changeId}@${nv}`);
    const lane = this.core.entries[c.changeId]?.lane ?? ch.lane;
    const reported = draw(this.seed, "rlow", key) < r.lowerLaneRate ? Math.max(0, lane - 1) : lane;
    send({
      status: "resolved",
      newHeadSha: head,
      lane: reported as 0 | 1 | 2,
      laneReasons: [],
      outsideHunks: draw(this.seed, "rout", key) < r.outsideHunksRate,
      blamedUpstream: blamed,
      resolutionRef: `resolution:${c.changeId}:${nv}`,
      affected: ch.analyzerFails ? { ...ch.affected, complete: false } : ch.affected,
    });
  }

  private onEmit(ev: Extract<Command, { type: "Emit" }>["event"]): void {
    switch (ev.type) {
      case "entered_batch": {
        const r = this.records.get(ev.changeId);
        if (r !== undefined && r.firstBatchAt === null) r.firstBatchAt = ev.at;
        this.batchSizes.set(ev.batchId, ev.batchSize);
        return;
      }
      case "merged": {
        const r = this.records.get(ev.changeId);
        if (r !== undefined) r.mergedAt = ev.at;
        const ch = this.changes.get(ev.changeId);
        this.sendTrain({ type: "ChangeMerged", changeId: ev.changeId, sha: ev.mergedSha, deploysTo: ev.deploysTo, flagKey: ev.flagKey, files: ev.files, modules: ev.modules });
        if (ch?.revertOf !== null && ch !== undefined) this.reverted.add(ch.revertOf ?? "");
        return;
      }
      case "ejected": {
        const r = this.records.get(ev.changeId);
        const ch = this.changes.get(ev.changeId);
        if (r !== undefined) {
          r.ejectedAt = ev.at;
          r.ejectCode = ev.reason.code;
          // False eject: a test-failure ejection of a Change that is not broken and has no
          // unresolved semantic partner in main (only flakes or misattribution can do that).
          if (ch !== undefined && (ev.reason.code === "tests-failed" || ev.reason.code === "semantic-conflict")) {
            const v = this.versions.get(ev.changeId) ?? 1;
            const partner = [...ch.semantic].some((p) => this.mainIds.has(p) && this.interacts(ev.changeId, p) && !this.resolved(ev.changeId, v, p, this.mainIds.get(p)));
            const inQueue = [...ch.semantic].some((p) => {
              const e = this.core.entries[p];
              return e !== undefined && e.state !== "merged" && e.state !== "ejected" && e.state !== "dequeued";
            });
            r.falseEject = !this.isBad(ev.changeId, v) && !partner && !inQueue;
          }
        }
        const kind = this.m.openIncident.get(ev.changeId);
        if (kind !== undefined) this.m.openIncident.delete(ev.changeId);
        return;
      }
      case "resolution_ready": {
        const kind = this.m.openIncident.get(ev.changeId);
        if (kind !== undefined) {
          this.m[kind].resolved++;
          this.m.openIncident.delete(ev.changeId);
        }
        return;
      }
      case "frozen":
        this.m.freezes++;
        this.m.frozenSince = ev.at;
        return;
      case "thawed":
        if (this.m.frozenSince !== null) this.m.frozenMs += ev.at - this.m.frozenSince;
        this.m.frozenSince = null;
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ deploy trains

  private sendTrain(input: TrainEventInput): TrainCommand[] {
    const r = trainStep(this.trains, TrainEvent.parse(input), { now: this.now });
    this.trains = r.state;
    for (const c of r.commands) this.execTrain(c);
    return r.commands;
  }

  private execTrain(c: TrainCommand): void {
    switch (c.type) {
      case "StartDeployTrain": {
        const versionId = `v-${c.trainId}`;
        const deployAt = this.now + 2 * MINUTE;
        this.push(deployAt, { k: "train", e: { type: "TrainDeployed", trainId: c.trainId, versionId } });
        for (const x of c.changes) {
          const ch = this.changes.get(x.changeId);
          if (ch === undefined || !ch.prodBad || this.reverted.has(ch.id)) continue;
          const issueId = `iss-${ch.id}-${c.trainId}`;
          this.issues.set(issueId, { culprit: ch.id, trainId: c.trainId });
          const frames = [...ch.affected.files.slice(0, 2).map((file) => ({ file })), ...NOISE_FRAMES.map((file) => ({ file }))];
          this.push(deployAt + (5 + 10 * draw(this.seed, "issue", issueId)) * MINUTE, { k: "issue", issueId, e: { type: "IssueReported", worker: c.worker, versionId, issueId, frames } });
        }
        return;
      }
      case "KillFlag": {
        this.m.flagKills++;
        this.flagOff.add(c.changeId);
        const issue = this.issues.get(c.issueId);
        if (issue !== undefined && issue.culprit === c.changeId)
          this.push(this.now + 3 * MINUTE, { k: "train", e: { type: "RegressionCleared", trainId: c.trainId, issueId: c.issueId } });
        return;
      }
      case "RollbackTrain":
        this.m.rollbacks++;
        this.rolledBack.add(c.trainId);
        this.push(this.now + MINUTE, { k: "train", e: { type: "RollbackDone", trainId: c.trainId } });
        return;
      case "RequestRevert":
        this.requestRevert(c.changeId);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ metrics

  private metrics(wallMs: number): RunMetrics {
    const recs = [...this.records.values()];
    const merged = recs.filter((r) => r.mergedAt !== null);
    const ejected = recs.filter((r) => r.ejectedAt !== null && r.mergedAt === null);
    const unfinished = recs.filter((r) => r.mergedAt === null && r.ejectedAt === null);
    const end = this.now;
    // Time in queue: merged entries, plus censored waits of unfinished ones (conservative).
    const waits = [...merged.map((r) => (r.mergedAt ?? 0) - r.enqueuedAt), ...unfinished.map((r) => end - r.enqueuedAt)].map((x) => x / MINUTE);
    const others = [...merged.filter((r) => !r.runaway).map((r) => (r.mergedAt ?? 0) - r.enqueuedAt), ...unfinished.filter((r) => !r.runaway).map((r) => end - r.enqueuedAt)].map((x) => x / MINUTE);
    const q = (xs: number[], p: number) => {
      if (xs.length === 0) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    };
    const codes: Record<string, number> = {};
    for (const r of ejected) codes[r.ejectCode ?? "?"] = (codes[r.ejectCode ?? "?"] ?? 0) + 1;
    const decided = merged.length + ejected.length;
    const sizes = [...this.batchSizes.values()];
    const runsLeaked = this.refs.size;
    return {
      scenario: this.sc.name,
      mode: this.opts.mode,
      seed: this.seed,
      arrivals: recs.length,
      merged: merged.length,
      ejected: ejected.length,
      unfinished: unfinished.length,
      backlogAtArrivalEnd: this.m.backlogAtArrivalEnd,
      simHours: end / 3_600_000,
      throughputPerHour: merged.length / Math.max(this.sc.hours, end / 3_600_000),
      timeInQueueMin: { p50: q(waits, 0.5), p95: q(waits, 0.95), p99: q(waits, 0.99) },
      phasesMin: {
        toBatchP50: q(merged.map((r) => ((r.firstBatchAt ?? r.enqueuedAt) - r.enqueuedAt) / MINUTE), 0.5),
        toBatchP95: q(merged.map((r) => ((r.firstBatchAt ?? r.enqueuedAt) - r.enqueuedAt) / MINUTE), 0.95),
        batchToMergeP50: q(merged.map((r) => ((r.mergedAt ?? 0) - (r.firstBatchAt ?? r.enqueuedAt)) / MINUTE), 0.5),
        batchToMergeP95: q(merged.map((r) => ((r.mergedAt ?? 0) - (r.firstBatchAt ?? r.enqueuedAt)) / MINUTE), 0.95),
        passedToMergeP50: q(merged.map((r) => ((r.mergedAt ?? 0) - (r.passedAt ?? r.mergedAt ?? 0)) / MINUTE), 0.5),
        passedToMergeP95: q(merged.map((r) => ((r.mergedAt ?? 0) - (r.passedAt ?? r.mergedAt ?? 0)) / MINUTE), 0.95),
      },
      timeInQueueOthersP95Min: q(others, 0.95),
      ciMinutes: this.ciMinutes,
      ciMinutesByKind: this.ciByKind,
      ciMinutesPerMerged: this.ciMinutes / Math.max(1, merged.length),
      isolatedRunMin: this.sc.ci.medianMinutes,
      ciRatio: this.ciMinutes / Math.max(1, merged.length) / this.sc.ci.medianMinutes,
      ejectRate: ejected.length / Math.max(1, decided),
      falseEjectRate: ejected.filter((r) => r.falseEject).length / Math.max(1, decided),
      ejectCodes: codes,
      resolver: { textual: { ...this.m.textual }, semantic: { ...this.m.semantic }, laneDowngradesIgnored: this.m.laneDowngradesIgnored, laneDecreases: this.m.laneDecreases },
      mainRedEvents: this.m.mainRed,
      maskedByQuarantine: this.m.masked,
      attributionFailures: this.m.attributionFailures + this.trains.attributionFailures,
      regressions: this.m.regressions,
      flagKills: this.m.flagKills,
      rollbacks: this.m.rollbacks,
      reverts: this.m.reverts,
      freezes: this.m.freezes,
      frozenMinutes: this.m.frozenMs / MINUTE,
      quarantines: this.m.quarantines,
      fallbacks: this.m.fallbacks,
      batches: sizes.length,
      avgBatchSize: sizes.length === 0 ? 0 : sizes.reduce((a, b) => a + b, 0) / sizes.length,
      probes: this.m.probes,
      landings: this.m.landings,
      maxQueueLength: this.m.maxQueue,
      predictionBrier: this.m.brier.length === 0 ? null : this.m.brier.reduce((a, b) => a + b, 0) / this.m.brier.length,
      predictions: this.m.brier.length,
      refsLeaked: runsLeaked,
      invariantViolations: this.m.violations,
      steps: this.steps,
      wallMs,
    };
  }
}
