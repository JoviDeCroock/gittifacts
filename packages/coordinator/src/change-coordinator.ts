/**
 * ChangeCoordinator logic (one instance per change). Serializes pushes, tracks the current head
 * and its ChangeWorkflow instance, supersedes older heads (terminating their workflow and
 * cancelling their CI run), tracks AI spend across heads, and garbage-collects the fork.
 *
 * Node-safe: the Durable Object class in change-coordinator-do.ts only wires storage and alarms.
 */
import type { Change, WaitUntil } from "@app/domain";
import type {
  ChangeCoordinatorClient,
  ChangeCoordinatorState,
  CoordinatorBindings,
  PushInput,
  PushOutcome,
} from "./bindings.js";
import { createOrGet, terminateQuietly } from "./bindings.js";
import { changeSubject, changeWorkflowId, isForkName, ZERO_SHA } from "./ids.js";
import { PUSHABLE_STATUSES } from "./lifecycle.js";
import { changeVersion, clampWait, type MilestoneState, milestoneState } from "./milestones.js";
import { errorMessage } from "./policy.js";
import { type Ports, SYSTEM_PRINCIPAL_ID } from "./ports.js";

/** Minimal async KV (Durable Object storage satisfies it). */
export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface AlarmScheduler {
  setAlarm(at: number): Promise<void>;
}

const STATE_KEY = "state";
const KEY_PREFIX = "idem:";

interface Waiter {
  changeId: string;
  /** "reached"/"unreachable" settles the waiter; "pending" keeps it. */
  test(change: Change | null): MilestoneState;
  settle(change: Change | null, state: MilestoneState | "timeout"): void;
}

export function emptyState(): ChangeCoordinatorState {
  return {
    changeId: null,
    forkName: null,
    headSha: null,
    instanceId: null,
    runId: null,
    spentUsd: 0,
    gcAt: null,
  };
}

