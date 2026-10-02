/**
 * A small adversarial fake world for testing the pure core: it executes the core's commands with
 * outcomes derived from a hidden ground truth (bad changes, semantic pairs, textual conflicts,
 * flaky tests), completes outstanding IO in whatever order the test chooses, and checks the §1
 * invariants independently of the core's own bookkeeping.
 */
import {
  type AffectedSet,
  type Command,
  type CommandOf,
  type CoreEvent,
  type CoreEventInput,
  CoreEvent as CoreEventSchema,
  checkStateInvariants,
  conflicts,
  initialState,
  type QueueConfig,
  type QueueState,
  queueConfig,
  step,
  TERMINAL_STATES,
  WHOLE_RUN,
} from "../src/index.js";

export interface TestChange {
  id: string;
  affected: AffectedSet | null;
  /** Fails `test:<id>` on every tree containing it. */
  bad?: boolean;
  /** Changes that make this one not apply cleanly (if they're in the tree but weren't when it was authored). */
  textualWith?: string[];
  /** Fails `pair:<a>+<b>` when both are in the tree (semantic conflict), until resolved. */
  semanticWith?: string[];
  dependsOn?: string[];
  landMode?: "atomic" | "incremental";
  plangroup?: string | null;
  landTogether?: boolean;
  groupSize?: number | null;
  priority?: "revert" | "incident" | "security" | "normal";
  lane?: 0 | 1 | 2;
  session?: string;
  author?: string;
  revertOf?: string | null;
  automaticRevert?: boolean;
  flagKey?: string | null;
}

interface Pending {
  id: number;
  cmd: Command;
}

const h32 = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
};
export const sha = (s: string): string => {
  let out = "";
  for (let i = 0; i < 5; i++) out += h32(`${i}:${s}`).toString(16).padStart(8, "0");
  return out;
};

export function affected(keys: {
  files?: string[];
  modules?: string[];
  tests?: string[];
  deploysTo?: string[];
}): AffectedSet {
  return {
    files: keys.files ?? [],
    modules: keys.modules ?? [],
    testTargets: keys.tests ?? [],
    publicApi: false,
    deploysTo: keys.deploysTo ?? [],
    complete: true,
    analyzers: [],
  };
}

export interface WorldOptions {
  config?: QueueConfig;
  /** Probability a run hits a flaky failure of `flaky:<n>` (deterministic per run id). */
  flakeRate?: number;
  /** Probability the flaky test also fails on a re-check. */
  flakeRepeat?: number;
  /** Resolver: probability of success per attempt (deterministic per change/attempt). */
  resolverSuccess?: number;
  /** Resolver reports a lane lower than the entry's (the core must ignore it). */
  resolverLowersLane?: boolean;
  seed?: number;
  /** Check checkStateInvariants after every step (O(n²); fine for small tests). */
  checkInvariants?: boolean;
  /** Pass the affected set in the Enqueued event instead of answering ComputeAffectedSet. */
  precompute?: boolean;
  /** Names of the flaky tests (default flaky:0..2, always run). */
  flakyTests?: string[];
}

export class World {
  state: QueueState;
  now = 0;
  readonly changes = new Map<string, TestChange>();
  readonly version = new Map<string, number>();
  /** Head sha → change@version. */
  readonly heads = new Map<string, { id: string; v: number }>();
  /** Commit sha → content (change@version list in order) + tree sha. */
  readonly commits = new Map<string, { content: string[]; tree: string }>();
  readonly trees = new Map<string, string[]>();
  mainSha: string;
  pending: Pending[] = [];
  private nextPending = 1;
  readonly commands: Command[] = [];
  readonly merged: string[] = [];
  readonly casLog: { cas: CommandOf<"Cas">; frozen: boolean; content: string[] }[] = [];
  readonly ejected = new Map<string, string>();
  readonly dequeued = new Set<string>();
  readonly enqueued = new Set<string>();
  /** treeSha → every run on it with the tests it failed (empty = clean run). */
  readonly runs = new Map<string, { runId: string; scope: "all" | string[]; failed: string[] }[]>();
  readonly recheckPassed = new Map<string, Set<string>>();
  readonly quarantined = new Set<string>();
  readonly refs = new Set<string>();
  readonly laneHistory = new Map<string, number>();
  /** Base content each change was authored against (main content at enqueue time). */
  readonly authoredOn = new Map<string, Set<string>>();
  readonly resolvedPairs = new Set<string>();
  violations: string[] = [];
  readonly opts: Required<Omit<WorldOptions, "config">>;

