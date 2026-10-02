/**
 * The pure scheduling core: `step(state, event, { now }) → { state, commands }`.
 *
 * No IO, no clock, no randomness: time comes from `now`, ids from a counter in the state. The
 * `MergeQueue` DO and the simulator run exactly this code (§ refer to docs/prompts/03-merge-queue.md).
 *
 * Speculation is a DAG of batches. A new batch is built on exactly the batches it conflicts with
 * (its "frontier"): on one predecessor's tip, or, when it joins several independent components (or
 * main moved under its predecessor in a conflicting way), as a merge batch rebuilt on main that
 * carries the predecessors' unmerged entries. Independent work never waits for unrelated work;
 * conflicting work is ordered. A "track" is a connected component of this DAG.
 */
import { ConflictIndex, conflicts, needsAllTests, unionAffected } from "./conflict.js";
import { type EjectInput, ejectReason } from "./eject.js";
import { InvariantViolation, invariant } from "./invariants.js";
import { predict } from "./predict.js";
import { advanceVirtualTime, assignTag, compareOrder, effectiveRank, flowKey, isExpress } from "./priority.js";
import type { CasEvidence, Command, CoreEvent, CoreEventOf, LaneRaise } from "./protocol.js";
import {
  type AffectedSet,
  type Batch,
  type FreezeReason,
  type Lane,
  type LaneReason,
  type Prediction,
  type QueueEntry,
  type QueueEvent,
  type ResolutionState,
  TERMINAL_STATES,
  type TestScope,
  type Track,
  type TreeVerdict,
  unknownAffectedSet,
} from "./schema.js";
import { cloneState, isFrozen, type QueueState } from "./state.js";

export const SYSTEM_PRINCIPAL = "system:merge-queue";
/** Failing "test" reported for a run that failed without naming a test: re-check re-runs it all. */
export const WHOLE_RUN = "__run__";
/** Hard cap on resolutions of one entry across conflicts (prevents resolve/conflict loops). */
const MAX_RESOLUTIONS_PER_ENTRY = 4;

export interface StepContext {
  now: number;
}

export interface StepResult {
  state: QueueState;
  commands: Command[];
}

/**
 * Apply one event. Throws `InvariantViolation` if the core would break a §1 invariant; the caller
 * must then discard the step (never persist a partial state).
 */
export function step(state: QueueState, event: CoreEvent, ctx: StepContext): StepResult {
  const m = new Machine(cloneState(state), ctx.now);
  m.handle(event);
  m.pump();
  m.gc();
  return { state: m.s, commands: m.out };
}

function isTerminal(e: QueueEntry): boolean {
  return TERMINAL_STATES.has(e.state);
}

function batchDone(b: Batch): boolean {
  if (b.kind === "probe") return b.state === "passed" || b.state === "failed" || b.state === "cancelled";
  return b.state === "landed" || b.state === "cancelled" || b.state === "failed";
}

function ownEntries(b: Batch): string[] {
  const out: string[] = [];
  for (const u of b.units) out.push(...u.changeIds);
  return out;
}

/** Not yet tested: counts toward speculation depth and the in-flight cap. */
function inFlight(b: Batch): boolean {
  return b.state === "pending" || b.state === "building" || b.state === "ready" || b.state === "running" || b.state === "rechecking";
}

interface PlannedUnit {
  changeIds: string[];
  entries: QueueEntry[];
  affected: AffectedSet;
  rank: number;
  tag: number;
  seq: number;
  express: boolean;
  isolate: boolean;
  p: number;
  /** Incremental dependencies outside the unit. */
  deps: string[];
  flows: Map<string, number>;
}

class Machine {
  readonly out: Command[] = [];
  private readonly predictions = new Map<string, Prediction>();

  constructor(
    readonly s: QueueState,
    readonly now: number,
  ) {}

  private get cfg() {
    return this.s.config;
  }

  // ================================================================ plumbing

  private id(prefix: string): string {
    const n = this.s.nextId++;
    return `${prefix}${n.toString(36)}`;
  }

  private entry(id: string): QueueEntry | undefined {
    return this.s.entries[id];
  }

  private batch(id: string | null): Batch | undefined {
    return id === null ? undefined : this.s.batches[id];
  }

  private emit(event: QueueEvent): void {
    this.out.push({ type: "Emit", event });
  }

  private audit(
    action: string,
    subject: string,
    payload: Record<string, unknown>,
    principalId = SYSTEM_PRINCIPAL,
    signature: string | null = null,
  ): void {
    this.out.push({ type: "Audit", action, subject, principalId, signature, payload });
  }

  private telemetry(kind: "prediction" | "outcome" | "lane-downgrade-ignored" | "rejected-event", data: Record<string, unknown>): void {
    this.out.push({ type: "Telemetry", kind, data });
  }

  private reject(event: string, why: string, data: Record<string, unknown> = {}): void {
    this.telemetry("rejected-event", { event, why, ...data });
  }

  private predictionOf(e: QueueEntry): Prediction {
    let p = this.predictions.get(e.changeId);
    if (p === undefined) {
      p = predict(this.s, e);
      this.predictions.set(e.changeId, p);
    }
    return p;
  }

  // ================================================================ events

  handle(ev: CoreEvent): void {
    switch (ev.type) {
      case "Enqueued":
        return this.onEnqueued(ev);
      case "Dequeued":
        return this.onDequeued(ev);
      case "Reprioritized":
        return this.onReprioritized(ev);
      case "AffectedSetComputed":
        return this.onAffected(ev);
      case "RebaseResult":
        return this.onRebase(ev);
      case "BatchResult":
        return this.onBatchResult(ev);
      case "FlakeRecheckResult":
        return this.onRecheck(ev);
      case "ResolutionResult":
        return this.onResolution(ev);
      case "CasResult":
        return this.onCasResult(ev);
      case "MainAdvanced":
        return this.onExternalMain(ev.sha);
      case "PostMergeCheckFailed":
        return this.onPostMergeFailed(ev);
      case "RevertLanded":
        return this.onRevertLanded([ev.changeId]);
      case "Freeze":
        return this.onFreeze(ev);
      case "Thaw":
        return this.onThaw(ev);
      case "Approved":
        return this.onApproved(ev);
      case "Unquarantined":
        return this.onUnquarantined(ev);
      case "Tick":
        return this.onTick();
      case "ConfigUpdated":
        this.s.config = ev.config;
        return;
    }
  }

  private onEnqueued(ev: CoreEventOf<"Enqueued">): void {
    const existing = this.entry(ev.changeId);
    if (existing !== undefined && !isTerminal(existing)) {
      if (existing.headSha === ev.headSha) return; // idempotent re-enqueue
      if (this.inCas(existing.changeId)) {
        this.reject("Enqueued", "a previous head is landing right now; retry after it settles", { changeId: ev.changeId });
        return;
      }
      // New head: the old one leaves the queue (dependents keep waiting for the new one).
      this.removeFromFlight(existing);
      this.terminate(
        existing,
        "ejected",
        { changeId: existing.changeId, code: "superseded", message: `head ${existing.headSha.slice(0, 12)} replaced by ${ev.headSha.slice(0, 12)}` },
        SYSTEM_PRINCIPAL,
        false,
      );
    }
    const seq = ++this.s.seq;
    // Already-merged dependencies are satisfied (the shell should leave them out; be robust).
    const deps = [...new Set(ev.dependsOn)].filter((d) => d !== ev.changeId && this.entry(d)?.state !== "merged");
    const approvedLane: Lane = ev.approvedLane ?? ev.lane;
    const e: QueueEntry = {
      changeId: ev.changeId,
      headSha: ev.headSha,
      authorId: ev.authorId,
      enqueuedAt: this.now,
      enqueuedBy: ev.enqueuedBy,
      seq,
      priority: ev.priority,
      lane: ev.lane,
      approvedLane: approvedLane < ev.lane ? ev.lane : approvedLane,
      laneReasons: [],
      dependsOn: deps,
      landMode: ev.landMode,
      plangroup: ev.plangroup,
      landTogether: ev.plangroup !== null && ev.landTogether,
      groupSize: ev.groupSize,
      revertOf: ev.revertOf,
      automaticRevert: ev.automaticRevert && ev.revertOf !== null,
      flagKey: ev.flagKey,
      affected: ev.affected,
      affectedRequestedAt: ev.affected === null ? this.now : null,
      state: "waiting",
      hold: null,
      attempts: 0,
      infraErrors: 0,
      trackId: null,
      batchId: null,
      ejectReason: null,
      resolution: null,
      resolverIds: [],
      approvalRequired: ev.approvedLane !== undefined && ev.approvedLane < ev.lane,
      size: ev.size,
      evidence: ev.evidence,
      prediction: null,
      wfqTag: 0,
      isolate: false,
      dequeueRequested: false,
      waitFor: [],
      firstBatchAt: null,
      mergedSha: null,
      terminalAt: null,
    };
    e.wfqTag = assignTag(this.s, e);
    this.s.entries[e.changeId] = e;
    if (e.affected === null) this.out.push({ type: "ComputeAffectedSet", changeId: e.changeId, headSha: e.headSha });
    else this.applyQuarantineTo(e);
    if (e.approvalRequired) this.requestApproval(e);
    this.audit("merge-queue.enqueued", `change:${e.changeId}`, {
      headSha: e.headSha,
      priority: e.priority,
      lane: e.lane,
      dependsOn: e.dependsOn,
      plangroup: e.plangroup,
      landMode: e.landMode,
      by: e.enqueuedBy,
    });
    // Atomic stacks land in one CAS: pull an in-flight dependency back so they batch together.
    if (e.landMode === "atomic") {
      for (const d of e.dependsOn) {
        const de = this.entry(d);
        if (de !== undefined && de.batchId !== null && !this.inCas(d)) this.removeFromFlight(de);
      }
    }
    if (e.automaticRevert && e.revertOf !== null) {
      this.addFreezeReason({
        kind: "revert-in-progress",
        at: this.now,
        sha: null,
        changeId: e.changeId,
        signer: null,
        message: `automatic revert ${e.changeId} of ${e.revertOf} in progress`,
      });
      this.markBad(this.landedSeqOf(e.revertOf) ?? this.s.main.seq);
    }
  }

  private onDequeued(ev: CoreEventOf<"Dequeued">): void {
    const e = this.entry(ev.changeId);
    if (e === undefined || isTerminal(e)) return;
    if (this.inCas(e.changeId)) {
      e.dequeueRequested = true;
      return;
    }
    this.removeFromFlight(e);
    this.terminate(e, "dequeued", null, ev.by);
  }

  private onReprioritized(ev: CoreEventOf<"Reprioritized">): void {
    const e = this.entry(ev.changeId);
    if (e === undefined || isTerminal(e)) return;
    const human = ev.by.kind === "human";
    if (ev.priority === "incident" && !human && ev.incidentPlanId === null) {
      this.reject("Reprioritized", "the incident class needs a human or an incident Plan", { changeId: e.changeId, by: ev.by.principalId });
      return;
    }
    if (ev.priority === "revert" && e.revertOf === null && !human) {
      this.reject("Reprioritized", "only reverts (or a human) may use the revert class", { changeId: e.changeId });
      return;
    }
    const from = e.priority;
    e.priority = ev.priority;
    this.audit("merge-queue.reprioritized", `change:${e.changeId}`, { from, to: ev.priority, by: ev.by.principalId, incidentPlanId: ev.incidentPlanId });
  }

  private onAffected(ev: CoreEventOf<"AffectedSetComputed">): void {
    const e = this.entry(ev.changeId);
    if (e === undefined || isTerminal(e) || e.headSha !== ev.headSha) return;
    // In flight, only the timeout's placeholder may be replaced (by a narrower set: still safe).
    if (e.affected !== null && e.affected.complete && e.batchId !== null) return;
    e.affected = ev.affected;
    e.affectedRequestedAt = null;
    this.applyQuarantineTo(e);
  }

  // ---------------------------------------------------------------- trees and runs

  private onRebase(ev: CoreEventOf<"RebaseResult">): void {
    const b = this.batch(ev.batchId);
    if (b === undefined || b.state !== "building") {
      // A build for a batch we no longer want: make sure its ref doesn't leak.
      if (ev.result.status === "clean") this.out.push({ type: "DeleteQueueRef", refName: `refs/queue/${ev.batchId}` });
      return;
    }
    if (ev.result.status === "conflict") {
      this.onTextualConflict(b, ev.result.changeId, ev.result.files, ev.result.upstream);
      return;
    }
    const expected = [...b.carried, ...ownEntries(b)];
    const got = ev.result.commits.map((c) => c.changeId);
    const last = ev.result.commits[ev.result.commits.length - 1];
    if (
      got.length !== expected.length ||
      got.some((id, i) => id !== expected[i]) ||
      last === undefined ||
      last.commitSha !== ev.result.tipSha ||
      last.treeSha !== ev.result.treeSha
    ) {
      this.audit("merge-queue.build-mismatch", `batch:${b.id}`, { expected, got });
      this.infraRetry(b, "build result does not match the requested entries", "pending");
      return;
    }
    b.tipSha = ev.result.tipSha;
    b.treeSha = ev.result.treeSha;
    b.commits = ev.result.commits;
    b.state = "ready";
  }