export class ChangeCoordinatorCore implements ChangeCoordinatorClient {
  private chain: Promise<unknown> = Promise.resolve();
  /** Long-poll waiters live in memory: a pending RPC keeps the object alive. */
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly deps: {
      ports: Ports;
      bindings: CoordinatorBindings;
      storage: KvStorage;
      alarms: AlarmScheduler;
    },
  ) {}

  /** Run `fn` after every previously queued call (pushes interleave across awaits otherwise). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<ChangeCoordinatorState> {
    return {
      ...emptyState(),
      ...((await this.deps.storage.get<ChangeCoordinatorState>(STATE_KEY)) ?? {}),
    };
  }

  private async save(state: ChangeCoordinatorState): Promise<void> {
    await this.deps.storage.put(STATE_KEY, state);
  }

  state(_changeId: string): Promise<ChangeCoordinatorState> {
    return this.serial(() => this.load());
  }

  onPush(input: PushInput): Promise<PushOutcome> {
    return this.serial(() => this.handlePush(input));
  }

  private async handlePush(input: PushInput): Promise<PushOutcome> {
    const { ports, bindings } = this.deps;
    const { store, git, audit, clock } = ports;
    const change = await store.getChange(input.changeId);
    if (change === null) return { action: "ignored", reason: "unknown change" };
    if (!PUSHABLE_STATUSES.includes(change.status)) {
      return { action: "ignored", reason: `change is ${change.status}` };
    }
    const repo = await store.getRepo(change.repoId);
    if (repo === null) return { action: "ignored", reason: "unknown repo" };
    const branchRef = `refs/heads/${repo.defaultBranch}`;
    if (input.ref !== branchRef)
      return { action: "ignored", reason: `push to ${input.ref}, not ${branchRef}` };
    if (input.after === ZERO_SHA) return { action: "ignored", reason: "branch deleted" };

    let state = await this.load();
    state = { ...state, changeId: change.id, forkName: change.forkName };

    // Events can arrive out of order or twice: the fork's actual tip is the truth.
    const tip = (await git.branchHead(change.forkName, repo.defaultBranch)) ?? null;
    if (tip === null) return { action: "ignored", reason: "branch no longer exists" };
    if (tip === state.headSha)
      return { action: "duplicate", headSha: tip, instanceId: state.instanceId };
    if (tip === change.baseSha)
      return { action: "ignored", reason: "no commits on top of the base" };

    // Supersede the in-flight workflow for the older head.
    const superseded = state.instanceId;
    if (superseded !== null) {
      await terminateQuietly(bindings.changeWorkflow, superseded);
    }
    if (state.runId !== null) await this.supersedeRun(state.runId);
    if (change.status === "approved" || change.status === "queued") {
      await bindings
        .mergeQueue(change.repoId)
        .remove({ repoId: change.repoId, changeId: change.id });
    }

    const instanceId = changeWorkflowId(change.id, tip);
    await store.updateChange(change.id, {
      headSha: tip,
      status: "running",
      computedLane: null,
      lane: null,
      laneReasons: [],
      evidenceId: null,
      tourId: null,
    });
    await audit.append({
      principalId: SYSTEM_PRINCIPAL_ID,
      action: "change.pushed",
      subject: changeSubject(change.id),
      payload: {
        headSha: tip,
        previousHead: state.headSha,
        eventAfter: input.after,
        supersededInstance: superseded,
        at: clock.now().toISOString(),
      },
    });
    const { instance, created } = await createOrGet(bindings.changeWorkflow, instanceId, {
      changeId: change.id,
      headSha: tip,
    });
    // The same head pushed again after a different one (A → B → A): start it over.
    if (!created) await instance.restart();
    await this.save({ ...state, headSha: tip, instanceId, runId: null });
    await this.changed(change.id);
    return { action: "started", headSha: tip, instanceId, superseded };
  }

  private async supersedeRun(runId: string): Promise<void> {
    const { ci, store, clock } = this.deps.ports;
    try {
      await ci.cancel(runId, "superseded: a newer head was pushed");
    } catch {
      // Already finished or unknown to the engine: marking it superseded is still right.
    }
    const run = await store.getRun(runId);
    if (run !== null && (run.status === "queued" || run.status === "running")) {
      await store.upsertRun({
        ...run,
        status: "superseded",
        finishedAt: clock.now().toISOString(),
      });
    }
  }

  // ------------------------------------------------------------ long-polls (wait_for_change, SSE)

  private wait(
    changeId: string,
    timeoutMs: number,
    test: (change: Change | null) => MilestoneState,
  ): Promise<{ change: Change | null; state: MilestoneState | "timeout" }> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        changeId,
        test,
        settle: (change, state) => {
          if (!this.waiters.delete(waiter)) return;
          if (timer !== undefined) clearTimeout(timer);
          resolve({ change, state });
        },
      };
      this.waiters.add(waiter);
      timer = setTimeout(async () => {
        const change = await this.deps.ports.store.getChange(changeId).catch(() => null);
        waiter.settle(change, "timeout");
      }, clampWait(timeoutMs));
    });
  }

  async waitFor(input: { changeId: string; until: WaitUntil; timeoutMs: number }): Promise<{
    change: Change | null;
    reached: boolean;
    reason: "reached" | "timeout" | "unreachable";
  }> {
    const test = (change: Change | null): MilestoneState =>
      change === null ? "unreachable" : milestoneState(change, input.until);
    const now = await this.deps.ports.store.getChange(input.changeId);
    let result: { change: Change | null; state: MilestoneState | "timeout" } = {
      change: now,
      state: test(now),
    };
    if (result.state === "pending" && clampWait(input.timeoutMs) > 0) {
      result = await this.wait(input.changeId, input.timeoutMs, test);
    }
    const state = result.state === "pending" ? "timeout" : result.state;
    return { change: result.change, reached: state === "reached", reason: state };
  }

  async watch(input: { changeId: string; since: string | null; timeoutMs: number }): Promise<{
    change: Change | null;
    changed: boolean;
  }> {
    const test = (change: Change | null): MilestoneState =>
      change !== null && changeVersion(change) !== input.since ? "reached" : "pending";
    const now = await this.deps.ports.store.getChange(input.changeId);
    if (test(now) === "reached" || clampWait(input.timeoutMs) === 0) {
      return { change: now, changed: test(now) === "reached" };
    }
    const result = await this.wait(input.changeId, input.timeoutMs, test);
    return { change: result.change, changed: result.state === "reached" };
  }

  async changed(changeId: string): Promise<void> {
    const mine = [...this.waiters].filter((w) => w.changeId === changeId);
    if (mine.length === 0) return;
    const change = await this.deps.ports.store.getChange(changeId);
    for (const w of mine) {
      const state = w.test(change);
      if (state !== "pending") w.settle(change, state);
    }
  }

  // ------------------------------------------------------------ idempotency keys

  claimKey(input: { changeId: string; key: string; ttlMs: number }): Promise<boolean> {
    return this.serial(async () => {
      const storageKey = `${KEY_PREFIX}${input.key}`;
      const now = this.deps.ports.clock.now().getTime();
      const until = await this.deps.storage.get<number>(storageKey);
      if (until !== undefined && until > now) return false;
      await this.deps.storage.put(storageKey, now + Math.max(1, input.ttlMs));
      return true;
    });
  }

  releaseKey(input: { changeId: string; key: string }): Promise<void> {
    return this.serial(async () => {
      await this.deps.storage.put(`${KEY_PREFIX}${input.key}`, 0);
    });
  }

  registerRun(input: { changeId: string; instanceId: string; runId: string }): Promise<void> {
    return this.serial(async () => {
      const state = await this.load();
      if (state.instanceId !== input.instanceId) {
        // A superseded workflow raced its own termination: cancel what it started.
        await this.supersedeRun(input.runId);
        return;
      }
      await this.save({ ...state, changeId: input.changeId, runId: input.runId });
    });
  }

  recordSpend(input: { changeId: string; usd: number }): Promise<number> {
    return this.serial(async () => {
      const state = await this.load();
      const usd = Number.isFinite(input.usd) && input.usd > 0 ? input.usd : 0;
      const spentUsd = Math.round((state.spentUsd + usd) * 1e6) / 1e6;
      await this.save({ ...state, changeId: input.changeId, spentUsd });
      return spentUsd;
    });
  }

  spent(_changeId: string): Promise<number> {
    return this.serial(async () => (await this.load()).spentUsd);
  }

  abandon(changeId: string): Promise<void> {
    return this.serial(async () => {
      const state = await this.load();
      if (state.instanceId !== null)
        await terminateQuietly(this.deps.bindings.changeWorkflow, state.instanceId);
      if (state.runId !== null) await this.supersedeRun(state.runId);
      await this.save({ ...state, changeId, instanceId: null, runId: null });
    });
  }

  scheduleForkGc(input: { changeId: string; forkName: string; delayMs: number }): Promise<void> {
    return this.serial(async () => {
      if (!isForkName(input.forkName))
        throw new Error(`refusing to garbage-collect ${input.forkName}: not a fork`);
      const state = await this.load();
      const gcAt = this.deps.ports.clock.now().getTime() + Math.max(0, input.delayMs);
      await this.save({ ...state, changeId: input.changeId, forkName: input.forkName, gcAt });
      await this.deps.alarms.setAlarm(gcAt);
    });
  }

  /** Alarm handler: delete the fork when its GC time has come. Returns the next alarm, if any. */
  alarm(): Promise<number | null> {
    return this.serial(async () => {
      const state = await this.load();
      if (state.gcAt === null || state.forkName === null) return null;
      const now = this.deps.ports.clock.now().getTime();
      if (state.gcAt > now) return state.gcAt;
      const { git, audit } = this.deps.ports;
      try {
        await git.deleteRepo(state.forkName);
      } catch (e) {
        // Retry in 10 minutes; Artifacts may be busy.
        const retryAt = now + 10 * 60_000;
        await this.save({ ...state, gcAt: retryAt });
        await audit.append({
          principalId: SYSTEM_PRINCIPAL_ID,
          action: "change.fork-gc-failed",
          subject: changeSubject(state.changeId ?? "unknown"),
          payload: { forkName: state.forkName, error: errorMessage(e) },
        });
        return retryAt;
      }
      await this.save({ ...state, gcAt: null });
      await audit.append({
        principalId: SYSTEM_PRINCIPAL_ID,
        action: "change.fork-deleted",
        subject: changeSubject(state.changeId ?? "unknown"),
        payload: { forkName: state.forkName },
      });
      return null;
    });
  }
}

/** In-memory KvStorage (tests, and the node-side fake bindings). */
export class MemoryKv implements KvStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}
