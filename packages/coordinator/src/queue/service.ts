/**
 * One repo's agent-native merge queue, node-safe: what the `MergeQueue` Durable Object wraps.
 * It owns the store, the loop (core + deploy trains), the command handlers, `wait_for_merge`
 * long-polls, SSE event reads and the alarm. Public methods are the DO's RPC surface.
 */
import {
  CoreEvent,
  type CoreEventInput,
  initialState,
  initialTrainState,
  type QueueConfigInput,
  type QueueState,
  queueConfig,
  TERMINAL_STATES,
  type TrainCommand,
} from "@app/merge-queue";
import type {
  CoordinatorBindings,
  EnqueueInput,
  MergeQueueEntry,
  WorkflowHandle,
} from "../bindings.js";
import { changeSubject, newId } from "../ids.js";
import type { SqlLike } from "../merge-queue.js";
import { SqlQueueStorage } from "../merge-queue.js";
import { errorMessage } from "../policy.js";
import type { Ports } from "../ports.js";
import type { BatchRunParams } from "./batch-run.js";
import { QueueContext, type QueueIntent, type ResolverFactory } from "./context.js";
import { buildEnqueued } from "./enqueue.js";
import { failureText } from "./failure.js";
import { CoordinatorQueueShell } from "./handlers.js";
import type { QueueJobs } from "./jobs.js";
import { type HaltInfo, QueueLoop } from "./loop.js";
import { commandDropped, recentProblems } from "./problems.js";
import { type QueueStall, stallsOf } from "./stalls.js";
import { type EventRow, QueueStore, type Transact } from "./store.js";
import { CoordinatorTrainShell } from "./trains.js";

export interface MergeQueueServiceDeps {
  repoId: string;
  /** Ports for the `merge-queue` role (the only main-repo writer). */
  ports: Ports;
  bindings: CoordinatorBindings;
  sql: SqlLike;
  transact: Transact;
  jobs: QueueJobs;
  batchRuns: WorkflowHandle<BatchRunParams>;
  resolver?: ResolverFactory;
  targetsSupported?: boolean;
  /** Deploy merged Changes in trains (else: one RolloutWorkflow per Change, as before). */
  trains?: boolean;
  alarm: { get(): Promise<number | null>; set(at: number): Promise<void> };
  config?: QueueConfigInput;
}

/** The core's defaults, sized for one DO's SQLite (terminal entries and main log kept small). */
export const DO_QUEUE_CONFIG: QueueConfigInput = { retainTerminal: 200, mainLogLimit: 400 };

/** "Arm an alarm ≤ 60 s while anything is live" (shell.ts). */
export const LIVE_TICK_MS = 30_000;

interface Waiter {
  changeId: string | null;
  wake(): void;
}

export class MergeQueueService {
  readonly store: QueueStore;
  readonly ctx: QueueContext;
  readonly loop: QueueLoop;
  private readonly shell: CoordinatorQueueShell;
  private readonly trainShell: CoordinatorTrainShell;
  private waiters: Waiter[] = [];
  private ready: Promise<void> | null = null;