  private onBatchResult(ev: CoreEventOf<"BatchResult">): void {
    const b = this.batch(ev.batchId);
    if (b === undefined || b.state !== "running" || b.runId !== ev.runId) return; // stale
    if (ev.outcome === "errored" || ev.outcome === "cancelled") {
      this.infraRetry(b, `run ${ev.runId} ${ev.outcome}`, "ready");
      return;
    }
    if (ev.treeSha !== b.treeSha) {
      // Never count a result for a different tree: main only advances to exactly-tested trees.
      this.audit("merge-queue.result-tree-mismatch", `batch:${b.id}`, { runId: ev.runId, expected: b.treeSha, got: ev.treeSha });
      this.infraRetry(b, "result for a different tree", "ready");
      return;
    }
    if (!this.scopeCovers(ev.scope, b.targets)) {
      this.audit("merge-queue.result-scope-short", `batch:${b.id}`, { runId: ev.runId, wanted: b.targets, got: ev.scope });
      this.infraRetry(b, "run did not cover the required targets", "ready");
      return;
    }
    if (b.targets === "all") {
      this.s.stats.fullRuns++;
      if (ev.durationMs !== undefined && b.kind !== "landing")
        this.s.stats.ciDurationMs = Math.round(0.8 * this.s.stats.ciDurationMs + 0.2 * ev.durationMs);
    }
    let failing = [...new Set(ev.failingTests)];
    if (ev.outcome === "failed" && failing.length === 0) failing = [WHOLE_RUN];
    // Quarantined tests go through the same re-check: the quarantine only excuses failures that
    // also happen on main's head; a regression of a quarantined test still blocks (never masked).
    const candidates = failing;
    const verdict = this.newVerdict(b, ev.runId, []);
    if (candidates.length === 0) {
      this.onVerdict(b, verdict);
      return;
    }
    if (this.cfg.features.flakeRecheck) {
      invariant(b.tipSha !== null && b.treeSha !== null, "recheck.tree", "re-check of an unbuilt batch");
      b.state = "rechecking";
      b.recheck = { tests: candidates, mainSha: this.s.main.sha };
      b.verdict = verdict;
      b.runSeq++;
      b.runId = `${b.id}-k${b.runSeq}`;
      b.startedAt = this.now;
      this.out.push({
        type: "RunFlakeRecheck",
        batchId: b.id,
        runId: b.runId,
        treeSha: b.treeSha,
        commitSha: b.tipSha,
        mainSha: this.s.main.sha,
        tests: candidates,
      });
      return;
    }
    this.onVerdict(b, { ...verdict, passed: false, failing: candidates });
  }

  private onRecheck(ev: CoreEventOf<"FlakeRecheckResult">): void {
    const b = this.batch(ev.batchId);
    if (b === undefined || b.state !== "rechecking" || b.runId !== ev.runId || b.recheck === null) return;
    const base = b.verdict ?? this.newVerdict(b, ev.runId, []);
    const byTest = new Map(ev.results.map((r) => [r.test, r]));
    const real: string[] = [];
    const flaky: string[] = [];
    const quarantined: string[] = [...base.quarantined];
    for (const t of b.recheck.tests) {
      const r = byTest.get(t);
      const stats = this.s.flakes[t] ?? { flaky: 0, real: 0, lastAt: this.now };
      stats.lastAt = this.now;
      this.s.flakes[t] = stats;
      if (r === undefined || (r.onBatch === "failed" && r.onMain === "passed")) {
        // Reproduced on the batch tree only (or no answer: unknown escalates) → real.
        stats.real++;
        real.push(t);
      } else if (r.onBatch === "failed" && r.onMain === "failed") {
        if (t === WHOLE_RUN) {
          // The whole pipeline fails on main's head too: infrastructure, not this batch.
          b.recheck = null;
          this.infraRetry(b, "the whole run fails on main's head too", "ready");
          return;
        }
        // Fails on main's head too → suspected flaky: quarantine (if not yet), don't eject (§4.7).
        stats.flaky++;
        if (this.s.quarantine[t] === undefined) this.quarantineTest(t, b, b.recheck.mainSha);
        quarantined.push(t);
      } else {
        // Passed when re-run on exactly this tree: a flake; the re-run is the result for the tree.
        stats.flaky++;
        flaky.push(t);
      }
    }
    const verdict: TreeVerdict = {
      ...base,
      runIds: [...base.runIds, ev.runId],
      quarantined: [...new Set(quarantined)],
      flakyRetried: [...new Set([...base.flakyRetried, ...flaky])],
      failing: real,
      passed: real.length === 0,
    };
    b.recheck = null;
    this.onVerdict(b, verdict);
  }

  private newVerdict(b: Batch, runId: string, quarantinedFailing: string[]): TreeVerdict {
    invariant(b.treeSha !== null && b.tipSha !== null && b.baseSha !== null, "verdict.tree", `verdict for unbuilt batch ${b.id}`);
    return {
      treeSha: b.treeSha,
      commitSha: b.tipSha,
      baseSha: b.baseSha,
      scope: b.targets,
      runIds: [runId],
      passed: true,
      failing: [],
      quarantined: [...new Set([...quarantinedFailing, ...this.relevantQuarantine(this.landingEntriesOf(b))])],
      flakyRetried: [],
    };
  }

  private scopeCovers(got: TestScope, wanted: TestScope): boolean {
    if (got === "all") return true;
    if (wanted === "all") return false;
    const have = new Set(got);
    return wanted.every((t) => have.has(t));
  }

  private onVerdict(b: Batch, verdict: TreeVerdict): void {
    b.verdict = verdict;
    if (verdict.passed) {
      b.state = "passed";
      b.readyAt = this.now;
      if (b.kind === "chain") {
        this.s.stats.batchPassRate = 0.8 * this.s.stats.batchPassRate + 0.2;
        for (const id of ownEntries(b)) {
          const e = this.entry(id);
          if (e !== undefined && e.batchId === b.id) e.state = "passed";
        }
        this.settleChildBisections(b.id);
      } else if (b.kind === "probe") {
        this.onProbeSettled(b, true);
      }
      return;
    }
    switch (b.kind) {
      case "chain":
        return this.onChainFailure(b);
      case "probe":
        b.state = "failed";
        return this.onProbeSettled(b, false);
      case "landing":
        return this.onLandingFailure(b);
    }
  }

