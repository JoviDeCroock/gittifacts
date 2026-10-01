/**
 * The pure scheduling core: `step(state, event, { now }) → { state, commands }`.
 *
 * No IO, no clock, no randomness: time comes from `now`, ids from a counter in the state. The
 * `MergeQueue` DO and the simulator run exactly this code. See protocol.ts for the vocabulary and
 * README-level notes in each section below for the mechanics (§ refer to 03-merge-queue.md).
 */
import { ConflictIndex, conflicts, isWildcard, unionAffected } from "./conflict.js";
import { ejectReason, type EjectInput } from "./eject.js";
import { InvariantViolation, invariant } from "./invariants.js";
import { predict } from "./predict.js";
import {
  advanceVirtualTime,
  assignTag,
  compareOrder,
  effectiveRank,
  flowKey,
  isExpress,
} from "./priority.js";
import type {
  CasEvidence,
  Command,
  CoreEvent,
  CoreEventOf,
  LaneRaise,
} from "./protocol.js";
import {
  ALL_TESTS,
  type AffectedSet,
  type Batch,
  type FreezeReason,
  type Lane,
  type LaneReason,
  type QueueEntry,
  type QueueEvent,
  type ResolutionState,
  TERMINAL_STATES,
  type TestScope,
  type Track,
  type TreeVerdict,
  type Unit,
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

  private telemetry(
    kind: "prediction" | "outcome" | "lane-downgrade-ignored" | "rejected-event",
    data: Record<string, unknown>,
  ): void {
    this.out.push({ type: "Telemetry", kind, data });
  }

  private reject(event: string, why: string, data: Record<string, unknown> = {}): void {
    this.telemetry("rejected-event", { event, why, ...data });
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
        this.reject("Enqueued", "a previous head is landing right now; retry after it settles", {
          changeId: ev.changeId,
        });
        return;
      }
      // New head: the old one leaves the queue, the new one starts over at the back.
      this.removeFromFlight(existing);
      this.terminate(
        existing,
        "ejected",
        {
          changeId: existing.changeId,
          code: "superseded",
          message: `head ${existing.headSha.slice(0, 12)} replaced by ${ev.headSha.slice(0, 12)}`,
        },
        SYSTEM_PRINCIPAL,
        false,
      );
    }
    const seq = ++this.s.seq;
    const deps = [...new Set(ev.dependsOn)].filter((d) => d !== ev.changeId);
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
      approvalRequired: false,
      size: ev.size,
      evidence: ev.evidence,
      prediction: null,
      wfqTag: 0,
      isolate: false,
      dequeueRequested: false,
      firstBatchAt: null,
      mergedSha: null,
      terminalAt: null,
    };
    // A Change enqueued with a lane above its approval is never schedulable until approved.
    if (ev.approvedLane !== undefined && ev.approvedLane < ev.lane) e.approvalRequired = true;
    e.wfqTag = assignTag(this.s, e);
    this.s.entries[e.changeId] = e;
    if (e.affected === null) {
      this.out.push({ type: "ComputeAffectedSet", changeId: e.changeId, headSha: e.headSha });
    } else {
      this.applyQuarantineTo(e);
    }
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
      const seqOf = this.landedSeqOf(e.revertOf);
      this.markBad(seqOf ?? this.s.main.seq);
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
      this.reject("Reprioritized", "the incident class needs a human or an incident Plan", {
        changeId: e.changeId,
        by: ev.by.principalId,
      });
      return;
    }
    if (ev.priority === "revert" && e.revertOf === null && !human) {
      this.reject("Reprioritized", "only reverts (or a human) may use the revert class", {
        changeId: e.changeId,
      });
      return;
    }
    const from = e.priority;
    e.priority = ev.priority;
    this.audit("merge-queue.reprioritized", `change:${e.changeId}`, {
      from,
      to: ev.priority,
      by: ev.by.principalId,
      incidentPlanId: ev.incidentPlanId,
    });
  }

  private onAffected(ev: CoreEventOf<"AffectedSetComputed">): void {
    const e = this.entry(ev.changeId);
    if (e === undefined || isTerminal(e) || e.headSha !== ev.headSha) return;
    // Only a pending set or the timeout's unknown placeholder may be replaced while in flight.
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
      if (ev.result.status === "clean")
        this.out.push({ type: "DeleteQueueRef", refName: `refs/queue/${ev.batchId}` });
      return;
    }
    if (ev.result.status === "conflict") {
      this.onTextualConflict(b, ev.result.changeId, ev.result.files, ev.result.upstream);
      return;
    }
    const expected = ownEntries(b);
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
      this.audit("merge-queue.result-tree-mismatch", `batch:${b.id}`, {
        runId: ev.runId,
        expected: b.treeSha,
        got: ev.treeSha,
      });
      this.infraRetry(b, "result for a different tree", "ready");
      return;
    }
    if (!this.scopeCovers(ev.scope, b.targets)) {
      this.audit("merge-queue.result-scope-short", `batch:${b.id}`, {
        runId: ev.runId,
        wanted: b.targets,
        got: ev.scope,
      });
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
    const quarantinedFailing = failing.filter((t) => this.s.quarantine[t] !== undefined);
    const candidates = failing.filter((t) => this.s.quarantine[t] === undefined);
    const verdict = this.newVerdict(b, ev.runId, quarantinedFailing);
    if (candidates.length === 0) {
      this.onVerdict(b, verdict);
      return;
    }
    if (this.cfg.features.flakeRecheck) {
      b.state = "rechecking";
      b.recheck = { tests: candidates, mainSha: this.s.main.sha };
      b.verdict = verdict;
      b.runSeq++;
      b.runId = `${b.id}-k${b.runSeq}`;
      b.startedAt = this.now;
      invariant(b.tipSha !== null && b.treeSha !== null, "recheck.tree", "re-check of an unbuilt batch");
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
    if (b === undefined || b.state !== "rechecking" || b.runId !== ev.runId || b.recheck === null)
      return;
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
        // Fails on main's head too → suspected flaky: quarantine, don't eject (§4.7).
        stats.flaky++;
        this.quarantineTest(t, b, b.recheck.mainSha);
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
    invariant(
      b.treeSha !== null && b.tipSha !== null && b.baseSha !== null,
      "verdict.tree",
      `verdict for unbuilt batch ${b.id}`,
    );
    return {
      treeSha: b.treeSha,
      commitSha: b.tipSha,
      baseSha: b.baseSha,
      scope: b.targets,
      runIds: [runId],
      passed: true,
      failing: [],
      quarantined: [...new Set([...quarantinedFailing, ...this.relevantQuarantine(this.verdictEntries(b))])],
      flakyRetried: [],
    };
  }

  private verdictEntries(b: Batch): string[] {
    if (b.kind !== "landing") return ownEntries(b);
    const out: string[] = [];
    for (const m of b.members) out.push(...ownEntries(this.batch(m) ?? b));
    return out;
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
        const i = this.s.landing.indexOf(b.id);
        for (const m of b.members) {
          const mb = this.batch(m);
          if (mb !== undefined) mb.noRevalidate = true;
        }
        if (i >= 0) this.invalidateLanding(i, why);
        return;
      }
      case "chain": {
        const t = this.s.tracks[b.trackId ?? ""];
        const own = ownEntries(b);
        if (t !== undefined && t.chain.includes(b.id)) this.cancelChainFrom(t, t.chain.indexOf(b.id), why);
        for (const id of own) {
          const e = this.entry(id);
          if (e === undefined || isTerminal(e)) continue;
          e.infraErrors++;
          if (e.infraErrors > this.cfg.maxInfraRetries) {
            this.removeFromFlight(e);
            this.terminate(e, "ejected", {
              changeId: id,
              code: "infra-error",
              message: `CI could not produce a result (${why})`,
            });
          }
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------- failures and bisection (§4.3)

  private onChainFailure(b: Batch): void {
    this.s.stats.batchPassRate = 0.8 * this.s.stats.batchPassRate;
    const t = this.s.tracks[b.trackId ?? ""];
    if (t !== undefined) {
      const idx = t.chain.indexOf(b.id);
      // Descendants contain the culprit: re-form them right away on b's parent (they don't wait
      // for the bisection).
      if (idx >= 0) {
        this.cancelChainFrom(t, idx + 1, `ancestor ${b.id} failed`);
        t.chain = t.chain.filter((x) => x !== b.id);
        if (t.chain.length === 0) delete this.s.tracks[t.id];
      }
    }
    this.abortChildBisections(b.id, `ancestor ${b.id} failed`);
    for (const id of ownEntries(b)) {
      const e = this.entry(id);
      if (e !== undefined) e.attempts++;
    }
    b.state = "bisecting";
    b.bisect = {
      lo: 0,
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
    if (b.parentId === null) return "good"; // rooted on main, which is green by construction
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
    let n = 0;
    for (const u of units) n += u.changeIds.length;
    const c = b.commits[n - 1];
    invariant(c !== undefined && b.baseSha !== null, "probe.commit", `no commit for prefix ${n} of ${b.id}`);
    const id = this.id("p");
    this.s.batches[id] = {
      id,
      kind: "probe",
      trackId: b.trackId,
      parentId: null,
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
        let lo = 0;
        for (const id of bis.probeIds) {
          const q = this.batch(id);
          if (q?.state === "passed" && q.probe !== null && q.probe.prefixUnits < bis.hi)
            lo = Math.max(lo, q.probe.prefixUnits);
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
    for (const b of Object.values(this.s.batches))
      if (b.state === "bisecting" && b.parentId === parentId) this.resolveBisection(b);
  }

  private abortChildBisections(parentId: string, why: string): void {
    for (const b of Object.values(this.s.batches))
      if (b.state === "bisecting" && b.parentId === parentId) this.abortBisection(b, why);
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
    const ancestors = b.lineage.filter((id) => !ownEntries(b).includes(id));
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
        preceding: prefix,
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
    const t = this.s.tracks[b.trackId ?? ""];
    const units = b.units;
    const ui = units.findIndex((u) => u.changeIds.includes(changeId));
    const preceding = units.slice(0, Math.max(0, ui)).flatMap((u) => u.changeIds);
    const lineageBefore = b.lineage.slice(0, b.lineage.indexOf(changeId) >= 0 ? b.lineage.indexOf(changeId) : b.lineage.length);
    if (t !== undefined && t.chain.includes(b.id)) this.cancelChainFrom(t, t.chain.indexOf(b.id), `rebase conflict on ${changeId}`);
    const e = this.entry(changeId);
    if (e === undefined || isTerminal(e)) return;
    if (e.batchId !== null) this.removeFromFlight(e);
    const suspects = upstream.length > 0 ? upstream : [...new Set([...lineageBefore, ...this.overlappingLanded(e)])].slice(0, 20);
    if (this.canResolve(e, "textual")) {
      this.startResolution(e, "textual", {
        upstream: suspects,
        files,
        failingTests: [],
        ontoSha: b.baseSha ?? this.s.main.sha,
        preceding,
      });
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
    e.resolution = {
      kind,
      attempts,
      upstream: info.upstream,
      files: info.files,
      failingTests: info.failingTests,
      blamed: null,
      resolved: false,
    };
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
    this.emit({
      type: "resolving_conflict",
      at: this.now,
      changeId: e.changeId,
      kind,
      upstream: info.upstream,
      attempt: attempts,
    });
  }

  private onResolution(ev: CoreEventOf<"ResolutionResult">): void {
    const e = this.entry(ev.changeId);
    const r = e?.resolution ?? null;
    if (e === undefined || e.state !== "resolving" || r === null || ev.attempt !== r.attempts) {
      this.reject("ResolutionResult", "no matching resolution in progress", {
        changeId: ev.changeId,
        attempt: ev.attempt,
      });
      return;
    }
    let outcome = ev.outcome;
    if (ev.resolverId === e.authorId) {
      // The resolver must not be the Change's authoring agent (no self-approval of resolutions).
      this.audit("merge-queue.self-resolution-rejected", `change:${e.changeId}`, {
        resolverId: ev.resolverId,
      });
      outcome = { status: "failed", message: "resolver is the Change's author" };
    } else if (outcome.status === "resolved" && r.kind === "semantic" && outcome.blamedUpstream === null) {
      outcome = { status: "failed", message: "semantic resolution did not name the upstream Change" };
    }
    switch (outcome.status) {
      case "resolved": {
        if (outcome.lane < e.lane)
          this.telemetry("lane-downgrade-ignored", {
            changeId: e.changeId,
            lane: e.lane,
            reported: outcome.lane,
            resolverId: ev.resolverId,
          });
        const reasons: LaneReason[] = [...outcome.laneReasons];
        if (outcome.outsideHunks)
          reasons.push({
            code: "merge-queue.resolution-outside-hunks",
            lane: 1,
            message: "The conflict resolution touches lines outside the conflict hunks.",
          });
        // The lane may only stay or rise: the core keeps the max.
        this.raiseLane(e, Math.max(outcome.lane, outcome.outsideHunks ? 1 : 0) as Lane, reasons, false);
        e.headSha = outcome.newHeadSha;
        e.resolverIds = [...e.resolverIds, ev.resolverId];
        e.resolution = { ...r, resolved: true, blamed: outcome.blamedUpstream };
        e.affected = outcome.affected;
        e.affectedRequestedAt = outcome.affected === null ? this.now : null;
        e.state = "waiting";
        if (outcome.affected === null)
          this.out.push({ type: "ComputeAffectedSet", changeId: e.changeId, headSha: e.headSha });
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
      case "budget-exhausted": {
        this.terminate(e, "ejected", {
          changeId: e.changeId,
          code: "resolution-budget-exhausted",
          message: outcome.message,
          upstream: r.upstream,
          files: r.files,
        });
        return;
      }
      case "failed": {
        if (r.attempts < this.cfg.resolutionMaxAttempts && e.resolverIds.length < MAX_RESOLUTIONS_PER_ENTRY) {
          this.startResolution(e, r.kind, {
            upstream: r.upstream,
            files: r.files,
            failingTests: r.failingTests,
            ontoSha: this.s.main.sha,
            preceding: [],
          });
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
      this.reject("Approved", `approval covers lane ${ev.lane}, the Change is lane ${e.lane}`, {
        changeId: e.changeId,
      });
      return;
    }
    e.approvedLane = Math.max(e.approvedLane, ev.lane) as Lane;
    e.approvalRequired = false;
    this.audit("merge-queue.approved", `change:${e.changeId}`, { approver: pid, lane: ev.lane }, pid);
  }

  // ---------------------------------------------------------------- flakes (§4.7)

  private quarantineTest(test: string, b: Batch, mainSha: string): void {
    if (this.s.quarantine[test] !== undefined) return;
    if (b.treeSha === null) return;
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
    this.out.push({
      type: "OpenPlan",
      kind: "fix-flaky-test",
      test,
      title: `Fix flaky test ${test}`.slice(0, 200),
      evidenceRefs: refs,
    });
    for (const e of Object.values(this.s.entries)) {
      if (isTerminal(e)) continue;
      this.applyQuarantineTo(e);
    }
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
    if (raised && e.approvalRequired && e.batchId !== null && !this.inCas(e.changeId))
      this.removeFromFlight(e);
  }

  private relevantQuarantine(changeIds: string[]): string[] {
    const q = Object.keys(this.s.quarantine);
    if (q.length === 0) return [];
    const out = new Set<string>();
    for (const id of changeIds) {
      const a = this.entry(id)?.affected ?? null;
      if (isWildcard(a) || a === null) {
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
      this.audit("merge-queue.cas-" + ev.result, `batch:${b.id}`, {
        casId: cas.casId,
        expectedOld: cas.expectedOld,
        actual: ev.actualSha,
        detail: ev.detail,
      });
      if (ev.result === "stale" && ev.actualSha !== null && ev.actualSha !== this.s.main.sha) {
        this.onExternalMain(ev.actualSha);
      } else if (ev.result === "rejected") {
        this.s.casRetryAt = this.now + 30_000;
      }
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
    this.s.mainLog.push({
      seq: this.s.main.seq,
      sha: cas.newSha,
      parentSha: cas.expectedOld,
      changes,
      at: this.now,
      kind: "cas",
    });
    if (this.s.mainLog.length > this.cfg.mainLogLimit)
      this.s.mainLog = this.s.mainLog.slice(this.s.mainLog.length - this.cfg.mainLogLimit);
    const landed = b.kind === "landing" ? [b, ...b.members.map((m) => this.batch(m)).filter((x): x is Batch => x !== undefined)] : [b];
    for (const lb of landed) {
      this.finishBatch(lb, "landed");
      const t = this.s.tracks[lb.trackId ?? ""];
      if (t !== undefined) {
        t.chain = t.chain.filter((x) => x !== lb.id);
        if (t.chain.length === 0) delete this.s.tracks[t.id];
      }
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
      if (!isTerminal(o) && o.dependsOn.includes(e.changeId))
        o.dependsOn = o.dependsOn.filter((d) => d !== e.changeId);
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
    this.telemetry("outcome", {
      changeId: e.changeId,
      outcome: "merged",
      predicted: e.prediction?.p ?? null,
      factors: e.prediction?.factors ?? {},
    });
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
      // Unknown content conflicts with everything: every stale track re-runs in full.
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

  /** Every queue entry of b's tree below its own entries has landed. */
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
   * Can b's full-run result carry over to b rebased onto main (+ `ahead`)? Only if everything that
   * landed since b's chain was rooted (and isn't in b's tree) has a known affected set disjoint from
   * each of b's own entries. Returns the changes the result is carried across, or null.
   */
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
    return this.verdictEntries(b);
  }

  private readyChainBatches(): Batch[] {
    const out: Batch[] = [];
    for (const t of Object.values(this.s.tracks))
      for (const bid of t.chain) {
        const b = this.batch(bid);
        if (b !== undefined && b.state === "passed") out.push(b);
      }
    out.sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    return out;
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
        for (const id of ownEntries(this.batch(m) ?? (l as Batch))) ahead.push({ changeId: id, affected: this.entry(id)?.affected ?? null });
      }
    }
    const members: Batch[] = [];
    const aheadIds = new Set(ahead.map((a) => a.changeId));
    for (const b of this.readyChainBatches()) {
      if (inLanding.has(b.id)) continue;
      if (s.landing.length === 0 && members.length === 0 && b.baseSha === s.main.sha) continue; // direct land path
      const own = ownEntries(b);
      if (!this.landAllowed(own)) continue;
      if (!this.cfg.features.revalidation || b.noRevalidate) {
        if (this.lineageLanded(b)) {
          this.fallback(b);
          changed = true;
        }
        continue;
      }
      if (s.landing.length >= this.cfg.maxLandingDepth) continue;
      if (!this.lineageLanded(b, aheadIds)) continue;
      const carried = this.carryOver(b, ahead);
      if (carried === null) {
        if (this.lineageLanded(b)) {
          this.fallback(b);
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
    const targets: TestScope = isWildcard(affected) ? "all" : [...new Set(affected.testTargets)].sort();
    this.s.batches[id] = {
      id,
      kind: "landing",
      trackId: null,
      parentId,
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

  /** Replace a stale passed chain-head batch by a full run of the same units on current main. */
  private fallback(b: Batch): void {
    const t = this.s.tracks[b.trackId ?? ""];
    invariant(t !== undefined && t.chain.includes(b.id), "fallback.track", `fallback of ${b.id} outside its chain`);
    const id = this.id("b");
    const nb: Batch = {
      ...b,
      id,
      parentId: null,
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
    this.s.batches[id] = nb;
    t.chain = t.chain.map((x) => (x === b.id ? id : x));
    for (const cid of ownEntries(b)) {
      const e = this.entry(cid);
      if (e !== undefined && e.batchId === b.id) {
        e.batchId = id;
        e.state = "speculating";
      }
    }
    this.finishBatch(b, "cancelled");
    this.audit("merge-queue.full-run-fallback", `batch:${id}`, { of: b.id, entries: ownEntries(b) });
  }

  private onLandingFailure(l: Batch): void {
    const i = this.s.landing.indexOf(l.id);
    // A hidden interaction between tracks: every member re-runs in full on main.
    for (const m of l.members) {
      const mb = this.batch(m);
      if (mb !== undefined) mb.noRevalidate = true;
    }
    l.state = "failed";
    if (i >= 0) this.invalidateLanding(i, "revalidation failed");
    else this.finishBatch(l, "failed");
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
      if (l.state !== "failed") this.cancelBatch(l, why);
      else this.finishBatch(l, "failed");
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
    invariant(
      v.treeSha === b.treeSha && v.commitSha === b.tipSha,
      "cas.tree-mismatch",
      `verdict of ${b.id} is for tree ${v.treeSha}, not ${b.treeSha}`,
    );
    invariant(b.baseSha === s.main.sha && v.baseSha === s.main.sha, "cas.stale-base", `batch ${b.id} is not built on main`);
    const entries = this.landingEntriesOf(b);
    invariant(new Set(entries).size === entries.length, "cas.duplicate", `batch ${b.id} lists an entry twice`);
    const carried: CasEvidence["carried"] = [];
    if (b.kind === "chain") {
      invariant(v.scope === "all", "cas.scope", `direct land of ${b.id} needs a full run`);
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
          if (isWildcard(a) || a === null) all = true;
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
        const dp = position.get(d);
        invariant(
          dp !== undefined && dp < (position.get(id) ?? 0),
          "cas.stack-order",
          `${id} depends on ${d}, which neither landed nor precedes it`,
        );
      }
      if (e.landTogether && e.plangroup !== null) {
        const group = Object.values(s.entries).filter((o) => o.plangroup === e.plangroup && o.landTogether && !isTerminal(o));
        invariant(
          group.every((o) => position.has(o.changeId)),
          "cas.plangroup",
          `plan group ${e.plangroup} would land partially`,
        );
        invariant(
          e.groupSize === null || group.length >= e.groupSize,
          "cas.plangroup-size",
          `plan group ${e.plangroup} has ${group.length}/${e.groupSize} members`,
        );
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
    s.cas = {
      casId,
      batchId: b.id,
      expectedOld: s.main.sha,
      newSha: b.tipSha,
      treeSha: b.treeSha,
      entries,
      issuedAt: this.now,
    };
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
    for (const t of Object.values(this.s.tracks)) {
      const i = t.chain.findIndex((bid) => {
        const b = this.batch(bid);
        return b !== undefined && !this.batchInCas(b) && b.rootSeq >= badSeq && !b.lineage.some((x) => reverts.has(x));
      });
      if (i >= 0) {
        n += t.chain.length - i;
        this.cancelChainFrom(t, i, "built on a main that was reverted");
      }
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
    this.audit(
      "merge-queue.thawed",
      "repo:merge-queue",
      { by: ev.signer.principalId, reason: ev.reason, manual: true },
      ev.signer.principalId,
      ev.signer.signature,
    );
    this.emit({ type: "thawed", at: this.now, by: ev.signer.principalId, invalidatedBatches: 0 });
  }

  /**
   * While frozen only reverts/incident fixes land, so they must never sit behind (or in a batch
   * with) anything else: re-root their tracks so the express entries go first, on main.
   */
  private ensureExpressRouting(): boolean {
    let changed = false;
    for (const t of Object.values(this.s.tracks)) {
      let firstNormal = -1;
      for (let i = 0; i < t.chain.length; i++) {
        const b = this.batch(t.chain[i] ?? null);
        if (b === undefined) continue;
        const ids = ownEntries(b);
        const hasExpress = ids.some((id) => {
          const e = this.entry(id);
          return e !== undefined && isExpress(e);
        });
        const hasNormal = ids.some((id) => {
          const e = this.entry(id);
          return e !== undefined && !isExpress(e);
        });
        if (hasNormal && firstNormal < 0) firstNormal = i;
        if (hasExpress && firstNormal >= 0) {
          let from = firstNormal;
          while (from < t.chain.length) {
            const fb = this.batch(t.chain[from] ?? null);
            if (fb === undefined || !this.batchInCas(fb)) break;
            from++;
          }
          if (from < t.chain.length) {
            this.cancelChainFrom(t, from, "frozen: revert/incident fixes go first");
            changed = true;
          }
          break;
        }
      }
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
        this.audit("merge-queue.affected-set-timeout", `change:${e.changeId}`, {
          waitedMs: this.now - e.affectedRequestedAt,
        });
        this.applyQuarantineTo(e);
      }
    }
    for (const b of Object.values(s.batches)) {
      if ((b.state === "running" || b.state === "rechecking" || b.state === "building") && b.startedAt !== null) {
        if (this.now - b.startedAt < this.cfg.runTimeoutMs) continue;
        if (b.runId !== null && b.state !== "building")
          this.out.push({ type: "CancelBatchRun", batchId: b.id, runId: b.runId, reason: "timed out" });
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
    if (b.kind !== "probe" && b.state !== "pending")
      this.out.push({ type: "DeleteQueueRef", refName: b.refName });
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

  /** Cancel chain[from..] (never a batch whose CAS is in flight); their entries wait again. */
  private cancelChainFrom(t: Track, from: number, why: string): void {
    const removed = t.chain.slice(from);
    for (const bid of removed) {
      const b = this.batch(bid);
      invariant(b === undefined || !this.batchInCas(b), "cancel.in-cas", `cannot cancel ${bid}: CAS in flight`);
    }
    t.chain = t.chain.slice(0, from);
    for (const bid of removed) {
      const b = this.batch(bid);
      if (b === undefined) continue;
      const li = this.s.landing.findIndex((lid) => this.batch(lid)?.members.includes(bid) === true);
      if (li >= 0) this.invalidateLanding(li, why);
      this.cancelBatch(b, why);
      this.returnUnits(b);
      this.abortChildBisections(bid, why);
    }
    if (t.chain.length === 0) delete this.s.tracks[t.id];
  }

  /** Take an entry out of whatever batch holds it; its batch-mates and descendants re-form. */
  private removeFromFlight(e: QueueEntry): void {
    const b = this.batch(e.batchId);
    if (b === undefined) {
      if (e.state === "speculating" || e.state === "passed") this.toWaiting(e);
      return;
    }
    invariant(!this.batchInCas(b), "remove.in-cas", `cannot pull ${e.changeId}: CAS in flight`);
    if (b.state === "bisecting") {
      this.abortBisection(b, `${e.changeId} left the batch`);
    } else {
      const t = this.s.tracks[b.trackId ?? ""];
      if (t !== undefined && t.chain.includes(b.id)) this.cancelChainFrom(t, t.chain.indexOf(b.id), `${e.changeId} left the batch`);
      else {
        this.cancelBatch(b, `${e.changeId} left the batch`);
        this.returnUnits(b);
      }
    }
    if (e.batchId !== null) this.toWaiting(e);
  }

  /** Terminal transition + cascades (stack dependents, land-together group members). */
  private terminate(
    e: QueueEntry,
    state: "ejected" | "dequeued",
    reason: EjectInput | null,
    by = SYSTEM_PRINCIPAL,
    cascade = true,
  ): void {
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
      if (b.kind === "chain") {
        if (b.parentId === null) base = b.rootBase;
        else {
          const p = this.batch(b.parentId);
          base = p?.tipSha ?? null;
        }
      } else if (b.kind === "landing") {
        if (b.parentId === null) base = this.s.main.sha;
        else base = this.batch(b.parentId)?.tipSha ?? null;
      } else continue;
      if (base === null) continue;
      b.baseSha = base;
      b.state = "building";
      b.startedAt = this.now;
      const entries = ownEntries(b).map((id) => ({ changeId: id, headSha: this.entry(id)?.headSha ?? "" }));
      this.out.push({ type: "BuildBatchTree", batchId: b.id, refName: b.refName, baseSha: base, entries });
      changed = true;
    }
    return changed;
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
    const depth = (b: Batch): number => {
      const t = this.s.tracks[b.trackId ?? ""];
      return t === undefined ? 0 : t.chain.indexOf(b.id);
    };
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
   * Assign waiting entries to tracks and form speculative batches (§4.2, §4.3, §4.5, §4.6).
   *
   * Units (an entry, an atomic stack, a land-together plan group) are visited in priority order
   * (rank with aging → fair-queuing tag → arrival). A unit joins the one track it conflicts with,
   * opens a new track if it conflicts with none, and waits if it conflicts with several (those
   * tracks then take no lower-priority work until they drain) or with a waiting higher-priority unit.
   */
  private formBatches(): boolean {
    const s = this.s;
    const cfg = this.cfg;
    const frozen = isFrozen(s);
    let changed = false;
    const waiting = Object.values(s.entries).filter((e) => e.state === "waiting");
    if (waiting.length === 0) return false;

    // ---- holds
    const ready = new Map<string, QueueEntry>();
    for (const e of waiting) {
      e.hold = null;
      if (e.affected === null) e.hold = "affected";
      else if (e.approvalRequired || e.lane > e.approvedLane) e.hold = "approval";
      if (e.hold === null) ready.set(e.changeId, e);
    }
    // Dependencies: an outstanding dep must be ready (same pass) or in a chain batch.
    let progress = true;
    while (progress) {
      progress = false;
      for (const e of [...ready.values()]) {
        for (const d of e.dependsOn) {
          const de = this.entry(d);
          const ok = de !== undefined && (ready.has(d) || this.inChain(de) || de.state === "merged");
          if (!ok) {
            e.hold = "dependency";
            ready.delete(e.changeId);
            progress = true;
            break;
          }
        }
      }
      // Land-together groups: every member present and ready.
      for (const e of [...ready.values()]) {
        if (!e.landTogether || e.plangroup === null) continue;
        const group = Object.values(s.entries).filter((o) => o.plangroup === e.plangroup && o.landTogether && !isTerminal(o));
        const complete = (e.groupSize === null || group.length >= e.groupSize) && group.every((o) => ready.has(o.changeId));
        if (!complete) {
          for (const o of group)
            if (ready.delete(o.changeId)) {
              o.hold = "group";
              progress = true;
            }
          e.hold = "group";
        }
      }
    }
    if (ready.size === 0) return false;

    // ---- units: glue atomic stacks and land-together groups
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) ?? r;
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
        e.prediction = predict(s, e);
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

    // ---- in-flight counts per session (fair share of CI)
    const inFlight = new Map<string, number>();
    if (cfg.features.fairness)
      for (const e of Object.values(s.entries))
        if (e.state === "speculating" || e.state === "passed") inFlight.set(flowKey(e), (inFlight.get(flowKey(e)) ?? 0) + 1);

    // ---- frozen: express units get tracks rooted on main; conflicting normal tracks re-root.
    if (frozen) {
      for (const u of units) {
        if (!u.express) continue;
        for (const t of Object.values(s.tracks)) {
          if (t.express) continue;
          if (!this.trackConflicts(t, u.affected)) continue;
          if (this.trackInCas(t)) continue;
          this.cancelChainFrom(t, 0, "frozen: making room for a revert/incident fix");
          changed = true;
        }
      }
      if (changed) return true; // next pump pass re-plans with the re-rooted entries
    }

    // ---- placement
    const trackIndex = new ConflictIndex();
    const trackDepth = new Map<string, number>();
    const trackLen = new Map<string, number>();
    for (const t of Object.values(s.tracks)) {
      for (const id of this.chainEntries(t)) trackIndex.add(t.id, this.entry(id)?.affected ?? null);
      if (!trackIndex.has(t.id)) trackIndex.add(t.id, unknownAffectedSet());
      trackDepth.set(t.id, t.chain.filter((bid) => {
        const st = this.batch(bid)?.state;
        return st !== "passed" && st !== "landing";
      }).length);
      trackLen.set(t.id, t.chain.length);
    }
    const blocked = new ConflictIndex();
    const reserved = new Set<string>();
    const pendingFor = new Map<string, PlannedUnit[]>();
    const newTracks = new Map<string, boolean>(); // virtual id → express
    const placedIn = new Map<string, string>(); // changeId → track (this pass)
    let nVirtual = 0;
    const trackCount = (): number => Object.keys(s.tracks).length + newTracks.size;

    const place = (u: PlannedUnit): "placed" | "blocked" | "deferred" | "dep" => {
      // dependency tracks
      const depTracks = new Set<string>();
      for (const d of u.deps) {
        const de = this.entry(d);
        if (de === undefined) return "dep";
        if (placedIn.has(d)) depTracks.add(placedIn.get(d) ?? "");
        else if (this.inChain(de)) depTracks.add(de.trackId ?? "");
        else if (de.state !== "merged") return "dep";
      }
      if (cfg.features.fairness) {
        for (const [f, n] of u.flows) {
          const cur = inFlight.get(f) ?? 0;
          if (cur > 0 && cur + n > cfg.maxInFlightPerSession) return "deferred";
        }
      }
      const conflictsBlocked = cfg.features.conflictGraph ? blocked.query(u.affected).size > 0 : blocked.size > 0;
      if (conflictsBlocked && !(frozen && u.express)) return "blocked";
      let hits: Set<string>;
      if (!cfg.features.conflictGraph) hits = new Set(trackIndex.query(unknownAffectedSet()));
      else hits = trackIndex.query(u.affected);
      for (const t of depTracks) hits.add(t);
      if (frozen && u.express) {
        // Normal tracks were re-rooted above; one that is still here has a CAS in flight: wait.
        for (const h of hits) {
          const real = s.tracks[h];
          if (real !== undefined && !real.express) return "blocked";
          if (real === undefined && newTracks.get(h) !== true) return "blocked";
        }
      }
      if (hits.size > 1) {
        for (const h of hits) reserved.add(h);
        return "blocked";
      }
      if (hits.size === 1) {
        const tid = [...hits][0] ?? "";
        if (reserved.has(tid) && !(frozen && u.express)) return "blocked";
        if (!this.appendable(tid, u)) {
          reserved.add(tid);
          return "blocked";
        }
        const list = pendingFor.get(tid) ?? [];
        list.push(u);
        pendingFor.set(tid, list);
        trackIndex.add(tid, u.affected);
        for (const id of u.changeIds) placedIn.set(id, tid);
        for (const [f, n] of u.flows) inFlight.set(f, (inFlight.get(f) ?? 0) + n);
        return "placed";
      }
      if (trackCount() >= cfg.maxTracks) return "blocked";
      const tid = `+${nVirtual++}`;
      newTracks.set(tid, frozen && u.express);
      pendingFor.set(tid, [u]);
      trackIndex.add(tid, cfg.features.conflictGraph ? u.affected : unknownAffectedSet());
      for (const id of u.changeIds) placedIn.set(id, tid);
      for (const [f, n] of u.flows) inFlight.set(f, (inFlight.get(f) ?? 0) + n);
      return "placed";
    };

    let queue = units;
    for (let sweep = 0; sweep < 4 && queue.length > 0; sweep++) {
      const retry: PlannedUnit[] = [];
      for (const u of queue) {
        const r = place(u);
        if (r === "blocked") blocked.add(`u:${u.changeIds[0]}`, u.affected);
        else if (r === "dep") retry.push(u);
      }
      if (retry.length === queue.length) break;
      queue = retry;
    }

    // ---- batch formation per track
    for (const [tid, list] of pendingFor) {
      let track = s.tracks[tid];
      let depthUsed = trackDepth.get(tid) ?? 0;
      let len = trackLen.get(tid) ?? 0;
      let rest = list;
      while (rest.length > 0 && depthUsed < cfg.maxSpeculationDepth && len < cfg.maxSpeculationDepth * 3) {
        const take = this.takeBatch(rest, frozen);
        if (take.length === 0) break;
        rest = rest.slice(take.length);
        if (track === undefined) {
          const id = this.id("t");
          track = { id, chain: [], createdAt: this.now, express: newTracks.get(tid) === true };
          s.tracks[id] = track;
        }
        this.createChainBatch(track, this.orderWithinBatch(take));
        depthUsed++;
        len++;
        changed = true;
      }
    }
    return changed;
  }

  private chainEntries(t: Track): string[] {
    const out: string[] = [];
    for (const bid of t.chain) {
      const b = this.batch(bid);
      if (b !== undefined) out.push(...ownEntries(b));
    }
    return out;
  }

  private trackInCas(t: Track): boolean {
    return t.chain.some((bid) => {
      const b = this.batch(bid);
      return b !== undefined && this.batchInCas(b);
    });
  }

  private inChain(e: QueueEntry): boolean {
    if (e.batchId === null || e.trackId === null) return false;
    const t = this.s.tracks[e.trackId];
    return t !== undefined && t.chain.includes(e.batchId);
  }

  private trackConflicts(t: Track, a: AffectedSet): boolean {
    if (!this.cfg.features.conflictGraph) return true;
    for (const id of this.chainEntries(t)) if (conflicts(this.entry(id)?.affected ?? null, a)) return true;
    return false;
  }

  /**
   * Appending to a track whose chain was rooted on an older main is only allowed if nothing that
   * landed since conflicts with the unit (else its tree would miss a conflicting change).
   */
  private appendable(tid: string, u: PlannedUnit): boolean {
    const t = this.s.tracks[tid];
    if (t === undefined) return true;
    const tail = this.batch(t.chain[t.chain.length - 1] ?? null);
    if (tail === undefined) return true;
    if (tail.rootSeq === this.s.main.seq) return true;
    const first = this.s.mainLog[0];
    if (first === undefined || tail.rootSeq < first.seq) return false;
    const lineage = new Set(tail.lineage);
    for (const m of this.s.mainLog) {
      if (m.seq <= tail.rootSeq) continue;
      for (const c of m.changes) if (!lineage.has(c.changeId) && conflicts(c.affected, u.affected)) return false;
    }
    return true;
  }

  private takeBatch(pending: PlannedUnit[], frozen: boolean): PlannedUnit[] {
    const cfg = this.cfg;
    const first = pending[0];
    if (first === undefined) return [];
    if (first.isolate) return [first];
    let max: number;
    if (cfg.features.prediction) {
      const r = this.s.stats.batchPassRate;
      max = r < 0.5 ? 1 : r < 0.7 ? Math.max(1, Math.floor(cfg.maxBatchSize / 4)) : r < 0.85 ? Math.max(1, Math.floor(cfg.maxBatchSize / 2)) : cfg.maxBatchSize;
    } else max = cfg.fixedBatchSize;
    const out: PlannedUnit[] = [first];
    let size = first.changeIds.length;
    let p = first.p;
    for (const u of pending.slice(1)) {
      if (u.isolate) break;
      if (frozen && u.express !== first.express) break;
      if (size + u.changeIds.length > max) break;
      if (cfg.features.prediction && p * u.p < cfg.targetBatchPassProbability) break;
      out.push(u);
      size += u.changeIds.length;
      p *= u.p;
    }
    return out;
  }

  /** Likely failures last (prediction), stack order always respected. */
  private orderWithinBatch(units: PlannedUnit[]): PlannedUnit[] {
    if (!this.cfg.features.prediction) return units;
    const left = [...units];
    const out: PlannedUnit[] = [];
    const placed = new Set<string>();
    const inBatch = new Set(units.flatMap((u) => u.changeIds));
    while (left.length > 0) {
      let best = -1;
      for (let i = 0; i < left.length; i++) {
        const u = left[i];
        if (u === undefined) continue;
        if (u.deps.some((d) => inBatch.has(d) && !placed.has(d))) continue;
        const cur = best < 0 ? undefined : left[best];
        if (cur === undefined || u.p > cur.p) best = i;
      }
      if (best < 0) best = 0;
      const [u] = left.splice(best, 1);
      if (u === undefined) break;
      out.push(u);
      for (const id of u.changeIds) placed.add(id);
    }
    return out;
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

  private createChainBatch(t: Track, units: PlannedUnit[]): void {
    const tail = this.batch(t.chain[t.chain.length - 1] ?? null);
    const id = this.id("b");
    const own = units.flatMap((u) => u.changeIds);
    const b: Batch = {
      id,
      kind: "chain",
      trackId: t.id,
      parentId: tail?.id ?? null,
      rootBase: tail?.rootBase ?? this.s.main.sha,
      rootSeq: tail?.rootSeq ?? this.s.main.seq,
      baseSha: tail === undefined ? this.s.main.sha : tail.tipSha,
      units: units.map((u): Unit => ({ changeIds: u.changeIds })),
      lineage: [...(tail?.lineage ?? []), ...own],
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
    t.chain = [...t.chain, id];
    own.forEach((cid, position) => {
      const e = this.entry(cid);
      if (e === undefined) return;
      e.state = "speculating";
      e.batchId = id;
      e.trackId = t.id;
      e.hold = null;
      e.isolate = false;
      if (e.firstBatchAt === null) e.firstBatchAt = this.now;
      advanceVirtualTime(this.s, e);
      if (e.prediction !== null)
        this.telemetry("prediction", { changeId: cid, batchId: id, position, p: e.prediction.p, factors: e.prediction.factors, model: e.prediction.model });
      this.emit({
        type: "entered_batch",
        at: this.now,
        changeId: cid,
        batchId: id,
        trackId: t.id,
        position,
        batchSize: own.length,
        predictedPassProbability: e.prediction?.p ?? null,
      });
    });
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
    for (const [id, b] of Object.entries(s.batches))
      if (batchDone(b) && !referenced.has(id)) delete s.batches[id];
  }
}

export { InvariantViolation };