  constructor(private readonly deps: MergeQueueServiceDeps) {
    this.store = new QueueStore(deps.sql, deps.transact);
    let epoch = this.store.getMeta<string>("epoch");
    if (epoch === null) {
      epoch = newId().slice(0, 8);
      this.store.setMeta("epoch", epoch);
    }
    this.ctx = new QueueContext({
      repoId: deps.repoId,
      ports: deps.ports,
      bindings: deps.bindings,
      store: this.store,
      jobs: deps.jobs,
      batchRuns: deps.batchRuns,
      ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }),
      state: () => this.loop.state,
      epoch,
      targetsSupported: deps.targetsSupported === true,
      ...(deps.trains === true ? { trains: { changeMerged: (e) => this.trainMerged(e) } } : {}),
    });
    this.shell = new CoordinatorQueueShell(this.ctx);
    this.trainShell = new CoordinatorTrainShell(this.ctx);
    this.loop = new QueueLoop(
      this.store,
      {
        core: (cmd, emit) => this.shell.dispatch(cmd, emit),
        train: (cmd, emit) => this.trainShell.dispatch(cmd, emit),
        giveUp: (cmd, error) => this.shell.giveUp(cmd, error),
        onEvents: (rows) => this.wake(rows),
        onHalt: (halt) => this.alertHalt(halt),
        onDropped: async (row, failure) => {
          const cmd = row.command as TrainCommand;
          // A revert that could not be opened goes to a human (the Change is only rolled back).
          if (row.lane === "train" && cmd.type === "RequestRevert")
            await this.trainShell.revertFailed(cmd, failureText(failure)).catch(() => undefined);
          await commandDropped(this.ctx, row, failure);
        },
      },
      {
        now: () => this.ctx.now(),
        initialState: () => {
          throw new Error("merge queue state used before init()");
        },
        initialTrains: () => initialTrainState(),
      },
    );
  }

  /** Create the state on first use (main's current tip), and adopt the serial queue's items. */
  init(): Promise<void> {
    this.ready ??= this.initOnce().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async initOnce(): Promise<void> {
    if (this.store.loadState() !== null) return;
    const repo = await this.ctx.repo();
    const main = await this.ctx.ports.git.branchHead(repo.artifactsName, repo.defaultBranch);
    if (main === null)
      throw new Error(`${repo.defaultBranch} does not exist in ${repo.artifactsName}`);
    const now = this.ctx.now();
    const state = initialState(main, queueConfig({ ...DO_QUEUE_CONFIG, ...this.deps.config }), now);
    const policy = repo.policy.rollout;
    const watchMs = (policy.stages.length * policy.stageMinutes + policy.watchMinutes) * 60_000;
    this.store.commit({
      state,
      trains: initialTrainState({ watchMs: Math.max(60_000, watchMs) }),
      now,
    });
    await this.adoptSerialQueue();
  }

  /** Items the serial queue (same DO, older code) still held: admit them here, once. */
  private async adoptSerialQueue(): Promise<void> {
    let old: Awaited<ReturnType<SqlQueueStorage["list"]>> = [];
    try {
      const rows = this.deps.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merge_queue'")
        .toArray();
      if (rows.length === 0) return;
      const legacy = new SqlQueueStorage(this.deps.sql);
      old = await legacy.list();
      for (const item of old) {
        await this.admit({
          repoId: item.repoId,
          changeId: item.changeId,
          headSha: item.headSha,
          workflowInstanceId: item.workflowInstanceId,
          via: "review",
        }).catch(() => undefined);
        await legacy.delete(item.changeId);
      }
    } finally {
      if (old.length > 0)
        await this.ctx.audit(this.ctx.repoSubject(), "merge-queue.adopted-serial-items", {
          changeIds: old.map((i) => i.changeId),
        });
    }
  }

  // ------------------------------------------------------------ ChangeWorkflow side

  /** The ChangeWorkflow admits an approved (or auto-merge) head. Idempotent per head. */
  async enqueue(input: EnqueueInput): Promise<{ position: number }> {
    await this.init();
    await this.admit(input);
    await this.arm();
    const st = this.loop.state;
    const order = Object.values(st.entries).filter((e) => !TERMINAL_STATES.has(e.state));
    const index = order
      .sort((a, b) => a.seq - b.seq)
      .findIndex((e) => e.changeId === input.changeId);
    return { position: Math.max(0, index) };
  }

  private async admit(input: EnqueueInput): Promise<void> {
    const change = await this.ctx.change(input.changeId);
    const repo = await this.ctx.repo();
    const prior = this.ctx.intent(change.id);
    const intent: QueueIntent = {
      workflowInstanceId: input.workflowInstanceId,
      options: prior?.options ?? {},
      requestedBy: prior?.requestedBy ?? null,
      admittedHead: input.headSha,
      title: change.title,
      updatedAt: this.ctx.now(),
    };
    this.store.putIntent(change.id, intent);
    this.store.putHead(change.id, input.headSha, {
      replayBase: change.baseSha,
      repo: change.forkName,
    });
    const event = await buildEnqueued(this.ctx.ports, { change, repo, admission: input, intent });
    this.loop.dispatch(event);
    this.wakeAll();
  }

  /** A new push or an abandon takes the Change out (the ChangeCoordinator / facade call this). */
  async remove(input: { repoId: string; changeId: string }): Promise<boolean> {
    await this.init();
    const e = this.loop.state.entries[input.changeId];
    if (e === undefined || TERMINAL_STATES.has(e.state)) return false;
    this.loop.dispatch({ type: "Dequeued", changeId: input.changeId, by: "system" });
    this.wakeAll();
    await this.arm();
    return true;
  }

  async list(_repoId?: string): Promise<MergeQueueEntry[]> {
    await this.init();
    return Object.values(this.loop.state.entries)
      .filter((e) => !TERMINAL_STATES.has(e.state))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        changeId: e.changeId,
        headSha: e.headSha,
        phase: e.state,
        attempts: e.attempts,
        enqueuedAt: new Date(e.enqueuedAt).toISOString(),
        lastError: e.ejectReason?.message ?? null,
      }));
  }

  /** A BatchRunWorkflow's result (validated like every event; `meta` keeps the run's bundle). */
  async onQueueResult(input: { event: unknown; meta?: Record<string, unknown> }): Promise<void> {
    await this.init();
    const parsed = CoreEvent.safeParse(input.event);
    if (!parsed.success)
      throw new Error(`invalid queue result: ${parsed.error.issues[0]?.message}`);
    if ("runId" in parsed.data)
      this.store.putRun(`result:${parsed.data.runId}`, {
        bundleRef: typeof input.meta?.bundleRef === "string" ? input.meta.bundleRef : null,
        ciRunId: typeof input.meta?.ciRunId === "string" ? input.meta.ciRunId : null,
      });
    this.loop.dispatch(parsed.data);
    this.wakeAll();
    await this.arm();
  }

  /** A human approved the Change (queue re-approval after a lane raise). */
  async approved(input: {
    changeId: string;
    lane: 0 | 1 | 2;
    approver: { principalId: string; kind: "human" | "agent" | "system" };
  }): Promise<void> {
    await this.init();
    const e = this.loop.state.entries[input.changeId];
    if (e === undefined || TERMINAL_STATES.has(e.state)) return;
    this.loop.dispatch({ type: "Approved", ...input });
    const change = await this.ctx.ports.store.getChange(input.changeId);
    if (
      change?.status === "awaiting-review" &&
      !this.loop.state.entries[input.changeId]?.approvalRequired
    )
      await this.ctx.ports.store.updateChange(input.changeId, { status: "queued" });
    await this.arm();
  }

  /** Workers Issues for a version a deploy train shipped → attribution (true: a train took it). */
  async onIssue(input: {
    worker: string;
    versionId: string;
    issueId: string;
    frames: { file: string; fn?: string }[];
  }): Promise<boolean> {
    await this.init();
    const t = Object.values(this.loop.trains.trains).find((x) => x.versionId === input.versionId);
    if (t === undefined) return false;
    this.loop.dispatchTrain({ type: "IssueReported", ...input });
    await this.arm();
    return true;
  }

  private trainMerged(e: {
    changeId: string;
    sha: string;
    deploysTo: string[];
    flagKey: string | null;
    files: string[];
    modules: string[];
  }): void {
    // Idempotent per Change: check-and-mark and the dispatch are one synchronous block.
    const key = `trained:${e.changeId}`;
    if (this.store.getRun(key) !== null) return;
    this.loop.dispatchTrain({ type: "ChangeMerged", ...e });
    this.store.putRun(key, { at: this.ctx.now() });
  }

  // ------------------------------------------------------------ waiting, events, alarm

  private wake(_rows: EventRow[]): void {
    this.wakeAll();
  }

  /** Every dispatch may change what a long-poll waits for. */
  private wakeAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.wake();
  }

  /** Resolves on the next dispatched event (or after `ms`): long-polls re-check their condition. */
  awaitChange(ms: number): Promise<void> {
    return this.nextChange(ms);
  }

  /** Resolves on the next state change (or after `ms`). */
  private nextChange(ms: number, changeId: string | null = null): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve();
      }, ms);
      const waiter: Waiter = {
        changeId,
        wake: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.waiters.push(waiter);
    });
  }

  /** §5 events after `since` (SSE), waiting up to `timeoutMs` for the first one. */
  async watch(input: { since: number; timeoutMs: number; changeId?: string }): Promise<{
    events: EventRow[];
    last: number;
  }> {
    await this.init();
    const deadline = this.ctx.now() + Math.min(Math.max(0, input.timeoutMs), 55_000);
    for (;;) {
      const events = this.store.eventsSince(input.since, 200, input.changeId);
      const remaining = deadline - this.ctx.now();
      if (events.length > 0 || remaining <= 0)
        return { events, last: events[events.length - 1]?.seq ?? Math.max(input.since, 0) };
      await this.nextChange(remaining);
    }
  }

  lastEventSeq(): number {
    return this.store.lastEventSeq();
  }

  /** What is not moving right now, why, and what happens next (queue view, MCP). */
  stalls(): QueueStall[] {
    return stallsOf({
      state: this.loop.state,
      outbox: this.store.outbox(),
      problems: recentProblems(this.store),
      maxAttempts: this.loop.maxAttempts,
      now: this.ctx.now(),
    });
  }

  private alertHalt(halt: HaltInfo): Promise<void> {
    return (async () => {
      await this.ctx.audit(this.ctx.repoSubject(), "merge-queue.halted", halt);
      const anyChange = Object.keys(this.store.loadState()?.entries ?? {})[0] ?? "merge-queue";
      await this.ctx.ports.notifier.notify({
        kind: "failing",
        changeId: anyChange,
        repoId: this.deps.repoId,
        message: `The merge queue stopped: invariant ${halt.code} would break (${halt.message}). Nothing lands until an operator resumes it.`,
      });
      console.error(JSON.stringify({ mergeQueueHalted: this.deps.repoId, ...halt }));
    })().catch(() => undefined);
  }

  /** Operator action after a halt (audited by the caller). */
  async resume(by: string): Promise<void> {
    await this.init();
    const halt = this.loop.halted;
    if (halt === null) return;
    this.loop.resume();
    await this.ctx.audit(this.ctx.repoSubject(), "merge-queue.resumed", { by, halt });
    await this.arm();
  }

  private live(s: QueueState): boolean {
    if (Object.values(s.entries).some((e) => !TERMINAL_STATES.has(e.state))) return true;
    return Object.values(this.loop.trains.trains).some(
      (t) =>
        t.state === "deploying" ||
        t.state === "watching" ||
        t.state === "killing" ||
        t.state === "rolling-back",
    );
  }

  /** Make sure the alarm fires by the next due command, and every LIVE_TICK_MS while live. */
  async arm(): Promise<void> {
    const now = this.ctx.now();
    const candidates: number[] = [];
    const due = this.store.nextCommandAt();
    if (due !== null) candidates.push(Math.max(now + 1_000, due));
    if (this.store.loadState() !== null && this.live(this.loop.state))
      candidates.push(now + LIVE_TICK_MS);
    if (candidates.length === 0) return;
    const at = Math.min(...candidates);
    const current = await this.deps.alarm.get();
    if (current === null || current > at || current < now) await this.deps.alarm.set(at);
  }

  /** The DO alarm: Tick both machines, watch deploy trains, reconcile main, run the outbox. */
  async alarm(): Promise<void> {
    await this.init();
    if (this.loop.halted === null) {
      try {
        this.loop.dispatch({ type: "Tick" });
        this.loop.dispatchTrain({ type: "Tick" });
        await this.trainShell.monitor(this.loop.trains, (e) => void this.loop.dispatchTrain(e));
        await this.syncMain();
      } catch (e) {
        await this.ctx
          .audit(this.ctx.repoSubject(), "merge-queue.alarm-error", { error: errorMessage(e) })
          .catch(() => undefined);
      }
      this.loop.kick();
      this.wakeAll();
    }
    await this.arm();
  }

  /** Main moved outside the queue (should never happen: the DO is the only writer). */
  private async syncMain(): Promise<void> {
    const s = this.loop.state;
    if (s.cas !== null || !this.live(s)) return;
    const repo = await this.ctx.repo();
    const head = await this.ctx.ports.git.branchHead(repo.artifactsName, repo.defaultBranch);
    if (head !== null && head !== s.main.sha && this.loop.state.cas === null)
      this.loop.dispatch({ type: "MainAdvanced", sha: head });
  }

  /** Feed a validated shell-originated event (freeze/thaw, post-merge failures, config). */
  dispatchShellEvent(event: CoreEventInput): void {
    this.loop.dispatch(event);
    this.wakeAll();
  }

  auditChange(changeId: string, action: string, payload: unknown): Promise<void> {
    return this.ctx.audit(changeSubject(changeId), action, payload);
  }
}