  constructor(opts: WorldOptions = {}) {
    this.mainSha = sha("genesis");
    this.commits.set(this.mainSha, { content: [], tree: sha("tree:") });
    this.trees.set(sha("tree:"), []);
    this.state = initialState(this.mainSha, opts.config ?? queueConfig(), 0);
    this.opts = {
      flakeRate: opts.flakeRate ?? 0,
      flakeRepeat: opts.flakeRepeat ?? 0,
      resolverSuccess: opts.resolverSuccess ?? 1,
      resolverLowersLane: opts.resolverLowersLane ?? false,
      seed: opts.seed ?? 1,
      checkInvariants: opts.checkInvariants ?? true,
      precompute: opts.precompute ?? false,
      flakyTests: opts.flakyTests ?? ["flaky:0", "flaky:1", "flaky:2"],
    };
  }

  private rand(...parts: (string | number)[]): number {
    return h32(`${this.opts.seed}|${parts.join("|")}`) / 2 ** 32;
  }

  // ------------------------------------------------------------ driving the core

  send(input: CoreEventInput): void {
    const ev: CoreEvent = CoreEventSchema.parse(input);
    const res = step(this.state, ev, { now: this.now });
    this.state = res.state;
    // The core decides to land on the post-event state.
    const frozen = this.state.freeze.reasons.length > 0;
    for (const c of res.commands) this.accept(c, frozen);
    for (const e of Object.values(this.state.entries)) {
      const prev = this.laneHistory.get(e.changeId);
      if (prev !== undefined && e.lane < prev)
        this.violations.push(`lane of ${e.changeId} dropped ${prev} → ${e.lane}`);
      if (prev === undefined || e.lane > prev) this.laneHistory.set(e.changeId, e.lane);
    }
    if (this.opts.checkInvariants) checkStateInvariants(this.state);
  }

  enqueue(c: TestChange): void {
    this.changes.set(c.id, c);
    const v = (this.version.get(c.id) ?? 0) + 1;
    this.version.set(c.id, v);
    const head = sha(`head:${c.id}@${v}`);
    this.heads.set(head, { id: c.id, v });
    this.authoredOn.set(
      c.id,
      new Set(this.contentOf(this.mainSha).map((x) => x.split("@")[0] ?? x)),
    );
    this.enqueued.add(c.id);
    this.laneHistory.delete(c.id);
    this.send({
      type: "Enqueued",
      changeId: c.id,
      headSha: head,
      authorId: c.author ?? `agent-${c.session ?? "a"}`,
      enqueuedBy: {
        principalId: c.author ?? `agent-${c.session ?? "a"}`,
        kind: "agent",
        sessionId: c.session ?? "a",
      },
      priority: c.priority ?? "normal",
      lane: c.lane ?? 0,
      dependsOn: c.dependsOn ?? [],
      landMode: c.landMode ?? "incremental",
      plangroup: c.plangroup ?? null,
      landTogether: c.landTogether ?? false,
      groupSize: c.groupSize ?? null,
      revertOf: c.revertOf ?? null,
      automaticRevert: c.automaticRevert ?? false,
      affected: this.opts.precompute ? c.affected : null,
      size: { lines: 40, files: 2 },
      flagKey: c.flagKey ?? null,
    });
  }

  tick(ms: number): void {
    this.now += ms;
    this.send({ type: "Tick" });
  }

  // ------------------------------------------------------------ commands