  private infraRetry(b: Batch, why: string, back: "pending" | "ready"): void {
    b.infraRetries++;
    if (b.infraRetries <= this.cfg.maxInfraRetries) {
      b.state = back;
      if (back === "pending") {
        b.tipSha = null;
        b.treeSha = null;
        b.commits = [];
      }
      return;
    }
    this.audit("merge-queue.batch-gave-up", `batch:${b.id}`, { why, retries: b.infraRetries });
    switch (b.kind) {
      case "probe": {
        b.state = "cancelled";
        const parent = this.batch(b.probe?.of ?? null);
        if (parent !== undefined && parent.state === "bisecting") this.abortBisection(parent, why);
        return;
      }
      case "landing": {
        for (const m of b.members) {
          const mb = this.batch(m);
          if (mb !== undefined) mb.noRevalidate = true;
        }
        const i = this.s.landing.indexOf(b.id);
        if (i >= 0) this.invalidateLanding(i, why);
        return;
      }
      case "chain": {
        const own = ownEntries(b);
        this.cancelTree(b, why);
        for (const id of own) {
          const e = this.entry(id);
          if (e === undefined || isTerminal(e)) continue;
          e.infraErrors++;
          if (e.infraErrors > this.cfg.maxInfraRetries) {
            this.removeFromFlight(e);
            this.terminate(e, "ejected", { changeId: id, code: "infra-error", message: `CI could not produce a result (${why})` });
          }
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------- the speculation DAG

  /** Active chain batches (in some track), oldest first. */
  private activeChain(): Batch[] {
    const out: Batch[] = [];
    for (const t of Object.values(this.s.tracks))
      for (const bid of t.chain) {
        const b = this.batch(bid);
        if (b !== undefined) out.push(b);
      }
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  private isActiveChain(b: Batch): boolean {
    const t = this.s.tracks[b.trackId ?? ""];
    return b.kind === "chain" && t !== undefined && t.chain.includes(b.id);
  }

  /** Active chain batches whose own entries are in b's tree (its ancestors). */
  private ancestorsOf(b: Batch): Batch[] {
    const own = new Set(ownEntries(b));
    const out = new Map<string, Batch>();
    for (const id of b.lineage) {
      if (own.has(id)) continue;
      const e = this.entry(id);
      if (e === undefined || isTerminal(e)) continue;
      const a = this.batch(e.batchId);
      if (a !== undefined && a.id !== b.id && this.isActiveChain(a)) out.set(a.id, a);
    }
    return [...out.values()];
  }

  /** Active chain batches whose tree contains any of b's own entries. */
  private descendantsOf(b: Batch): Batch[] {
    const own = ownEntries(b);
    if (own.length === 0) return [];
    return this.activeChain().filter((c) => c.id !== b.id && this.builtOn(c, own));
  }

  private builtOn(c: Batch, entries: string[]): boolean {
    return entries.some((id) => c.lineage.includes(id));
  }

  private removeFromTrack(b: Batch): void {
    const t = this.s.tracks[b.trackId ?? ""];
    if (t === undefined) return;
    t.chain = t.chain.filter((x) => x !== b.id);
    if (t.chain.length === 0) delete this.s.tracks[t.id];
  }

  /** Cancel b (unless `keepSelf`) and every batch built on it; their entries wait again. */
  private cancelTree(b: Batch, why: string, keepSelf = false): void {
    const victims = [...this.descendantsOf(b), ...(keepSelf ? [] : [b])];
    for (const v of victims) invariant(!this.batchInCas(v), "cancel.in-cas", `cannot cancel ${v.id}: CAS in flight`);
    for (const v of victims) {
      const li = this.s.landing.findIndex((lid) => this.batch(lid)?.members.includes(v.id) === true);
      if (li >= 0) this.invalidateLanding(li, why);
      this.removeFromTrack(v);
      this.cancelBatch(v, why);
      this.returnUnits(v);
      this.abortChildBisections(v, why);
    }
  }

  private mergeTracks(ids: string[]): Track | undefined {
    const tracks = [...new Set(ids)]
      .map((id) => this.s.tracks[id])
      .filter((t): t is Track => t !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const keep = tracks[0];
    if (keep === undefined) return undefined;
    for (const t of tracks.slice(1)) {
      for (const bid of t.chain) {
        const b = this.batch(bid);
        if (b === undefined) continue;
        b.trackId = keep.id;
        for (const id of ownEntries(b)) {
          const e = this.entry(id);
          if (e !== undefined && e.batchId === bid) e.trackId = keep.id;
        }
      }
      keep.chain = [...keep.chain, ...t.chain];
      keep.express = keep.express || t.express;
      delete this.s.tracks[t.id];
    }
    return keep;
  }

  // ---------------------------------------------------------------- failures and bisection (§4.3)

  private onChainFailure(b: Batch): void {
    this.s.stats.batchPassRate = 0.8 * this.s.stats.batchPassRate;
    // Everything built on b contains the culprit: re-form it right away (it doesn't wait for the
    // bisection). b itself leaves the DAG and is bisected on the side.
    if (this.isActiveChain(b)) {
      this.cancelTree(b, `ancestor ${b.id} failed`, true);
      this.removeFromTrack(b);
    }
    // Children already bisecting on top of b: their base is bad, their verdicts are moot.
    this.abortChildBisections(b, `ancestor ${b.id} failed`);
    for (const id of ownEntries(b)) {
      const e = this.entry(id);
      if (e !== undefined) e.attempts++;
    }
    b.state = "bisecting";
    b.bisect = {
      lo: b.carried.length > 0 ? -1 : 0,
      hi: b.units.length,
      probeIds: [],
      round: 0,
      failingTests: b.verdict?.failing ?? [],
      runIds: b.verdict?.runIds ?? [],
    };
    this.resolveBisection(b);
  }

  /** "good": the tree b was built on passed; "bad": it failed or vanished; "pending": unknown yet. */
  private baseStatus(b: Batch): "good" | "bad" | "pending" {
    if (b.parentId === null) return "good"; // main (green by construction); carried entries get probe 0
    const p = this.batch(b.parentId);
    if (p === undefined) return "bad";
    if (p.verdict?.passed === true) return "good";
    if (p.state === "failed" || p.state === "bisecting" || p.state === "cancelled") return "bad";
    return "pending";
  }

  private resolveBisection(b: Batch): void {
    const bis = b.bisect;
    if (b.state !== "bisecting" || bis === null) return;
    const base = this.baseStatus(b);
    if (base === "bad") {
      this.abortBisection(b, "the batch it was built on failed");
      return;
    }
    if (bis.hi - bis.lo <= 1) {
      if (bis.hi <= 0) {
        // The carried entries alone fail: not this batch's fault. Wait for them to settle in their
        // own batches before trying again (else the same merge would be rebuilt and fail forever).
        this.abortBisection(b, "the carried entries fail without this batch's own units");
        this.waitForCarried(b);
        return;
      }
      if (base === "pending") return; // decided once the parent settles
      this.decideCulprit(b, bis.hi - 1);
      return;
    }
    if (!this.cfg.features.bisection) {
      // Naive alternative: every unit is re-tested on its own.
      for (const id of ownEntries(b)) {
        const e = this.entry(id);
        if (e !== undefined && e.batchId === b.id) {
          e.isolate = true;
          this.toWaiting(e);
        }
      }
      this.waitForCarried(b);
      this.finishBatch(b, "failed");
      return;
    }
    if (bis.probeIds.some((p) => !batchDone(this.batch(p) ?? b))) return;
    const span = bis.hi - bis.lo;
    const n = Math.min(this.cfg.bisectProbes, span - 1);
    const positions = new Set<number>();
    for (let i = 1; i <= n; i++) positions.add(bis.lo + Math.round((i * span) / (n + 1)));
    const probes: string[] = [];
    for (const pos of [...positions].sort((x, y) => x - y)) {
      if (pos <= bis.lo || pos >= bis.hi) continue;
      probes.push(this.createProbe(b, pos));
    }
    b.bisect = { ...bis, probeIds: probes, round: bis.round + 1 };
  }

  private createProbe(b: Batch, prefixUnits: number): string {
    const units = b.units.slice(0, prefixUnits);
    let n = b.carried.length;
    for (const u of units) n += u.changeIds.length;
    const c = b.commits[n - 1];
    invariant(c !== undefined && b.baseSha !== null, "probe.commit", `no commit for prefix ${n} of ${b.id}`);
    const id = this.id("p");
    this.s.batches[id] = {
      id,
      kind: "probe",
      trackId: b.trackId,
      parentId: null,
      mergeParents: [],
      carried: b.carried,
      rootBase: b.rootBase,
      rootSeq: b.rootSeq,
      baseSha: b.baseSha,
      units,
      lineage: [],
      state: "ready",
      tipSha: c.commitSha,
      treeSha: c.treeSha,
      commits: b.commits.slice(0, n),
      refName: b.refName,
      runId: null,
      runSeq: 0,
      startedAt: null,
      targets: "all",
      verdict: null,
      recheck: null,
      bisect: null,
      probe: { of: b.id, prefixUnits },
      members: [],
      fallbackOf: null,
      noRevalidate: false,
      createdAt: this.now,
      readyAt: null,
      infraRetries: 0,
    };
    return id;
  }

  private onProbeSettled(p: Batch, passed: boolean): void {
    const b = this.batch(p.probe?.of ?? null);
    if (b === undefined || b.state !== "bisecting" || b.bisect === null || p.probe === null) return;
    const bis = { ...b.bisect };
    const pos = p.probe.prefixUnits;
    if (passed) {
      if (pos < bis.hi) bis.lo = Math.max(bis.lo, pos);
    } else if (pos < bis.hi) {
      bis.hi = pos;
      bis.failingTests = p.verdict?.failing ?? bis.failingTests;
      bis.runIds = [...bis.runIds, ...(p.verdict?.runIds ?? [])];
      if (bis.lo >= bis.hi) {
        // Contradictory results (only a flake can do this): keep the best passing prefix below hi.
        let lo = b.carried.length > 0 ? -1 : 0;
        for (const id of bis.probeIds) {
          const q = this.batch(id);
          if (q?.state === "passed" && q.probe !== null && q.probe.prefixUnits < bis.hi) lo = Math.max(lo, q.probe.prefixUnits);
        }
        bis.lo = lo;
      }
    }
    b.bisect = bis;
    const allDone = bis.probeIds.every((id) => batchDone(this.batch(id) ?? p));
    if (bis.hi - bis.lo <= 1 || allDone) {
      for (const id of bis.probeIds) {
        const q = this.batch(id);
        if (q !== undefined && !batchDone(q)) this.cancelBatch(q, "bisection decided");
      }
      this.resolveBisection(b);
    }
  }

  private settleChildBisections(parentId: string): void {
    for (const b of Object.values(this.s.batches)) if (b.state === "bisecting" && b.parentId === parentId) this.resolveBisection(b);
  }

  /** A bisection whose base contains a failed/cancelled batch's entries is moot. */
  private abortChildBisections(gone: Batch, why: string): void {
    const own = ownEntries(gone);
    for (const b of Object.values(this.s.batches)) {
      if (b.state !== "bisecting" || b.id === gone.id) continue;
      const bOwn = new Set(ownEntries(b));
      if (b.parentId === gone.id || own.some((id) => !bOwn.has(id) && b.lineage.includes(id))) this.abortBisection(b, why);
    }
  }

  /** Own units of a failed merge batch wait until its carried entries landed or left the queue. */
  private waitForCarried(b: Batch): void {
    const pending = b.carried.filter((id) => {
      const e = this.entry(id);
      return e !== undefined && !isTerminal(e);
    });
    if (pending.length === 0) return;
    for (const id of ownEntries(b)) {
      const e = this.entry(id);
      if (e !== undefined && e.state === "waiting") e.waitFor = [...new Set([...e.waitFor, ...pending])];
    }
  }

  private abortBisection(b: Batch, why: string): void {
    for (const id of b.bisect?.probeIds ?? []) {
      const q = this.batch(id);
      if (q !== undefined && !batchDone(q)) this.cancelBatch(q, why);
    }
    this.returnUnits(b);
    this.finishBatch(b, "cancelled");
  }

  private decideCulprit(b: Batch, idx: number): void {
    const unit = b.units[idx];
    invariant(unit !== undefined, "bisect.index", `culprit index ${idx} out of range in ${b.id}`);
    const bis = b.bisect;
    for (const id of bis?.probeIds ?? []) {
      const q = this.batch(id);
      if (q !== undefined && !batchDone(q)) this.cancelBatch(q, "culprit found");
    }
    const failing = bis?.failingTests ?? [];
    const runIds = bis?.runIds ?? [];
    const prefix = b.units.slice(0, idx).flatMap((u) => u.changeIds);
    const own = ownEntries(b);
    const ancestors = b.lineage.filter((id) => !own.includes(id));
    // Innocents re-form into new batches automatically.
    b.units.forEach((u, i) => {
      if (i === idx) return;
      for (const id of u.changeIds) {
        const e = this.entry(id);
        if (e !== undefined && e.batchId === b.id) this.toWaiting(e);
      }
    });
    const culprits = unit.changeIds
      .map((id) => this.entry(id))
      .filter((e): e is QueueEntry => e !== undefined && e.batchId === b.id && !isTerminal(e));
    for (const e of culprits) this.toWaiting(e);
    this.finishBatch(b, "failed");
    const single = culprits.length === 1 ? culprits[0] : undefined;
    if (single !== undefined && this.canResolve(single, "semantic")) {
      const upstream = [...new Set([...prefix, ...ancestors, ...this.overlappingLanded(single)])].slice(0, 20);
      this.startResolution(single, "semantic", {
        upstream,
        files: [],
        failingTests: failing,
        ontoSha: b.baseSha ?? this.s.main.sha,
        preceding: [...b.carried, ...prefix],
      });
      return;
    }
    for (const e of culprits) {
      this.authorOutcome(e, false);
      this.terminate(e, "ejected", {
        changeId: e.changeId,
        code: culprits.length > 1 && e !== culprits[0] ? "group-member-failed" : "tests-failed",
        message:
          culprits.length > 1
            ? `land-together unit ${unit.changeIds.join(", ")} fails ${failing.join(", ") || "its checks"} on the queue's tree`
            : `fails ${failing.join(", ") || "its checks"} on the queue's tree (reproduced; not a flake)`,
        failingTests: failing,
        upstream: culprits.length > 1 ? unit.changeIds.filter((x) => x !== e.changeId) : [],
        evidenceRefs: runIds.map((r) => `ci-run:${r}`),
      });
    }
  }

  /** Changes landed since `e` was enqueued whose affected sets overlap it (conflict suspects). */
  private overlappingLanded(e: QueueEntry): string[] {
    const out: string[] = [];
    for (const m of this.s.mainLog) {
      if (m.at < e.enqueuedAt) continue;
      for (const c of m.changes) if (conflicts(c.affected, e.affected)) out.push(c.changeId);
    }
    return out;
  }

  // ---------------------------------------------------------------- conflicts and resolution (§4.4)

  private onTextualConflict(b: Batch, changeId: string, files: string[], upstream: string[]): void {
    if (b.kind === "landing") {
      // The affected-set analysis missed an overlap: that member needs a full rebuild on main.
      const member = b.members.find((m) => ownEntries(this.batch(m) ?? b).includes(changeId));
      const mb = this.batch(member ?? null);
      if (mb !== undefined) mb.noRevalidate = true;
      const i = this.s.landing.indexOf(b.id);
      if (i >= 0) this.invalidateLanding(i, `rebase conflict on ${changeId} during revalidation`);
      return;
    }
    const own = ownEntries(b);
    if (!own.includes(changeId)) {
      // A carried entry (another batch's) doesn't rebase onto current main: this merge can't be
      // built yet. Its units wait until that entry has landed (or left the queue).
      this.cancelTree(b, `carried ${changeId} does not apply on main`);
      for (const id of own) {
        const e = this.entry(id);
        if (e !== undefined && !isTerminal(e)) e.waitFor = [...new Set([...e.waitFor, changeId])];
      }
      return;
    }
    const ui = b.units.findIndex((u) => u.changeIds.includes(changeId));
    const preceding = [...b.carried, ...b.units.slice(0, Math.max(0, ui)).flatMap((u) => u.changeIds)];
    const at = b.lineage.indexOf(changeId);
    const lineageBefore = b.lineage.slice(0, at >= 0 ? at : b.lineage.length);
    if (this.isActiveChain(b)) this.cancelTree(b, `rebase conflict on ${changeId}`);
    const e = this.entry(changeId);
    if (e === undefined || isTerminal(e)) return;
    if (e.batchId !== null) this.removeFromFlight(e);
    const suspects = upstream.length > 0 ? upstream : [...new Set([...lineageBefore, ...this.overlappingLanded(e)])].slice(0, 20);
    if (this.canResolve(e, "textual")) {
      this.startResolution(e, "textual", { upstream: suspects, files, failingTests: [], ontoSha: b.baseSha ?? this.s.main.sha, preceding });
      return;
    }
    this.terminate(e, "ejected", {
      changeId,
      code: "textual-conflict",
      message: `no longer applies cleanly${files.length ? ` (${files.slice(0, 5).join(", ")})` : ""}`,
      files,
      upstream: suspects,
    });
  }

  private canResolve(e: QueueEntry, kind: ResolutionState["kind"]): boolean {
    if (!this.cfg.features.resolver) return false;
    if (e.resolverIds.length >= MAX_RESOLUTIONS_PER_ENTRY) return false;
    const r = e.resolution;
    if (r === null || r.resolved || r.kind !== kind) return true;
    return r.attempts < this.cfg.resolutionMaxAttempts;
  }

  private startResolution(
    e: QueueEntry,
    kind: ResolutionState["kind"],
    info: { upstream: string[]; files: string[]; failingTests: string[]; ontoSha: string; preceding: string[] },
  ): void {
    const prev = e.resolution;
    const attempts = prev !== null && !prev.resolved && prev.kind === kind ? prev.attempts + 1 : 1;
    e.state = "resolving";
    e.batchId = null;
    e.trackId = null;
    e.resolution = { kind, attempts, upstream: info.upstream, files: info.files, failingTests: info.failingTests, blamed: null, resolved: false };
    this.out.push({
      type: "RequestResolution",
      changeId: e.changeId,
      attempt: attempts,
      kind,
      headSha: e.headSha,
      ontoSha: info.ontoSha,
      preceding: info.preceding,
      upstream: info.upstream,
      files: info.files,
      failingTests: info.failingTests,
      excludePrincipals: [e.authorId],
    });
    this.emit({ type: "resolving_conflict", at: this.now, changeId: e.changeId, kind, upstream: info.upstream, attempt: attempts });
  }

  private onResolution(ev: CoreEventOf<"ResolutionResult">): void {
    const e = this.entry(ev.changeId);
    const r = e?.resolution ?? null;
    if (e === undefined || e.state !== "resolving" || r === null || ev.attempt !== r.attempts) {
      this.reject("ResolutionResult", "no matching resolution in progress", { changeId: ev.changeId, attempt: ev.attempt });
      return;
    }
    let outcome = ev.outcome;
    if (ev.resolverId === e.authorId) {
      // The resolver must not be the Change's authoring agent (no self-approval of resolutions).
      this.audit("merge-queue.self-resolution-rejected", `change:${e.changeId}`, { resolverId: ev.resolverId });
      outcome = { status: "failed", message: "resolver is the Change's author" };
    } else if (outcome.status === "resolved" && r.kind === "semantic" && outcome.blamedUpstream === null) {
      outcome = { status: "failed", message: "semantic resolution did not name the upstream Change" };
    }
    switch (outcome.status) {
      case "resolved": {
        if (outcome.lane < e.lane)
          this.telemetry("lane-downgrade-ignored", { changeId: e.changeId, lane: e.lane, reported: outcome.lane, resolverId: ev.resolverId });
        const reasons: LaneReason[] = [...outcome.laneReasons];
        if (outcome.outsideHunks)
          reasons.push({ code: "merge-queue.resolution-outside-hunks", lane: 1, message: "The conflict resolution touches lines outside the conflict hunks." });
        // The lane may only stay or rise: the core keeps the max.
        this.raiseLane(e, Math.max(outcome.lane, outcome.outsideHunks ? 1 : 0) as Lane, reasons, false);
        e.headSha = outcome.newHeadSha;
        e.resolverIds = [...e.resolverIds, ev.resolverId];
        e.resolution = { ...r, resolved: true, blamed: outcome.blamedUpstream };
        e.affected = outcome.affected;
        e.affectedRequestedAt = outcome.affected === null ? this.now : null;
        e.state = "waiting";
        if (outcome.affected === null) this.out.push({ type: "ComputeAffectedSet", changeId: e.changeId, headSha: e.headSha });
        else this.applyQuarantineTo(e);
        if (outcome.outsideHunks || e.lane > e.approvedLane) {
          e.approvalRequired = true;
          this.requestApproval(e);
        }
        this.audit("merge-queue.conflict-resolved", `change:${e.changeId}`, {
          kind: r.kind,
          resolverId: ev.resolverId,
          resolutionRef: outcome.resolutionRef,
          upstream: r.upstream,
          blamedUpstream: outcome.blamedUpstream,
          outsideHunks: outcome.outsideHunks,
          lane: e.lane,
          newHeadSha: outcome.newHeadSha,
        });
        this.emit({
          type: "resolution_ready",
          at: this.now,
          changeId: e.changeId,
          newHeadSha: e.headSha,
          lane: e.lane,
          blamedUpstream: outcome.blamedUpstream,
          approvalRequired: e.approvalRequired,
        });
        return;
      }
      case "not-a-conflict": {
        this.authorOutcome(e, false);
        this.terminate(e, "ejected", {
          changeId: e.changeId,
          code: "tests-failed",
          message: `fails ${r.failingTests.join(", ") || "its checks"} on the queue's tree; the resolver found no upstream cause: ${outcome.message}`,
          failingTests: r.failingTests,
          upstream: r.upstream,
        });
        return;
      }
      case "budget-exhausted":
        this.terminate(e, "ejected", { changeId: e.changeId, code: "resolution-budget-exhausted", message: outcome.message, upstream: r.upstream, files: r.files });
        return;
      case "failed": {
        if (r.attempts < this.cfg.resolutionMaxAttempts && e.resolverIds.length < MAX_RESOLUTIONS_PER_ENTRY) {
          this.startResolution(e, r.kind, { upstream: r.upstream, files: r.files, failingTests: r.failingTests, ontoSha: this.s.main.sha, preceding: [] });
          return;
        }
        if (r.kind === "semantic") this.authorOutcome(e, false);
        this.terminate(e, "ejected", {
          changeId: e.changeId,
          code: r.kind === "semantic" ? "semantic-conflict" : "textual-conflict",
          message: `resolution failed ${r.attempts} time(s): ${outcome.message}`,
          failingTests: r.failingTests,
          upstream: r.upstream,
          files: r.files,
        });
        return;
      }
    }
  }

  private requestApproval(e: QueueEntry): void {
    this.out.push({
      type: "RequestApproval",
      changeId: e.changeId,
      lane: e.lane,
      reasons: e.laneReasons,
      excludePrincipals: [...new Set([e.authorId, ...e.resolverIds])],
    });
  }

  /** Lanes only rise. Returns true if the lane changed. */
  private raiseLane(e: QueueEntry, lane: Lane, reasons: LaneReason[], request = true): boolean {
    const known = new Set(e.laneReasons.map((r) => r.code));
    const fresh = reasons.filter((r) => !known.has(r.code));
    if (fresh.length > 0) e.laneReasons = [...e.laneReasons, ...fresh];
    if (lane <= e.lane) return false;
    e.lane = lane;
    if (e.lane > e.approvedLane) {
      const was = e.approvalRequired;
      e.approvalRequired = true;
      if (request && !was) this.requestApproval(e);
    }
    return true;
  }

  private onApproved(ev: CoreEventOf<"Approved">): void {
    const e = this.entry(ev.changeId);
    if (e === undefined || isTerminal(e)) return;
    const pid = ev.approver.principalId;
    if (pid === e.authorId || e.resolverIds.includes(pid)) {
      this.audit("merge-queue.self-approval-rejected", `change:${e.changeId}`, { approver: pid });
      this.reject("Approved", "no self-approval (author or resolver)", { changeId: e.changeId, approver: pid });
      return;
    }
    if (ev.approver.kind !== "human" && ev.lane >= 1) {
      this.reject("Approved", "Lane 1+ needs a human approval", { changeId: e.changeId, approver: pid });
      return;
    }
    if (ev.lane < e.lane) {
      this.reject("Approved", `approval covers lane ${ev.lane}, the Change is lane ${e.lane}`, { changeId: e.changeId });
      return;
    }
    e.approvedLane = Math.max(e.approvedLane, ev.lane) as Lane;
    e.approvalRequired = false;
    this.audit("merge-queue.approved", `change:${e.changeId}`, { approver: pid, lane: ev.lane }, pid);
  }

  // ---------------------------------------------------------------- flakes (§4.7)

  private quarantineTest(test: string, b: Batch, mainSha: string): void {
    if (this.s.quarantine[test] !== undefined || b.treeSha === null) return;
    this.s.quarantine[test] = { test, at: this.now, batchId: b.id, treeSha: b.treeSha, mainSha };
    const refs = [`batch:${b.id}`, ...(b.verdict?.runIds ?? []).map((r) => `ci-run:${r}`)];
    this.audit("merge-queue.test-quarantined", `test:${test}`.slice(0, 200), {
      test,
      status: "suspected-flaky",
      batchId: b.id,
      treeSha: b.treeSha,
      mainSha,
      runIds: b.verdict?.runIds ?? [],
    });
    this.out.push({ type: "OpenPlan", kind: "fix-flaky-test", test, title: `Fix flaky test ${test}`.slice(0, 200), evidenceRefs: refs });
    for (const e of Object.values(this.s.entries)) if (!isTerminal(e)) this.applyQuarantineTo(e);
  }

  /** An entry whose affected set includes a quarantined test is at least Lane 1. */
  private applyQuarantineTo(e: QueueEntry): void {
    const hit = this.relevantQuarantine([e.changeId]);
    if (hit.length === 0) return;
    const raised = this.raiseLane(e, 1, [
      {
        code: "merge-queue.quarantined-test",
        lane: 1,
        message: `Quarantined test(s) in this Change's affected set do not count as passing: ${hit.slice(0, 5).join(", ")}.`,
      },
    ]);
    if (raised && e.approvalRequired && e.batchId !== null && !this.inCas(e.changeId)) this.removeFromFlight(e);
  }

  private relevantQuarantine(changeIds: string[]): string[] {
    const q = Object.keys(this.s.quarantine);
    if (q.length === 0) return [];
    const out = new Set<string>();
    for (const id of changeIds) {
      const a = this.entry(id)?.affected ?? null;
      if (a === null || needsAllTests(a)) {
        for (const t of q) out.add(t);
        continue;
      }
      const tests = new Set(a.testTargets);
      for (const t of q) if (tests.has(t)) out.add(t);
    }
    return [...out];
  }

  private onUnquarantined(ev: CoreEventOf<"Unquarantined">): void {
    if (this.s.quarantine[ev.test] === undefined) return;
    delete this.s.quarantine[ev.test];
    this.audit("merge-queue.test-unquarantined", `test:${ev.test}`.slice(0, 200), { by: ev.by });
  }

  // ---------------------------------------------------------------- CAS and landing (§4.2)

  private onCasResult(ev: CoreEventOf<"CasResult">): void {
    const cas = this.s.cas;
    if (cas === null || cas.casId !== ev.casId) return;
    this.s.cas = null;
    const b = this.batch(cas.batchId);
    invariant(b !== undefined, "cas.batch", `CAS ${cas.casId} for unknown batch ${cas.batchId}`);
    if (ev.result !== "ok") {
      b.state = "passed";
      this.audit(`merge-queue.cas-${ev.result}`, `batch:${b.id}`, { casId: cas.casId, expectedOld: cas.expectedOld, actual: ev.actualSha, detail: ev.detail });
      if (ev.result === "stale" && ev.actualSha !== null && ev.actualSha !== this.s.main.sha) this.onExternalMain(ev.actualSha);
      else if (ev.result === "rejected") this.s.casRetryAt = this.now + 30_000;
      for (const id of cas.entries) {
        const e = this.entry(id);
        if (e?.dequeueRequested === true) {
          this.removeFromFlight(e);
          this.terminate(e, "dequeued", null);
        }
      }
      return;
    }
    this.s.casRetryAt = null;
    const changes = cas.entries.map((id) => {
      const e = this.entry(id);
      return { changeId: id, affected: e?.affected ?? null, revertOf: e?.revertOf ?? null };
    });
    this.s.main = { sha: cas.newSha, seq: this.s.main.seq + 1 };
    this.s.mainLog.push({ seq: this.s.main.seq, sha: cas.newSha, parentSha: cas.expectedOld, changes, at: this.now, kind: "cas" });
    if (this.s.mainLog.length > this.cfg.mainLogLimit) this.s.mainLog = this.s.mainLog.slice(this.s.mainLog.length - this.cfg.mainLogLimit);
    const landed =
      b.kind === "landing" ? [b, ...b.members.map((m) => this.batch(m)).filter((x): x is Batch => x !== undefined)] : [b];
    for (const lb of landed) {
      this.finishBatch(lb, "landed");
      this.removeFromTrack(lb);
    }
    if (b.kind === "landing") this.s.landing = this.s.landing.filter((x) => x !== b.id);
    const reverts: string[] = [];
    for (const id of cas.entries) {
      const e = this.entry(id);
      if (e === undefined) continue;
      this.merge(e, cas.newSha, cas.treeSha, cas.casId);
      if (e.revertOf !== null) reverts.push(e.changeId);
    }
    if (reverts.length > 0) this.onRevertLanded(reverts);
  }

  private merge(e: QueueEntry, sha: string, treeSha: string, casId: string): void {
    const waitMs = Math.max(0, this.now - e.enqueuedAt);
    e.state = "merged";
    e.mergedSha = sha;
    e.batchId = null;
    e.trackId = null;
    e.terminalAt = this.now;
    this.s.terminal.push(e.changeId);
    this.s.stats.merged++;
    this.s.stats.recentMerged.push({ changeId: e.changeId, at: this.now, waitMs });
    if (this.s.stats.recentMerged.length > 500) this.s.stats.recentMerged.shift();
    this.authorOutcome(e, true);
    for (const o of Object.values(this.s.entries))
      if (!isTerminal(o) && o.dependsOn.includes(e.changeId)) o.dependsOn = o.dependsOn.filter((d) => d !== e.changeId);
    this.emit({
      type: "merged",
      at: this.now,
      changeId: e.changeId,
      mergedSha: sha,
      treeSha,
      casId,
      timeInQueueMs: waitMs,
      lane: e.lane,
      deploysTo: e.affected?.deploysTo ?? [],
      flagKey: e.flagKey,
      files: e.affected?.files ?? [],
      modules: e.affected?.modules ?? [],
    });
    this.audit("change.merged", `change:${e.changeId}`, {
      mergedSha: sha,
      treeSha,
      casId,
      lane: e.lane,
      laneReasons: e.laneReasons.map((r) => r.code),
      timeInQueueMs: waitMs,
    });
    this.telemetry("outcome", { changeId: e.changeId, outcome: "merged", predicted: e.prediction?.p ?? null, factors: e.prediction?.factors ?? {} });
  }

  private authorOutcome(e: QueueEntry, passed: boolean): void {
    const a = this.s.stats.authors[e.authorId] ?? { passed: 0, failed: 0 };
    if (passed) a.passed++;
    else a.failed++;
    this.s.stats.authors[e.authorId] = a;
  }

  private onExternalMain(sha: string): void {
    if (sha === this.s.main.sha) return;
    this.audit("merge-queue.main-moved-externally", "repo:main", { from: this.s.main.sha, to: sha });
    this.s.main = { sha, seq: this.s.main.seq + 1 };
    this.s.mainLog.push({
      seq: this.s.main.seq,
      sha,
      parentSha: null,
      // Unknown content conflicts with everything: every stale batch re-runs in full.
      changes: [{ changeId: `external:${sha}`, affected: null, revertOf: null }],
      at: this.now,
      kind: "external",
    });
    if (this.s.landing.length > 0) this.invalidateLanding(0, "main moved externally");
  }

  private landedSeqOf(changeId: string): number | null {
    for (const m of this.s.mainLog) if (m.changes.some((c) => c.changeId === changeId)) return m.seq;
    return null;
  }

  private inCas(changeId: string): boolean {
    return this.s.cas !== null && this.s.cas.entries.includes(changeId);
  }

  private batchInCas(b: Batch): boolean {
    const cas = this.s.cas;
    if (cas === null) return false;
    if (cas.batchId === b.id) return true;
    return this.batch(cas.batchId)?.members.includes(b.id) === true;
  }

  /** Every queue entry of b's tree below its own entries has landed (or is in `ahead`). */
  private lineageLanded(b: Batch, ahead: ReadonlySet<string> = new Set()): boolean {
    const own = new Set(ownEntries(b));
    for (const id of b.lineage) {
      if (own.has(id) || ahead.has(id)) continue;
      const e = this.entry(id);
      if (e !== undefined && e.state !== "merged") return false;
    }
    return true;
  }

  /**
   * Can b's full-run result carry over to b's own entries rebased onto main (+ `ahead`)? Only if
   * everything that landed since b was rooted (and isn't in b's tree) has a known affected set
   * disjoint from each of b's own entries. Returns the changes the result is carried across, or null.
   */
  /** The change that prevents carrying b's result over (for audits), or null. */
  private carryBlocker(b: Batch, ahead: { changeId: string; affected: AffectedSet | null }[]): string | null {
    const first = this.s.mainLog[0];
    if (first === undefined || b.rootSeq < first.seq) return "(history forgotten)";
    const lineage = new Set(b.lineage);
    const own = ownEntries(b).map((id) => this.entry(id)?.affected ?? null);
    const check = (c: { changeId: string; affected: AffectedSet | null }) => !lineage.has(c.changeId) && own.some((o) => conflicts(c.affected, o));
    for (const m of this.s.mainLog) if (m.seq > b.rootSeq) for (const c of m.changes) if (check(c)) return c.changeId;
    for (const c of ahead) if (check(c)) return c.changeId;
    return null;
  }

  private carryOver(b: Batch, ahead: { changeId: string; affected: AffectedSet | null }[]): string[] | null {
    const first = this.s.mainLog[0];
    if (first === undefined || b.rootSeq < first.seq) return null; // history forgotten → unknown
    const lineage = new Set(b.lineage);
    const delta: { changeId: string; affected: AffectedSet | null }[] = [];
    for (const m of this.s.mainLog) {
      if (m.seq <= b.rootSeq) continue;
      for (const c of m.changes) if (!lineage.has(c.changeId)) delta.push(c);
    }
    for (const c of ahead) if (!lineage.has(c.changeId)) delta.push(c);
    const own = ownEntries(b).map((id) => this.entry(id)?.affected ?? null);
    for (const d of delta) for (const o of own) if (conflicts(d.affected, o)) return null;
    return delta.map((d) => d.changeId);
  }

  private landAllowed(entries: string[]): boolean {
    if (!isFrozen(this.s)) return true;
    return entries.every((id) => {
      const e = this.entry(id);
      return e !== undefined && isExpress(e);
    });
  }

  private landingEntriesOf(b: Batch): string[] {
    if (b.kind !== "landing") return ownEntries(b);
    const out: string[] = [];
    for (const m of b.members) {
      const mb = this.batch(m);
      if (mb !== undefined) out.push(...ownEntries(mb));
    }
    return out;
  }

  private readyChainBatches(): Batch[] {
    return this.activeChain()
      .filter((b) => b.state === "passed")
      .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  private advanceLanding(): boolean {
    const s = this.s;
    if (s.cas !== null) return false;
    if (s.casRetryAt !== null && this.now < s.casRetryAt) return false;
    let changed = false;
    const head = this.batch(s.landing[0] ?? null);
    if (head !== undefined) {
      if (head.state === "passed") {
        if (head.baseSha !== s.main.sha) {
          this.invalidateLanding(0, "main moved under the landing batch");
          return true;
        }
        if (this.landAllowed(this.landingEntriesOf(head))) {
          this.emitCas(head);
          return true;
        }
      }
    } else {
      for (const b of this.readyChainBatches()) {
        if (b.baseSha === s.main.sha && this.lineageLanded(b) && this.landAllowed(ownEntries(b))) {
          this.emitCas(b);
          return true;
        }
      }
    }
    // Stale passed batches: revalidate (impacted targets) or fall back to a full run.
    const inLanding = new Set<string>();
    const ahead: { changeId: string; affected: AffectedSet | null }[] = [];
    for (const lid of s.landing) {
      const l = this.batch(lid);
      for (const m of l?.members ?? []) {
        inLanding.add(m);
        const mb = this.batch(m);
        for (const id of mb === undefined ? [] : ownEntries(mb)) ahead.push({ changeId: id, affected: this.entry(id)?.affected ?? null });
      }
    }
    const members: Batch[] = [];
    const aheadIds = new Set(ahead.map((a) => a.changeId));
    for (const b of this.readyChainBatches()) {
      if (inLanding.has(b.id)) continue;
      if (s.landing.length === 0 && members.length === 0 && b.baseSha === s.main.sha) continue; // direct path
      const own = ownEntries(b);
      if (!this.landAllowed(own)) continue;
      if (!this.cfg.features.revalidation || b.noRevalidate) {
        if (this.lineageLanded(b)) {
          this.fallback(b, b.noRevalidate ? "revalidation failed" : "revalidation off");
          changed = true;
        }
        continue;
      }
      if (s.landing.length >= this.cfg.maxLandingDepth) continue;
      if (!this.lineageLanded(b, aheadIds)) continue;
      if (members.length >= this.cfg.maxLandingMembers) {
        // Close this landing batch and open the next one on top of it.
        this.createLandingBatch(members);
        changed = true;
        members.length = 0;
        if (s.landing.length >= this.cfg.maxLandingDepth) continue;
      }
      const carried = this.carryOver(b, ahead);
      if (carried === null) {
        if (this.lineageLanded(b)) {
          this.fallback(b, `not disjoint from ${this.carryBlocker(b, ahead)}`);
          changed = true;
        }
        continue;
      }
      members.push(b);
      for (const id of own) {
        ahead.push({ changeId: id, affected: this.entry(id)?.affected ?? null });
        aheadIds.add(id);
      }
    }
    if (members.length > 0) {
      this.createLandingBatch(members);
      changed = true;
    }
    return changed;
  }

  private createLandingBatch(members: Batch[]): void {
    const id = this.id("l");
    const parentId = this.s.landing[this.s.landing.length - 1] ?? null;
    const own = members.flatMap((m) => ownEntries(m));
    const affected = unionAffected(own.map((x) => this.entry(x)?.affected ?? null));
    const targets: TestScope = needsAllTests(affected) ? "all" : [...new Set(affected.testTargets)].sort();
    this.s.batches[id] = {
      id,
      kind: "landing",
      trackId: null,
      parentId,
      mergeParents: [],
      carried: [],
      rootBase: this.s.main.sha,
      rootSeq: this.s.main.seq,
      baseSha: null,
      units: members.flatMap((m) => m.units),
      lineage: own,
      state: "pending",
      tipSha: null,
      treeSha: null,
      commits: [],
      refName: `refs/queue/${id}`,
      runId: null,
      runSeq: 0,
      startedAt: null,
      targets,
      verdict: null,
      recheck: null,
      bisect: null,
      probe: null,
      members: members.map((m) => m.id),
      fallbackOf: null,
      noRevalidate: false,
      createdAt: this.now,
      readyAt: null,
      infraRetries: 0,
    };
    for (const m of members) m.state = "landing";
    this.s.landing.push(id);
  }

  /** Replace a stale passed batch (all ancestors landed) by a full run of its units on current main. */
  private fallback(b: Batch, reason: string): void {
    invariant(this.isActiveChain(b), "fallback.track", `fallback of ${b.id} outside the DAG`);
    const t = this.s.tracks[b.trackId ?? ""];
    const id = this.id("b");
    this.s.batches[id] = {
      ...b,
      id,
      parentId: null,
      mergeParents: [],
      carried: [],
      rootBase: this.s.main.sha,
      rootSeq: this.s.main.seq,
      baseSha: this.s.main.sha,
      lineage: ownEntries(b),
      state: "pending",
      tipSha: null,
      treeSha: null,
      commits: [],
      refName: `refs/queue/${id}`,
      runId: null,
      runSeq: 0,
      startedAt: null,
      targets: "all",
      verdict: null,
      recheck: null,
      bisect: null,
      probe: null,
      members: [],
      fallbackOf: b.id,
      noRevalidate: false,
      createdAt: this.now,
      readyAt: null,
      infraRetries: 0,
    };
    if (t !== undefined) t.chain = t.chain.map((x) => (x === b.id ? id : x));
    for (const cid of ownEntries(b)) {
      const e = this.entry(cid);
      if (e !== undefined && e.batchId === b.id) {
        e.batchId = id;
        e.state = "speculating";
      }
    }
    this.finishBatch(b, "cancelled");
    this.audit("merge-queue.full-run-fallback", `batch:${id}`, {
      of: b.id,
      entries: ownEntries(b),
      reason,
      ofRootSeq: b.rootSeq,
      ofFallbackOf: b.fallbackOf,
      ofParent: b.parentId,
      ofCarried: b.carried.length,
      mainSeq: this.s.main.seq,
    });
  }

  private onLandingFailure(l: Batch): void {
    const i = this.s.landing.indexOf(l.id);
    // A hidden interaction between components: every member re-runs in full on main.
    for (const m of l.members) {
      const mb = this.batch(m);
      if (mb !== undefined) mb.noRevalidate = true;
    }
    this.finishBatch(l, "failed");
    if (i >= 0) this.invalidateLanding(i, "revalidation failed");
  }

  private invalidateLanding(from: number, why: string): void {
    let start = from;
    const cas = this.s.cas;
    if (cas !== null) {
      const ci = this.s.landing.indexOf(cas.batchId);
      if (ci >= start) start = ci + 1;
    }
    const removed = this.s.landing.slice(start);
    this.s.landing = this.s.landing.slice(0, start);
    for (const lid of removed) {
      const l = this.batch(lid);
      if (l === undefined) continue;
      this.cancelBatch(l, why); // no-op if already failed
      for (const m of l.members) {
        const mb = this.batch(m);
        if (mb !== undefined && mb.state === "landing") mb.state = "passed";
      }
    }
  }

  /** The single choke point for advancing main. Asserts every §1 invariant; never trusts callers. */
  private emitCas(b: Batch): void {
    const s = this.s;
    const v = b.verdict;
    invariant(s.cas === null, "cas.concurrent", "a CAS is already in flight");
    invariant(b.tipSha !== null && b.treeSha !== null, "cas.unbuilt", `batch ${b.id} has no tree`);
    invariant(v !== null && v.passed, "cas.untested", `batch ${b.id} has no passing verdict`, { batch: b.id });
    invariant(v.failing.length === 0, "cas.failing", `batch ${b.id} has failing checks`, { failing: v.failing });
    invariant(v.treeSha === b.treeSha && v.commitSha === b.tipSha, "cas.tree-mismatch", `verdict of ${b.id} is for tree ${v.treeSha}, not ${b.treeSha}`);
    invariant(b.baseSha === s.main.sha && v.baseSha === s.main.sha, "cas.stale-base", `batch ${b.id} is not built on main`);
    const entries = this.landingEntriesOf(b);
    invariant(new Set(entries).size === entries.length, "cas.duplicate", `batch ${b.id} lists an entry twice`);
    const carried: CasEvidence["carried"] = [];
    if (b.kind === "chain") {
      invariant(v.scope === "all", "cas.scope", `direct land of ${b.id} needs a full run`);
      invariant(b.carried.every((id) => this.entry(id)?.state === "merged"), "cas.carried", `${b.id} carries unlanded entries`);
      invariant(this.lineageLanded(b), "cas.ancestors", `ancestors of ${b.id} have not landed`);
    } else {
      invariant(b.kind === "landing", "cas.kind", `cannot land a ${b.kind} batch`);
      const ahead: { changeId: string; affected: AffectedSet | null }[] = [];
      const aheadIds = new Set<string>();
      const needed = new Set<string>();
      let all = false;
      for (const mid of b.members) {
        const m = this.batch(mid);
        invariant(m !== undefined, "cas.member", `landing ${b.id} lost member ${mid}`);
        const mv = m.verdict;
        invariant(
          mv !== null && mv.passed && mv.scope === "all" && mv.treeSha === m.treeSha && mv.failing.length === 0,
          "cas.member-untested",
          `member ${mid} of ${b.id} has no full passing run`,
        );
        invariant(this.lineageLanded(m, aheadIds), "cas.ancestors", `ancestors of ${mid} have not landed`);
        const across = this.carryOver(m, ahead);
        invariant(across !== null, "cas.not-disjoint", `member ${mid} is not disjoint from what landed since`);
        carried.push({ batchId: mid, verdict: mv, disjointFrom: across });
        for (const id of ownEntries(m)) {
          const a = this.entry(id)?.affected ?? null;
          ahead.push({ changeId: id, affected: a });
          aheadIds.add(id);
          if (a === null || needsAllTests(a)) all = true;
          else for (const t of a.testTargets) needed.add(t);
        }
      }
      const scope = v.scope;
      invariant(
        scope === "all" || (!all && [...needed].every((t) => scope.includes(t))),
        "cas.revalidation-scope",
        `revalidation of ${b.id} did not cover every impacted target`,
      );
    }
    const laneRaises: LaneRaise[] = [];
    const quarantined = this.relevantQuarantine(entries);
    for (const q of v.quarantined) if (!quarantined.includes(q)) quarantined.push(q);
    const position = new Map(entries.map((id, i) => [id, i]));
    for (const id of entries) {
      const e = this.entry(id);
      invariant(e !== undefined && !isTerminal(e), "cas.entry", `entry ${id} is gone or terminal`);
      invariant(e.state === "passed", "cas.entry-state", `entry ${id} is ${e.state}`);
      invariant(e.lane <= e.approvedLane && !e.approvalRequired, "cas.approval", `entry ${id} needs approval`);
      invariant(this.landAllowed([id]), "cas.frozen", `queue is frozen; ${id} is not a revert/incident fix`);
      for (const d of e.dependsOn) {
        if (this.entry(d)?.state === "merged") continue;
        const dp = position.get(d);
        invariant(dp !== undefined && dp < (position.get(id) ?? 0), "cas.stack-order", `${id} depends on ${d}, which neither landed nor precedes it`);
      }
      if (e.landTogether && e.plangroup !== null) {
        const group = Object.values(s.entries).filter((o) => o.plangroup === e.plangroup && o.landTogether && !isTerminal(o));
        invariant(group.every((o) => position.has(o.changeId)), "cas.plangroup", `plan group ${e.plangroup} would land partially`);
        invariant(e.groupSize === null || group.length >= e.groupSize, "cas.plangroup-size", `plan group ${e.plangroup} has ${group.length}/${e.groupSize} members`);
      }
      const hit = this.relevantQuarantine([id]);
      if (hit.length > 0) {
        invariant(e.lane >= 1, "cas.quarantine-lane", `${id} has quarantined tests in its affected set but is Lane 0`);
        laneRaises.push({ changeId: id, lane: e.lane, reasons: e.laneReasons });
      } else if (e.laneReasons.length > 0) {
        laneRaises.push({ changeId: id, lane: e.lane, reasons: e.laneReasons });
      }
    }
    const casId = this.id("c");
    s.cas = { casId, batchId: b.id, expectedOld: s.main.sha, newSha: b.tipSha, treeSha: b.treeSha, entries, issuedAt: this.now };
    b.state = "landing";
    this.out.push({
      type: "Cas",
      casId,
      expectedOld: s.main.sha,
      newSha: b.tipSha,
      treeSha: b.treeSha,
      entries: entries.map((id) => {
        const e = this.entry(id);
        return { changeId: id, headSha: e?.headSha ?? "", lane: e?.lane ?? 2 };
      }),
      evidence: { verdict: v, carried, quarantined, laneRaises },
    });
  }

  // ---------------------------------------------------------------- freezes (§4.9)

  private addFreezeReason(r: FreezeReason): void {
    const was = isFrozen(this.s);
    this.s.freeze.reasons = [...this.s.freeze.reasons, r];
    this.audit(
      was ? "merge-queue.freeze-reason-added" : "merge-queue.frozen",
      "repo:merge-queue",
      { kind: r.kind, sha: r.sha, changeId: r.changeId, message: r.message },
      r.signer?.principalId ?? SYSTEM_PRINCIPAL,
      r.signer?.signature ?? null,
    );
    if (!was) this.emit({ type: "frozen", at: this.now, reason: r });
  }

  private markBad(seq: number): void {
    this.s.freeze.badSeq = this.s.freeze.badSeq === null ? seq : Math.min(this.s.freeze.badSeq, seq);
  }

  private onPostMergeFailed(ev: CoreEventOf<"PostMergeCheckFailed">): void {
    const seq = this.s.mainLog.find((m) => m.sha === ev.sha)?.seq ?? this.s.main.seq;
    this.markBad(seq);
    this.addFreezeReason({
      kind: "post-merge-check",
      at: this.now,
      sha: ev.sha,
      changeId: null,
      signer: null,
      message: `post-merge checks failed on ${ev.sha.slice(0, 12)}: ${ev.checks.slice(0, 10).join(", ")}`,
    });
  }

  private onRevertLanded(revertIds: string[]): void {
    const ids = new Set(revertIds);
    const before = this.s.freeze.reasons;
    if (before.length === 0 && this.s.freeze.badSeq === null) return;
    const after = before.filter(
      (r) => !(r.kind === "post-merge-check" || (r.kind === "revert-in-progress" && r.changeId !== null && ids.has(r.changeId))),
    );
    const stillReverting = after.some((r) => r.kind === "revert-in-progress");
    let invalidated = 0;
    if (!stillReverting && this.s.freeze.badSeq !== null) {
      invalidated = this.invalidateBuiltOnBadMain(this.s.freeze.badSeq, ids);
      this.s.freeze.badSeq = null;
    }
    this.s.freeze.reasons = after;
    if (before.length > 0 && after.length === 0) {
      this.audit("merge-queue.thawed", "repo:merge-queue", { by: "revert", reverts: revertIds, invalidated });
      this.emit({ type: "thawed", at: this.now, by: `revert:${revertIds.join(",")}`, invalidatedBatches: invalidated });
    }
  }

  /** Every speculative batch built on the bad main (and not on top of the revert) is invalid. */
  private invalidateBuiltOnBadMain(badSeq: number, reverts: ReadonlySet<string>): number {
    let n = 0;
    for (const b of this.activeChain()) {
      if (!this.isActiveChain(b) || this.batchInCas(b)) continue;
      if (b.rootSeq < badSeq || b.lineage.some((x) => reverts.has(x))) continue;
      const desc = this.descendantsOf(b);
      if (desc.some((d) => this.batchInCas(d))) continue;
      n += 1 + desc.length;
      this.cancelTree(b, "built on a main that was reverted");
    }
    for (const b of Object.values(this.s.batches))
      if (b.state === "bisecting" && b.rootSeq >= badSeq) {
        this.abortBisection(b, "built on a main that was reverted");
        n++;
      }
    if (this.s.landing.length > 0) this.invalidateLanding(0, "thaw");
    return n;
  }

  private onFreeze(ev: CoreEventOf<"Freeze">): void {
    if (ev.signer.kind !== "human") {
      this.reject("Freeze", "manual freezes are human-signed", { by: ev.signer.principalId });
      return;
    }
    this.addFreezeReason({
      kind: "manual",
      at: this.now,
      sha: this.s.main.sha,
      changeId: null,
      signer: { principalId: ev.signer.principalId, signature: ev.signer.signature },
      message: ev.reason,
    });
  }

  private onThaw(ev: CoreEventOf<"Thaw">): void {
    if (ev.signer.kind !== "human") {
      this.reject("Thaw", "manual thaws are human-signed", { by: ev.signer.principalId });
      return;
    }
    if (!isFrozen(this.s)) return;
    this.s.freeze = { reasons: [], badSeq: null };
    this.audit("merge-queue.thawed", "repo:merge-queue", { by: ev.signer.principalId, reason: ev.reason, manual: true }, ev.signer.principalId, ev.signer.signature);
    this.emit({ type: "thawed", at: this.now, by: ev.signer.principalId, invalidatedBatches: 0 });
  }

  private isExpressBatch(b: Batch): boolean {
    return ownEntries(b).every((id) => {
      const e = this.entry(id);
      return e !== undefined && isExpress(e);
    });
  }

  /**
   * While frozen only reverts/incident fixes land, so they must never sit behind (or in a batch
   * with) anything else: such batches are cancelled and their express entries re-placed on main.
   */
  private ensureExpressRouting(): boolean {
    let changed = false;
    for (const b of this.activeChain()) {
      if (!this.isActiveChain(b) || this.batchInCas(b)) continue;
      const ids = ownEntries(b);
      const hasExpress = ids.some((id) => {
        const e = this.entry(id);
        return e !== undefined && isExpress(e);
      });
      if (!hasExpress) continue;
      const stuck =
        !this.isExpressBatch(b) ||
        this.ancestorsOf(b).some((a) => !this.isExpressBatch(a)) ||
        b.carried.some((id) => {
          const e = this.entry(id);
          return e !== undefined && !isExpress(e) && e.state !== "merged";
        });
      if (!stuck || this.descendantsOf(b).some((d) => this.batchInCas(d))) continue;
      this.cancelTree(b, "frozen: revert/incident fixes go first");
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- tick

  private onTick(): void {
    const s = this.s;
    for (const e of Object.values(s.entries)) {
      if (e.state !== "waiting" || e.affected !== null || e.affectedRequestedAt === null) continue;
      if (this.now - e.affectedRequestedAt >= this.cfg.affectedSetTimeoutMs) {
        e.affected = unknownAffectedSet();
        this.audit("merge-queue.affected-set-timeout", `change:${e.changeId}`, { waitedMs: this.now - e.affectedRequestedAt });
        this.applyQuarantineTo(e);
      }
    }
    for (const b of Object.values(s.batches)) {
      if ((b.state === "running" || b.state === "rechecking" || b.state === "building") && b.startedAt !== null) {
        if (this.now - b.startedAt < this.cfg.runTimeoutMs) continue;
        if (b.runId !== null && b.state !== "building") this.out.push({ type: "CancelBatchRun", batchId: b.id, runId: b.runId, reason: "timed out" });
        if (b.state === "rechecking") b.recheck = null;
        this.infraRetry(b, "timed out", b.state === "building" ? "pending" : "ready");
      }
    }
  }

  // ---------------------------------------------------------------- removal helpers

  private toWaiting(e: QueueEntry): void {
    e.state = "waiting";
    e.batchId = null;
    e.trackId = null;
  }

  private returnUnits(b: Batch): void {
    for (const id of ownEntries(b)) {
      const e = this.entry(id);
      if (e !== undefined && !isTerminal(e) && e.batchId === b.id) this.toWaiting(e);
    }
  }

  /** Terminal transition of a batch (releases its `refs/queue/*` ref exactly once). */
  private finishBatch(b: Batch, state: "landed" | "cancelled" | "failed"): void {
    if (batchDone(b) && b.kind !== "probe") return;
    if (b.kind !== "probe" && b.state !== "pending") this.out.push({ type: "DeleteQueueRef", refName: b.refName });
    b.state = state;
  }

  private cancelBatch(b: Batch, reason: string): void {
    if (batchDone(b)) return;
    if ((b.state === "running" || b.state === "rechecking") && b.runId !== null)
      this.out.push({ type: "CancelBatchRun", batchId: b.id, runId: b.runId, reason });
    for (const pid of b.bisect?.probeIds ?? []) {
      const p = this.batch(pid);
      if (p !== undefined && !batchDone(p)) this.cancelBatch(p, reason);
    }
    if (b.kind === "probe") {
      b.state = "cancelled";
      return;
    }
    this.finishBatch(b, "cancelled");
  }

  /** Take an entry out of whatever batch holds it; its batch-mates and descendants re-form. */
  private removeFromFlight(e: QueueEntry): void {
    const b = this.batch(e.batchId);
    if (b === undefined) {
      if (e.state === "speculating" || e.state === "passed") this.toWaiting(e);
      return;
    }
    invariant(!this.batchInCas(b), "remove.in-cas", `cannot pull ${e.changeId}: CAS in flight`);
    if (b.state === "bisecting") this.abortBisection(b, `${e.changeId} left the batch`);
    else if (this.isActiveChain(b)) this.cancelTree(b, `${e.changeId} left the batch`);
    else {
      this.cancelBatch(b, `${e.changeId} left the batch`);
      this.returnUnits(b);
    }
    if (e.batchId !== null) this.toWaiting(e);
  }

  /** Terminal transition + cascades (stack dependents, land-together group members). */
  private terminate(e: QueueEntry, state: "ejected" | "dequeued", reason: EjectInput | null, by = SYSTEM_PRINCIPAL, cascade = true): void {
    if (isTerminal(e)) return;
    invariant(e.batchId === null, "terminate.in-batch", `${e.changeId} must leave its batch first`);
    e.state = state;
    e.trackId = null;
    e.terminalAt = this.now;
    e.hold = null;
    this.s.terminal.push(e.changeId);
    if (state === "ejected" && reason !== null) {
      const r = ejectReason(reason);
      e.ejectReason = r;
      this.s.stats.ejected++;
      this.emit({ type: "ejected", at: this.now, changeId: e.changeId, reason: r });
      this.audit("merge-queue.ejected", `change:${e.changeId}`, { code: r.code, message: r.message, upstream: r.upstream, failingTests: r.failingTests });
      this.telemetry("outcome", { changeId: e.changeId, outcome: `ejected:${r.code}`, predicted: e.prediction?.p ?? null, factors: e.prediction?.factors ?? {} });
    } else {
      this.audit("merge-queue.dequeued", `change:${e.changeId}`, { by }, by);
    }
    if (!cascade) return;
    for (const o of Object.values(this.s.entries)) {
      if (isTerminal(o) || o.changeId === e.changeId) continue;
      const dependent = o.dependsOn.includes(e.changeId);
      const sibling = e.landTogether && o.landTogether && o.plangroup !== null && o.plangroup === e.plangroup;
      if (!dependent && !sibling) continue;
      if (this.inCas(o.changeId)) continue;
      this.removeFromFlight(o);
      this.terminate(o, "ejected", {
        changeId: o.changeId,
        code: dependent ? "dependency-ejected" : "group-member-failed",
        message: dependent
          ? `depends on ${e.changeId}, which ${state === "dequeued" ? "was dequeued" : "was ejected"}`
          : `plan group ${o.plangroup} member ${e.changeId} ${state === "dequeued" ? "was dequeued" : "was ejected"}`,
        upstream: [e.changeId],
      });
    }
  }

  // ================================================================ scheduling (pump)

  pump(): void {
    for (let i = 0; i < 12; i++) {
      let changed = false;
      if (isFrozen(this.s)) changed = this.ensureExpressRouting() || changed;
      changed = this.advanceLanding() || changed;
      changed = this.formBatches() || changed;
      changed = this.issueBuilds() || changed;
      changed = this.startRuns() || changed;
      if (!changed) return;
    }
  }

  private issueBuilds(): boolean {
    let changed = false;
    const pending = Object.values(this.s.batches)
      .filter((b) => b.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    for (const b of pending) {
      let base: string | null;
      if (b.kind === "chain" && b.parentId !== null && !this.holdExpired(b)) continue;
      if (b.kind === "chain") base = b.parentId === null ? b.rootBase : (this.batch(b.parentId)?.tipSha ?? null);
      else if (b.kind === "landing") base = b.parentId === null ? this.s.main.sha : (this.batch(b.parentId)?.tipSha ?? null);
      else continue;
      if (base === null) continue;
      b.baseSha = base;
      b.state = "building";
      b.startedAt = this.now;
      const entries = [...b.carried, ...ownEntries(b)].map((id) => ({ changeId: id, headSha: this.entry(id)?.headSha ?? "" }));
      this.out.push({ type: "BuildBatchTree", batchId: b.id, refName: b.refName, baseSha: base, entries });
      changed = true;
    }
    return changed;
  }

  /** A child batch builds once its hold expired or it is full (see `batchHoldMs`). */
  private holdExpired(b: Batch): boolean {
    const p = this.batch(b.parentId);
    if (p === undefined || !inFlight(p)) return true;
    if (ownEntries(b).length >= this.batchCapacity()) return true;
    const since = Math.max(b.createdAt, p.startedAt ?? b.createdAt);
    return this.now >= since + this.cfg.batchHoldMs;
  }

  private startRuns(): boolean {
    let running = 0;
    const ready: Batch[] = [];
    for (const b of Object.values(this.s.batches)) {
      if (b.state === "running" || b.state === "rechecking") running++;
      else if (b.state === "ready") ready.push(b);
    }
    if (ready.length === 0) return false;
    const kindOrder = { landing: 0, probe: 1, chain: 2 } as const;
    const depth = (b: Batch): number => b.lineage.length - ownEntries(b).length;
    ready.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || depth(a) - depth(b) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    let changed = false;
    for (const b of ready) {
      if (running >= this.cfg.maxConcurrentRuns) break;
      invariant(b.tipSha !== null && b.treeSha !== null && b.baseSha !== null, "run.unbuilt", `run of unbuilt ${b.id}`);
      b.runSeq++;
      b.runId = `${b.id}-r${b.runSeq}`;
      b.state = "running";
      b.startedAt = this.now;
      running++;
      changed = true;
      this.out.push({
        type: "StartBatchRun",
        batchId: b.id,
        runId: b.runId,
        kind: b.kind,
        refName: b.refName,
        baseSha: b.baseSha,
        commitSha: b.tipSha,
        treeSha: b.treeSha,
        entries: ownEntries(b),
        targets: b.targets,
      });
    }
    return changed;
  }

  /**
   * Place waiting entries in the speculation DAG (§4.2, §4.3, §4.5, §4.6).
   *
   * Units (an entry, an atomic stack, a land-together plan group) are visited in priority order
   * (rank with aging → fair-queuing tag → arrival). Each unit goes on top of the active batches it
   * conflicts with (its frontier): into an unbuilt batch that already covers that frontier, on the
   * tip of its single predecessor, or into a merge batch rebuilt on main. Backpressure: speculation
   * depth (untested ancestors) and the in-flight cap; a unit that can't be placed blocks every
   * later unit it conflicts with (priority order between conflicting units is preserved).
   */
  private formBatches(): boolean {
    const s = this.s;
    const cfg = this.cfg;
    const frozen = isFrozen(s);
    let changed = false;
    const groups = new Map<string, QueueEntry[]>();
    for (const e of Object.values(s.entries)) {
      if (!e.landTogether || e.plangroup === null) continue;
      const g = groups.get(e.plangroup) ?? [];
      g.push(e);
      groups.set(e.plangroup, g);
    }
    // A dependency (or land-together sibling) that left the queue without merging takes its
    // dependents with it.
    for (const e of Object.values(s.entries)) {
      if (e.state !== "waiting") continue;
      const dead = e.dependsOn.find((d) => {
        const de = this.entry(d);
        return de !== undefined && (de.state === "ejected" || de.state === "dequeued");
      });
      if (dead !== undefined) {
        this.terminate(e, "ejected", { changeId: e.changeId, code: "dependency-ejected", message: `depends on ${dead}, which left the queue`, upstream: [dead] });
        changed = true;
        continue;
      }
      if (e.landTogether && e.plangroup !== null) {
        const gone = (groups.get(e.plangroup) ?? []).find((o) => o.state === "ejected" || o.state === "dequeued");
        if (gone !== undefined) {
          this.terminate(e, "ejected", {
            changeId: e.changeId,
            code: "group-member-failed",
            message: `plan group ${e.plangroup} member ${gone.changeId} left the queue; nothing in the group lands`,
            upstream: [gone.changeId],
          });
          changed = true;
        }
      }
    }
    const waiting = Object.values(s.entries).filter((e) => e.state === "waiting");
    if (waiting.length === 0) return changed;

    // ---- holds
    const ready = new Map<string, QueueEntry>();
    for (const e of waiting) {
      e.hold = null;
      if (e.waitFor.length > 0) {
        e.waitFor = e.waitFor.filter((id) => {
          const w = this.entry(id);
          return w !== undefined && !isTerminal(w);
        });
      }
      if (e.affected === null) e.hold = "affected";
      else if (e.approvalRequired || e.lane > e.approvedLane) e.hold = "approval";
      else if (e.waitFor.length > 0) e.hold = "dependency";
      if (e.hold === null) ready.set(e.changeId, e);
    }
    let progress = true;
    while (progress) {
      progress = false;
      for (const e of [...ready.values()]) {
        for (const d of e.dependsOn) {
          const de = this.entry(d);
          if (de !== undefined && (ready.has(d) || this.inChain(de) || de.state === "merged")) continue;
          e.hold = "dependency";
          ready.delete(e.changeId);
          progress = true;
          break;
        }
      }
      for (const e of [...ready.values()]) {
        if (!e.landTogether || e.plangroup === null) continue;
        const group = (groups.get(e.plangroup) ?? []).filter((o) => !isTerminal(o));
        const complete = (e.groupSize === null || group.length >= e.groupSize) && group.every((o) => ready.has(o.changeId));
        if (complete) continue;
        for (const o of group)
          if (ready.delete(o.changeId)) {
            o.hold = "group";
            progress = true;
          }
        e.hold = "group";
      }
    }
    if (ready.size === 0) return changed;

    // ---- units: glue atomic stacks and land-together groups
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      for (let p = parent.get(r); p !== undefined && p !== r; p = parent.get(r)) r = p;
      return r;
    };
    const glue = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const e of ready.values()) parent.set(e.changeId, e.changeId);
    const groupFirst = new Map<string, string>();
    for (const e of ready.values()) {
      if (e.landMode === "atomic") for (const d of e.dependsOn) if (ready.has(d)) glue(e.changeId, d);
      if (e.landTogether && e.plangroup !== null) {
        const f = groupFirst.get(e.plangroup);
        if (f === undefined) groupFirst.set(e.plangroup, e.changeId);
        else glue(f, e.changeId);
      }
    }
    const byRoot = new Map<string, QueueEntry[]>();
    for (const e of ready.values()) {
      const r = find(e.changeId);
      const g = byRoot.get(r) ?? [];
      g.push(e);
      byRoot.set(r, g);
    }
    const units: PlannedUnit[] = [];
    for (const members of byRoot.values()) {
      const ordered = this.topoOrder(members);
      const ids = new Set(ordered.map((e) => e.changeId));
      const flows = new Map<string, number>();
      for (const e of ordered) flows.set(flowKey(e), (flows.get(flowKey(e)) ?? 0) + 1);
      let p = 1;
      for (const e of ordered) {
        e.prediction = this.predictionOf(e);
        p *= e.prediction.p;
      }
      units.push({
        changeIds: ordered.map((e) => e.changeId),
        entries: ordered,
        affected: unionAffected(ordered.map((e) => e.affected)),
        rank: Math.min(...ordered.map((e) => effectiveRank(e, this.now, cfg))),
        tag: Math.min(...ordered.map((e) => e.wfqTag)),
        seq: Math.min(...ordered.map((e) => e.seq)),
        express: ordered.every((e) => isExpress(e)),
        isolate: ordered.some((e) => e.isolate),
        p,
        deps: [...new Set(ordered.flatMap((e) => e.dependsOn).filter((d) => !ids.has(d)))],
        flows,
      });
    }
    units.sort((a, b) => (frozen ? Number(b.express) - Number(a.express) : 0) || compareOrder(a, b));

    // ---- frozen: express units go on main; conflicting normal batches are re-rooted behind them.
    if (frozen) {
      let cancelled = false;
      for (const u of units) {
        if (!u.express) continue;
        for (const b of this.activeChain()) {
          if (!this.isActiveChain(b) || this.isExpressBatch(b) || this.batchInCas(b)) continue;
          if (cfg.features.conflictGraph && !this.batchConflicts(b, u.affected)) continue;
          if (this.descendantsOf(b).some((d) => this.batchInCas(d))) continue;
          this.cancelTree(b, "frozen: making room for a revert/incident fix");
          cancelled = true;
        }
      }
      if (cancelled) return true; // the next pump pass re-plans with the re-rooted entries
    }

    // ---- placement
    const inFlightPerFlow = new Map<string, number>();
    if (cfg.features.fairness)
      for (const e of Object.values(s.entries))
        if (e.state === "speculating" || e.state === "passed") inFlightPerFlow.set(flowKey(e), (inFlightPerFlow.get(flowKey(e)) ?? 0) + 1);
    const index = new ConflictIndex();
    const active = this.activeChain();
    for (const b of active) for (const id of ownEntries(b)) index.add(b.id, this.entry(id)?.affected ?? null);
    let inflightCount = active.filter(inFlight).length;
    const blocked = new ConflictIndex();
    const depthMemo = new Map<string, number>();
    const planned = new Map<string, PlannedUnit>();
    const touched = new Set<string>();

    const place = (u: PlannedUnit): "placed" | "blocked" | "deferred" | "dep" => {
      const depBatches = new Set<string>();
      for (const d of u.deps) {
        const de = this.entry(d);
        if (de === undefined) return "dep";
        if (this.inChain(de) && de.batchId !== null) depBatches.add(de.batchId);
        else if (de.state !== "merged") return "dep";
      }
      if (cfg.features.fairness) {
        for (const [f, n] of u.flows) {
          const cur = inFlightPerFlow.get(f) ?? 0;
          if (cur > 0 && cur + n > cfg.maxInFlightPerSession) return "deferred";
        }
      }
      const expressFirst = frozen && u.express;
      if (!expressFirst && (cfg.features.conflictGraph ? blocked.query(u.affected).size > 0 : blocked.size > 0)) return "blocked";
      const hits = cfg.features.conflictGraph ? index.query(u.affected) : index.query(unknownAffectedSet());
      for (const d of depBatches) hits.add(d);
      const conflicting = [...hits].map((id) => this.batch(id)).filter((b): b is Batch => b !== undefined && this.isActiveChain(b));
      if (expressFirst && conflicting.some((b) => !this.isExpressBatch(b))) return "blocked"; // a normal batch with a CAS in flight
      // Frontier: the conflicting batches no other conflicting batch is built on.
      const frontier = conflicting.filter((c) => {
        const cOwn = ownEntries(c);
        return !conflicting.some((o) => o.id !== c.id && this.builtOn(o, cOwn));
      });
      // 1) Join an unbuilt batch whose tree already covers the frontier.
      const capacity = this.batchCapacity();
      for (const o of [...active].reverse()) {
        if (o.state !== "pending" || !this.isActiveChain(o)) continue;
        // A batch something is already built on (its tip, or a merge copying its lineage) can't
        // grow: the descendant's lineage would not list the newcomer.
        const oOwn = ownEntries(o);
        if (active.some((c) => c.id !== o.id && this.isActiveChain(c) && this.builtOn(c, oOwn))) continue;
        if (u.isolate || o.units.some((x) => x.changeIds.some((id) => this.entry(id)?.isolate === true))) continue;
        if (frozen && this.isExpressBatch(o) !== u.express) continue;
        const covers =
          frontier.length > 0
            ? frontier.every((f) => f.id === o.id || this.builtOn(o, ownEntries(f)))
            : cfg.coBatch && o.parentId === null && o.carried.length === 0;
        if (!covers) continue;
        const size = ownEntries(o).length;
        if (size > 0 && size + u.changeIds.length > capacity) continue;
        if (cfg.features.prediction) {
          let p = u.p;
          for (const id of ownEntries(o)) p *= this.entry(id)?.prediction?.p ?? 1;
          if (p < cfg.targetBatchPassProbability) continue;
        }
        this.joinBatch(o, u);
        index.add(o.id, u.affected);
        planned.set(u.changeIds[0] ?? "", u);
        touched.add(o.id);
        for (const [f, n] of u.flows) inFlightPerFlow.set(f, (inFlightPerFlow.get(f) ?? 0) + n);
        return "placed";
      }
      // 2) A new batch: within the speculation depth and the in-flight cap.
      if (inflightCount >= cfg.maxInFlightBatches) return "blocked";
      // Depth = the longest chain of untested batches the new one would sit on (independent
      // chains joined by a merge don't add up).
      const depth = 1 + Math.max(0, ...frontier.map((f) => this.chainDepth(f, depthMemo)));
      if (depth > cfg.maxSpeculationDepth) return "blocked";
      if (frontier.length === 0 && Object.keys(s.tracks).length >= cfg.maxTracks) return "blocked";
      const b = this.createChainBatch(u, frontier);
      active.push(b);
      inflightCount++;
      index.add(b.id, u.affected);
      planned.set(u.changeIds[0] ?? "", u);
      touched.add(b.id);
      for (const [f, n] of u.flows) inFlightPerFlow.set(f, (inFlightPerFlow.get(f) ?? 0) + n);
      return "placed";
    };

    let queue = units;
    for (let sweep = 0; sweep < 4 && queue.length > 0; sweep++) {
      const retry: PlannedUnit[] = [];
      for (const u of queue) {
        const r = place(u);
        if (r === "placed") changed = true;
        else if (r === "blocked") blocked.add(`u:${u.changeIds[0]}`, u.affected);
        else if (r === "dep") retry.push(u);
      }
      if (retry.length === queue.length) break;
      queue = retry;
    }
    for (const bid of touched) {
      const b = this.batch(bid);
      if (b !== undefined) this.finalizeBatch(b, planned);
    }
    return changed;
  }

  /** Longest path of in-flight (untested) batches ending at b, through its build parents. */
  private chainDepth(b: Batch, memo: Map<string, number>): number {
    const hit = memo.get(b.id);
    if (hit !== undefined) return hit;
    memo.set(b.id, 0); // cycle guard (cannot happen: parents are older)
    let up = 0;
    for (const pid of [...(b.parentId === null ? [] : [b.parentId]), ...b.mergeParents]) {
      const p = this.batch(pid);
      if (p !== undefined && this.isActiveChain(p)) up = Math.max(up, this.chainDepth(p, memo));
    }
    const d = (inFlight(b) ? 1 : 0) + up;
    memo.set(b.id, d);
    return d;
  }

  /** Max entries per batch: adaptive to the recent pass rate (prediction on) or fixed. */
  private batchCapacity(): number {
    const cfg = this.cfg;
    if (!cfg.features.prediction) return cfg.fixedBatchSize;
    const r = this.s.stats.batchPassRate;
    if (r < 0.5) return 1;
    if (r < 0.7) return Math.max(1, Math.floor(cfg.maxBatchSize / 4));
    if (r < 0.85) return Math.max(1, Math.floor(cfg.maxBatchSize / 2));
    return cfg.maxBatchSize;
  }

  private batchConflicts(b: Batch, a: AffectedSet): boolean {
    return ownEntries(b).some((id) => conflicts(this.entry(id)?.affected ?? null, a));
  }

  private inChain(e: QueueEntry): boolean {
    if (e.batchId === null) return false;
    const b = this.batch(e.batchId);
    return b !== undefined && this.isActiveChain(b);
  }

  /**
   * Speculating on the predecessor's tip is only sound if nothing that landed since its chain was
   * rooted conflicts with the unit (else the unit's tree would miss a conflicting change).
   */
  private appendable(f: Batch, a: AffectedSet): boolean {
    if (f.rootSeq === this.s.main.seq) return true;
    const first = this.s.mainLog[0];
    if (first === undefined || f.rootSeq < first.seq) return false;
    const lineage = new Set(f.lineage);
    for (const m of this.s.mainLog) {
      if (m.seq <= f.rootSeq) continue;
      for (const c of m.changes) if (!lineage.has(c.changeId) && conflicts(c.affected, a)) return false;
    }
    return true;
  }

  private createChainBatch(u: PlannedUnit, frontier: Batch[]): Batch {
    const id = this.id("b");
    const single = frontier.length === 1 ? frontier[0] : undefined;
    const onTip = single !== undefined && this.appendable(single, u.affected);
    let parentId: string | null = null;
    const carried: string[] = [];
    let rootBase = this.s.main.sha;
    let rootSeq = this.s.main.seq;
    let lineage: string[] = [];
    if (onTip && single !== undefined) {
      parentId = single.id;
      rootBase = single.rootBase;
      rootSeq = single.rootSeq;
      lineage = [...single.lineage];
    } else if (frontier.length > 0) {
      // Merge batch: rebuild every unmerged entry of the predecessors on current main.
      const seen = new Set<string>();
      for (const f of [...frontier].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)))
        for (const x of f.lineage) {
          if (seen.has(x)) continue;
          seen.add(x);
          if (this.entry(x)?.state !== "merged") carried.push(x);
        }
      lineage = [...carried];
    }
    const tracks = frontier.map((f) => f.trackId ?? "").filter((t) => t !== "");
    let track = this.mergeTracks(tracks);
    if (track === undefined) {
      const tid = this.id("t");
      track = { id: tid, chain: [], createdAt: this.now, express: isFrozen(this.s) && u.express };
      this.s.tracks[tid] = track;
    }
    const b: Batch = {
      id,
      kind: "chain",
      trackId: track.id,
      parentId,
      mergeParents: onTip ? [] : frontier.map((f) => f.id),
      carried,
      rootBase,
      rootSeq,
      baseSha: parentId === null ? rootBase : null,
      units: [],
      lineage,
      state: "pending",
      tipSha: null,
      treeSha: null,
      commits: [],
      refName: `refs/queue/${id}`,
      runId: null,
      runSeq: 0,
      startedAt: null,
      targets: "all",
      verdict: null,
      recheck: null,
      bisect: null,
      probe: null,
      members: [],
      fallbackOf: null,
      noRevalidate: false,
      createdAt: this.now,
      readyAt: null,
      infraRetries: 0,
    };
    this.s.batches[id] = b;
    track.chain = [...track.chain, id];
    this.joinBatch(b, u);
    return b;
  }

  private joinBatch(b: Batch, u: PlannedUnit): void {
    b.units = [...b.units, { changeIds: u.changeIds }];
    b.lineage = [...b.lineage, ...u.changeIds];
    for (const e of u.entries) {
      e.state = "speculating";
      e.batchId = b.id;
      e.trackId = b.trackId;
      e.hold = null;
      e.isolate = false;
      if (e.firstBatchAt === null) e.firstBatchAt = this.now;
      advanceVirtualTime(this.s, e);
    }
  }

  /** Likely failures last (prediction), stack order kept; then announce the batch. */
  private finalizeBatch(b: Batch, planned: Map<string, PlannedUnit>): void {
    if (this.cfg.features.prediction && b.units.length > 1) {
      const pOf = (ids: string[]) => planned.get(ids[0] ?? "")?.p ?? 1;
      const inBatch = new Set(ownEntries(b));
      const left = [...b.units];
      const out: typeof b.units = [];
      const placed = new Set<string>();
      while (left.length > 0) {
        let best = -1;
        for (let i = 0; i < left.length; i++) {
          const u = left[i];
          if (u === undefined) continue;
          const deps = u.changeIds.flatMap((id) => this.entry(id)?.dependsOn ?? []);
          if (deps.some((d) => inBatch.has(d) && !placed.has(d) && !u.changeIds.includes(d))) continue;
          const cur = best < 0 ? undefined : left[best];
          if (cur === undefined || pOf(u.changeIds) > pOf(cur.changeIds)) best = i;
        }
        const [u] = left.splice(best < 0 ? 0 : best, 1);
        if (u === undefined) break;
        out.push(u);
        for (const id of u.changeIds) placed.add(id);
      }
      b.units = out;
      b.lineage = [...b.lineage.filter((x) => !inBatch.has(x)), ...out.flatMap((u) => u.changeIds)];
    }
    const own = ownEntries(b);
    own.forEach((cid, position) => {
      const e = this.entry(cid);
      if (e === undefined || b.trackId === null) return;
      if (e.prediction !== null)
        this.telemetry("prediction", { changeId: cid, batchId: b.id, position, p: e.prediction.p, factors: e.prediction.factors, model: e.prediction.model });
      this.emit({
        type: "entered_batch",
        at: this.now,
        changeId: cid,
        batchId: b.id,
        trackId: b.trackId,
        position,
        batchSize: own.length,
        predictedPassProbability: e.prediction?.p ?? null,
      });
    });
  }

  private topoOrder(members: QueueEntry[]): QueueEntry[] {
    const ids = new Set(members.map((e) => e.changeId));
    const out: QueueEntry[] = [];
    const done = new Set<string>();
    const left = [...members].sort((a, b) => a.seq - b.seq);
    while (left.length > 0) {
      const i = left.findIndex((e) => e.dependsOn.every((d) => !ids.has(d) || done.has(d)));
      const [e] = left.splice(i < 0 ? 0 : i, 1);
      if (e === undefined) break;
      out.push(e);
      done.add(e.changeId);
    }
    return out;
  }

  // ================================================================ GC

  gc(): void {
    const s = this.s;
    const excess = s.terminal.length - this.cfg.retainTerminal;
    if (excess > 0) {
      for (const id of s.terminal.slice(0, excess)) {
        const e = s.entries[id];
        if (e !== undefined && isTerminal(e)) delete s.entries[id];
      }
      s.terminal = s.terminal.slice(excess);
    }
    const referenced = new Set<string>();
    for (const b of Object.values(s.batches)) {
      if (batchDone(b)) continue;
      if (b.parentId !== null) referenced.add(b.parentId);
      if (b.probe !== null) referenced.add(b.probe.of);
      for (const m of b.members) referenced.add(m);
      for (const p of b.bisect?.probeIds ?? []) referenced.add(p);
    }
    if (s.cas !== null) referenced.add(s.cas.batchId);
    for (const [id, b] of Object.entries(s.batches)) if (batchDone(b) && !referenced.has(id)) delete s.batches[id];
  }
}

export { InvariantViolation };