  private accept(c: Command, frozenBefore: boolean): void {
    this.commands.push(c);
    switch (c.type) {
      case "Cas":
        this.checkCas(c, frozenBefore);
        this.pending.push({ id: this.nextPending++, cmd: c });
        return;
      case "BuildBatchTree":
      case "StartBatchRun":
      case "RunFlakeRecheck":
      case "RequestResolution":
      case "ComputeAffectedSet":
      case "RequestApproval":
        this.pending.push({ id: this.nextPending++, cmd: c });
        return;
      case "CancelBatchRun":
        this.pending = this.pending.filter(
          (p) =>
            !(
              (p.cmd.type === "StartBatchRun" || p.cmd.type === "RunFlakeRecheck") &&
              p.cmd.runId === c.runId
            ),
        );
        return;
      case "DeleteQueueRef":
        this.refs.delete(c.refName);
        return;
      case "Emit":
        if (c.event.type === "ejected") this.ejected.set(c.event.changeId, c.event.reason.code);
        return;
      case "Audit":
        if (c.action === "merge-queue.dequeued")
          this.dequeued.add(c.subject.slice("change:".length));
        return;
      default:
        return;
    }
  }

  /** Independent check of "main only advances to a tree that passed every required check on it". */
  private checkCas(c: CommandOf<"Cas">, frozen: boolean): void {
    const commit = this.commits.get(c.newSha);
    if (commit === undefined) {
      this.violations.push(`CAS to unknown commit ${c.newSha}`);
      return;
    }
    if (commit.tree !== c.treeSha) this.violations.push(`CAS tree mismatch for ${c.casId}`);
    // Some run on exactly this tree must be clean: no failures, or each failure re-run green on
    // this same tree, or quarantined (and recorded as such in the evidence).
    const rechecked = this.recheckPassed.get(c.treeSha) ?? new Set<string>();
    const clean = (this.runs.get(c.treeSha) ?? []).some(
      (r) =>
        (r.scope === "all" || c.evidence.verdict.scope !== "all") &&
        r.failed.every(
          (t) =>
            rechecked.has(t) || (c.evidence.quarantined.includes(t) && this.quarantined.has(t)),
        ),
    );
    if (!clean) this.violations.push(`CAS ${c.casId} to a tree with no clean run on it`);
    if (c.evidence.verdict.scope !== "all") {
      for (const m of c.evidence.carried)
        if (m.verdict.scope !== "all") this.violations.push(`carried non-full run in ${c.casId}`);
    }
    // Ground truth: the landed content must be green.
    const truth = this.realFailures(commit.content);
    if (truth.length > 0) this.violations.push(`MAIN RED via ${c.casId}: ${truth.join(", ")}`);
    if (frozen)
      for (const e of c.entries) {
        const ch = this.changes.get(e.changeId);
        if (ch?.priority !== "revert" && ch?.priority !== "incident")
          this.violations.push(`frozen queue landed non-revert ${e.changeId}`);
      }
    this.casLog.push({ cas: c, frozen, content: commit.content });
  }

  private contentOf(commitSha: string): string[] {
    return this.commits.get(commitSha)?.content ?? [];
  }

  /**
   * Symmetric relation: x lists y, or y lists x. Only pairs whose affected sets overlap (or are
   * unknown) can interact: the analyzer is sound, which is what impacted-target revalidation
   * relies on (§4.2).
   */
  related(id: string, kind: "semanticWith" | "textualWith"): string[] {
    const out = new Set(this.changes.get(id)?.[kind] ?? []);
    for (const [o, c] of this.changes) if ((c[kind] ?? []).includes(id)) out.add(o);
    const mine = this.changes.get(id)?.affected ?? null;
    return [...out].filter((o) => conflicts(mine, this.changes.get(o)?.affected ?? null));
  }

  private resolved(
    x: string,
    vx: string | number | undefined,
    y: string,
    vy: string | number | undefined,
  ): boolean {
    return this.resolvedPairs.has(`${x}@${vx}+${y}`) || this.resolvedPairs.has(`${y}@${vy}+${x}`);
  }

  /** Deterministic failures of a tree's content (bad changes, unresolved semantic pairs). */
  realFailures(content: string[]): string[] {
    const version = new Map(content.map((x) => [x.split("@")[0] ?? x, x.split("@")[1]]));
    const out: string[] = [];
    for (const [id, v] of version) {
      const ch = this.changes.get(id);
      if (ch === undefined) continue;
      if (ch.bad) out.push(`test:${id}`);
      for (const o of this.related(id, "semanticWith"))
        if (version.has(o) && !this.resolved(id, v, o, version.get(o)))
          out.push(`pair:${[id, o].sort().join("+")}`);
    }
    return [...new Set(out)];
  }

  private testsCovered(targets: "all" | string[], t: string): boolean {
    return targets === "all" || targets.includes(t) || t.startsWith("flaky:");
  }

  private isFlaky(t: string): boolean {
    return this.opts.flakyTests.includes(t);
  }

  /** Number of outstanding IO operations. */
  get outstanding(): number {
    return this.pending.length;
  }

  /** Complete the outstanding command at `index` (mod length). Returns false if none. */
  complete(index: number): boolean {
    if (this.pending.length === 0) return false;
    const i = ((index % this.pending.length) + this.pending.length) % this.pending.length;
    const [p] = this.pending.splice(i, 1);
    if (p === undefined) return false;
    this.execute(p.cmd);
    return true;
  }

  private execute(c: Command): void {
    switch (c.type) {
      case "ComputeAffectedSet": {
        const h = this.heads.get(c.headSha);
        const ch = this.changes.get(h?.id ?? c.changeId);
        if (ch === undefined) return;
        if (ch.affected === null) return; // analyzer never answers → core times out
        this.send({
          type: "AffectedSetComputed",
          changeId: c.changeId,
          headSha: c.headSha,
          affected: ch.affected,
        });
        return;
      }
      case "BuildBatchTree": {
        let parent = c.baseSha;
        let content = [...this.contentOf(c.baseSha)];
        const commits: { changeId: string; commitSha: string; treeSha: string }[] = [];
        for (const e of c.entries) {
          const h = this.heads.get(e.headSha);
          const version = new Map(content.map((x) => [x.split("@")[0] ?? x, x.split("@")[1]]));
          const authored = this.authoredOn.get(e.changeId) ?? new Set<string>();
          const blocker = this.related(e.changeId, "textualWith").find(
            (o) =>
              version.has(o) &&
              !authored.has(o) &&
              !this.resolved(e.changeId, h?.v, o, version.get(o)),
          );
          if (blocker !== undefined) {
            this.send({
              type: "RebaseResult",
              batchId: c.batchId,
              result: {
                status: "conflict",
                changeId: e.changeId,
                files: ["shared.ts"],
                upstream: [blocker],
              },
            });
            return;
          }
          content = [...content, `${e.changeId}@${h?.v ?? 0}`];
          const tree = sha(`tree:${[...content].sort().join(",")}`);
          const commitSha = sha(`commit:${parent}:${e.changeId}@${h?.v}`);
          this.commits.set(commitSha, { content, tree });
          this.trees.set(tree, content);
          commits.push({ changeId: e.changeId, commitSha, treeSha: tree });
          parent = commitSha;
        }
        const last = commits[commits.length - 1];
        if (last === undefined) return;
        this.refs.add(c.refName);
        this.send({
          type: "RebaseResult",
          batchId: c.batchId,
          result: { status: "clean", tipSha: last.commitSha, treeSha: last.treeSha, commits },
        });
        return;
      }
      case "StartBatchRun": {
        const content = this.contentOf(c.commitSha);
        const failing = this.realFailures(content).filter((t) => this.testsCovered(c.targets, t));
        if (this.rand("flake", c.runId) < this.opts.flakeRate) {
          const names = this.opts.flakyTests;
          const t = names[Math.floor(this.rand("which", c.runId) * names.length)];
          if (t !== undefined && this.testsCovered(c.targets, t) && !failing.includes(t))
            failing.push(t);
        }
        const runs = this.runs.get(c.treeSha) ?? [];
        runs.push({ runId: c.runId, scope: c.targets, failed: failing });
        this.runs.set(c.treeSha, runs);
        this.send({
          type: "BatchResult",
          batchId: c.batchId,
          runId: c.runId,
          treeSha: c.treeSha,
          outcome: failing.length > 0 ? "failed" : "passed",
          failingTests: failing,
          scope: c.targets,
          durationMs: 600_000,
        });
        return;
      }
      case "RunFlakeRecheck": {
        const real = new Set(this.realFailures(this.contentOf(c.commitSha)));
        const mainReal = new Set(this.realFailures(this.contentOf(c.mainSha)));
        const results = c.tests.map((t) => {
          const flaky = this.isFlaky(t);
          const onBatch =
            real.has(t) ||
            (flaky && this.rand("rb", c.runId, t) < this.opts.flakeRepeat) ||
            t === WHOLE_RUN
              ? "failed"
              : "passed";
          const onMain =
            mainReal.has(t) || (flaky && this.rand("rm", c.runId, t) < this.opts.flakeRepeat)
              ? "failed"
              : "passed";
          if (onBatch === "passed") {
            const s = this.recheckPassed.get(c.treeSha) ?? new Set<string>();
            s.add(t);
            this.recheckPassed.set(c.treeSha, s);
          }
          if (onBatch === "failed" && onMain === "failed") this.quarantined.add(t);
          return { test: t, onBatch, onMain } as const;
        });
        this.send({ type: "FlakeRecheckResult", batchId: c.batchId, runId: c.runId, results });
        return;
      }
      case "RequestResolution": {
        const ch = this.changes.get(c.changeId);
        if (ch === undefined) return;
        const ok = this.rand("resolve", c.changeId, c.attempt) < this.opts.resolverSuccess;
        const blamed =
          c.kind === "semantic"
            ? (this.related(c.changeId, "semanticWith").find((o) => c.upstream.includes(o)) ?? null)
            : (c.upstream[0] ?? null);
        if (c.kind === "semantic" && ch.bad) {
          this.send({
            type: "ResolutionResult",
            changeId: c.changeId,
            attempt: c.attempt,
            resolverId: "resolver-1",
            outcome: { status: "not-a-conflict", message: "the change itself fails" },
          });
          return;
        }
        if (!ok || (c.kind === "semantic" && blamed === null)) {
          this.send({
            type: "ResolutionResult",
            changeId: c.changeId,
            attempt: c.attempt,
            resolverId: "resolver-1",
            outcome: { status: "failed", message: "could not resolve" },
          });
          return;
        }
        const v = (this.version.get(c.changeId) ?? 1) + 1;
        this.version.set(c.changeId, v);
        const head = sha(`head:${c.changeId}@${v}`);
        this.heads.set(head, { id: c.changeId, v });
        for (const o of [
          ...this.related(c.changeId, "textualWith"),
          ...this.related(c.changeId, "semanticWith"),
        ])
          this.resolvedPairs.add(`${c.changeId}@${v}+${o}`);
        const lane = this.opts.resolverLowersLane ? 0 : (ch.lane ?? 0);
        this.send({
          type: "ResolutionResult",
          changeId: c.changeId,
          attempt: c.attempt,
          resolverId: "resolver-1",
          outcome: {
            status: "resolved",
            newHeadSha: head,
            lane,
            laneReasons: [],
            outsideHunks: false,
            blamedUpstream: blamed,
            resolutionRef: `res:${c.changeId}:${v}`,
            affected: ch.affected,
          },
        });
        return;
      }
      case "RequestApproval": {
        const e = this.state.entries[c.changeId];
        if (e === undefined) return;
        this.send({
          type: "Approved",
          changeId: c.changeId,
          lane: e.lane,
          approver: { principalId: "human-reviewer", kind: "human" },
        });
        return;
      }
      case "Cas": {
        if (c.expectedOld !== this.mainSha) {
          this.send({
            type: "CasResult",
            casId: c.casId,
            result: "stale",
            actualSha: this.mainSha,
          });
          return;
        }
        this.mainSha = c.newSha;
        for (const e of c.entries) this.merged.push(e.changeId);
        this.send({ type: "CasResult", casId: c.casId, result: "ok" });
        return;
      }
      default:
        return;
    }
  }

  /** Complete everything outstanding (FIFO), ticking time to fire timeouts. Returns steps used. */
  drain(maxSteps = 20_000, pick: (n: number, k: number) => number = () => 0): number {
    let k = 0;
    while (k < maxSteps) {
      if (this.pending.length > 0) {
        this.complete(pick(this.pending.length, k));
      } else {
        const live = Object.values(this.state.entries).some((e) => !TERMINAL_STATES.has(e.state));
        if (!live) break;
        this.tick(60_000);
      }
      k++;
    }
    return k;
  }
}
