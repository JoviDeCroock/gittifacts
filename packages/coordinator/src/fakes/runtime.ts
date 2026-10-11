/**
 * In-process stand-ins for the coordinator's own Durable Objects and Workflows:
 * - `FakeWorkflows` / `FakeWorkflowInstance`: create/get/sendEvent/terminate/restart, and they run
 *   the real workflow bodies with a `FakeStep` when given a runner;
 * - `FakeStep`: executes `do` callbacks (with retries, results cloned like the engine serializes
 *   them), resolves `sleep` immediately, and serves `waitForEvent` from buffered events;
 * - `FakeBindings`: ChangeCoordinatorCore / MergeQueueCore instances per change / repo.
 */

import type {
  ChangeCoordinatorClient,
  CoordinatorBindings,
  EnqueueInput,
  MergeQueueClient,
  WorkflowHandle,
  WorkflowInstanceHandle,
  WorkflowRunStatus,
} from "../bindings.js";
import { ChangeCoordinatorCore, MemoryKv } from "../change-coordinator.js";
import { type FlowHosts, runChangeWorkflow } from "../change-flow.js";
import type { ChangeWorkflowParams, RolloutParams } from "../events.js";
import { MemoryQueueStorage, MergeQueueCore, type MergeQueueOptions } from "../merge-queue.js";
import type { Ports } from "../ports.js";
import { type BatchRunParams, runBatchRun } from "../queue/batch-run.js";
import type { MergeQueueService } from "../queue/service.js";
import { runRollout } from "../rollout-flow.js";
import type { Duration, Step, StepConfig, StepEvent } from "../step.js";

export class TerminatedError extends Error {
  override name = "TerminatedError";
}

export class EventTimeoutError extends Error {
  override name = "WorkflowTimeoutError";
}

interface Waiter {
  type: string;
  resolve(e: StepEvent<unknown>): void;
  reject(e: Error): void;
}

export class FakeWorkflowInstance<P = unknown> implements WorkflowInstanceHandle {
  state: WorkflowRunStatus = "queued";
  readonly buffered: Array<{ type: string; payload: unknown }> = [];
  readonly received: Array<{ type: string; payload: unknown }> = [];
  readonly steps: string[] = [];
  readonly waits: string[] = [];
  output: unknown = undefined;
  error: unknown = undefined;
  restarts = 0;
  done: Promise<void> = Promise.resolve();
  private waiters: Waiter[] = [];

  constructor(
    readonly id: string,
    readonly params: P,
    private readonly runner: ((params: P, step: Step, id: string) => Promise<unknown>) | null,
    private readonly stepOptions: FakeStepOptions,
  ) {}

  start(): void {
    if (this.runner === null) return;
    this.state = "running";
    const step = new FakeStep(this, this.stepOptions);
    const runner = this.runner;
    this.done = (async () => {
      try {
        this.output = await runner(this.params, step, this.id);
        if (this.state !== "terminated") this.state = "complete";
      } catch (e) {
        this.error = e;
        if (this.state !== "terminated") this.state = "errored";
      }
    })();
  }

  async sendEvent(event: { type: string; payload: unknown }): Promise<void> {
    if (this.state === "terminated" || this.state === "complete" || this.state === "errored") {
      throw new Error(`instance ${this.id} is ${this.state}`);
    }
    const copy = structuredClone(event);
    this.received.push(copy);
    const i = this.waiters.findIndex((w) => w.type === copy.type);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      w?.resolve({ type: copy.type, payload: copy.payload, timestamp: new Date() });
    } else {
      this.buffered.push(copy);
    }
  }

  async terminate(): Promise<void> {
    this.state = "terminated";
    for (const w of this.waiters.splice(0)) w.reject(new TerminatedError(this.id));
  }

  async restart(): Promise<void> {
    this.restarts++;
    for (const w of this.waiters.splice(0)) w.reject(new TerminatedError(this.id));
    this.buffered.length = 0;
    this.steps.length = 0;
    this.start();
  }

  async status(): Promise<{ status: WorkflowRunStatus; error?: string }> {
    const status = this.waiters.length > 0 && this.state === "running" ? "waiting" : this.state;
    if (status !== "errored" || this.error === undefined) return { status };
    const e = this.error;
    return { status, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }

  /** Used by FakeStep. */
  nextEvent(type: string, timeout: boolean): Promise<StepEvent<unknown>> {
    if (this.state === "terminated") return Promise.reject(new TerminatedError(this.id));
    const i = this.buffered.findIndex((e) => e.type === type);
    if (i >= 0) {
      const [e] = this.buffered.splice(i, 1);
      return Promise.resolve({ type, payload: e?.payload, timestamp: new Date() });
    }
    if (timeout) return Promise.reject(new EventTimeoutError(`waitForEvent ${type} timed out`));
    return new Promise((resolve, reject) => this.waiters.push({ type, resolve, reject }));
  }

  get waiting(): string[] {
    return this.waiters.map((w) => w.type);
  }
}

export interface FakeStepOptions {
  /** Return true to make this wait time out immediately (when no event is buffered). */
  timeout?: (name: string, type: string) => boolean;
  /** Called with the duration of every sleep and every timed-out wait (e.g. to advance a clock). */
  onElapse?: (ms: number) => void;
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

export function durationMs(d: Duration): number {
  if (typeof d === "number") return d;
  const m = /^(\d+(?:\.\d+)?) (second|minute|hour|day|week)s?$/.exec(d);
  return m === null ? 0 : Number(m[1]) * (UNIT_MS[m[2] ?? "second"] ?? 0);
}

/** What a FakeStep needs from its instance. */
export interface StepHost {
  readonly id: string;
  readonly state: WorkflowRunStatus;
  readonly steps: string[];
  readonly waits: string[];
  nextEvent(type: string, timeout: boolean): Promise<StepEvent<unknown>>;
}

export class FakeStep implements Step {
  constructor(
    private readonly instance: StepHost,
    private readonly opts: FakeStepOptions = {},
  ) {}

  private check(): void {
    if (this.instance.state === "terminated") throw new TerminatedError(this.instance.id);
  }

  async do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T> {
    this.check();
    this.instance.steps.push(name);
    const attempts = (config.retries?.limit ?? 0) + 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      this.check();
      try {
        const result = await callback();
        this.check();
        // The engine persists step results: they must survive serialization.
        return result === undefined ? result : structuredClone(result);
      } catch (e) {
        if (e instanceof TerminatedError) throw e;
        last = e;
      }
    }
    throw last;
  }

  async sleep(name: string, duration: Duration): Promise<void> {
    this.check();
    this.instance.steps.push(name);
    this.opts.onElapse?.(durationMs(duration));
  }

  async waitForEvent<T>(
    name: string,
    options: { type: string; timeout?: Duration },
  ): Promise<StepEvent<T>> {
    this.check();
    this.instance.waits.push(name);
    const timeout = this.opts.timeout?.(name, options.type) ?? false;
    try {
      return (await this.instance.nextEvent(options.type, timeout)) as StepEvent<T>;
    } catch (e) {
      if (e instanceof EventTimeoutError)
        this.opts.onElapse?.(durationMs(options.timeout ?? "1 day"));
      throw e;
    }
  }
}

export class FakeWorkflows<P> implements WorkflowHandle<P> {
  readonly instances = new Map<string, FakeWorkflowInstance<P>>();
  runner: ((params: P, step: Step, id: string) => Promise<unknown>) | null = null;
  stepOptions: FakeStepOptions = {};

  async create(options: { id: string; params: P }): Promise<FakeWorkflowInstance<P>> {
    if (this.instances.has(options.id)) throw new Error(`instance.already_exists: ${options.id}`);
    const instance = new FakeWorkflowInstance<P>(
      options.id,
      structuredClone(options.params),
      this.runner,
      this.stepOptions,
    );
    this.instances.set(options.id, instance);
    instance.start();
    return instance;
  }

  async get(id: string): Promise<FakeWorkflowInstance<P>> {
    const instance = this.instances.get(id);
    if (instance === undefined) throw new Error(`instance.not_found: ${id}`);
    return instance;
  }

  /** Wait for every running instance body to settle. */
  async settle(): Promise<void> {
    await Promise.all([...this.instances.values()].map((i) => i.done));
  }
}

export class FakeBindings implements CoordinatorBindings {
  readonly changeWorkflow = new FakeWorkflows<ChangeWorkflowParams>();
  readonly rolloutWorkflow = new FakeWorkflows<RolloutParams>();
  readonly coordinators = new Map<string, ChangeCoordinatorCore>();
  readonly queues = new Map<string, MergeQueueCore>();
  readonly alarms: Array<{ changeId: string; at: number }> = [];
  /** Drain merge queues right after enqueue (on a macrotask). */
  autoDrain = true;
  private draining: Promise<unknown>[] = [];
  /** BatchRunWorkflow instances (agent-native queue mode). */
  readonly batchRuns = new FakeWorkflows<BatchRunParams>();
  private agentFactory: ((repoId: string) => MergeQueueService) | null = null;
  readonly agentQueues = new Map<string, MergeQueueService>();

  constructor(
    private readonly portsFor: (role: "default" | "merge-queue") => Ports,
    private readonly queueOptions: Partial<MergeQueueOptions> = { pollMs: 0 },
  ) {}

  /** Host adapters for non-native changes (GitHub mode), as the platform's runtime supplies them. */
  hosts: FlowHosts | undefined = undefined;

  /** Run the real workflow bodies inside the fake instances. */
  runWorkflows(): this {
    this.changeWorkflow.runner = (params, step, id) =>
      runChangeWorkflow(
        this.hosts === undefined
          ? { ports: this.portsFor("default"), bindings: this }
          : { ports: this.portsFor("default"), bindings: this, hosts: this.hosts },
        params,
        step,
        id,
      );
    this.rolloutWorkflow.runner = (params, step) =>
      runRollout({ ports: this.portsFor("default"), bindings: this }, params, step);
    return this;
  }

  changeCoordinator(changeId: string): ChangeCoordinatorClient {
    let core = this.coordinators.get(changeId);
    if (core === undefined) {
      core = new ChangeCoordinatorCore({
        ports: this.portsFor("default"),
        bindings: this,
        storage: new MemoryKv(),
        alarms: { setAlarm: async (at) => void this.alarms.push({ changeId, at }) },
      });
      this.coordinators.set(changeId, core);
    }
    return core;
  }

  queue(repoId: string): MergeQueueCore {
    let core = this.queues.get(repoId);
    if (core === undefined) {
      core = new MergeQueueCore({
        ports: this.portsFor("merge-queue"),
        bindings: this,
        storage: new MemoryQueueStorage(),
        options: this.queueOptions,
      });
      this.queues.set(repoId, core);
    }
    return core;
  }

  /**
   * Use the agent-native queue (`MergeQueueService`, built by `factory` per repo) instead of the
   * serial one; BatchRunWorkflow bodies run in `batchRuns` with sleeps that yield a macrotask.
   */
  useAgentQueue(factory: (repoId: string) => MergeQueueService): this {
    this.agentFactory = factory;
    this.batchRuns.runner = (params, step) =>
      runBatchRun({ ports: this.portsFor("default"), bindings: this }, params, {
        do: (name, config, cb) => step.do(name, config, cb),
        waitForEvent: (name, options) => step.waitForEvent(name, options),
        sleep: async (name, d) => {
          await step.sleep(name, d);
          await new Promise((r) => setTimeout(r, 0));
        },
      });
    return this;
  }

  agentQueue(repoId: string): MergeQueueService {
    if (this.agentFactory === null) throw new Error("useAgentQueue() first");
    let svc = this.agentQueues.get(repoId);
    if (svc === undefined) {
      svc = this.agentFactory(repoId);
      this.agentQueues.set(repoId, svc);
    }
    return svc;
  }

  mergeQueue(repoId: string): MergeQueueClient {
    if (this.agentFactory !== null) {
      const svc = this.agentQueue(repoId);
      return {
        enqueue: (input) => svc.enqueue(input),
        remove: (input) => svc.remove(input),
        list: () => svc.list(),
        onQueueResult: (input) => svc.onQueueResult(input),
        approved: (input) => svc.approved(input),
        onIssue: (input) => svc.onIssue(input),
      };
    }
    const core = this.queue(repoId);
    return {
      enqueue: async (input: EnqueueInput) => {
        const r = await core.enqueue(input);
        if (this.autoDrain) {
          const p: Promise<unknown> = new Promise((res) => setTimeout(res, 0))
            .then(() => this.drain(repoId))
            .finally(() => this.draining.splice(this.draining.indexOf(p), 1));
          this.draining.push(p);
        }
        return r;
      },
      remove: (input) => core.remove(input),
      list: (id) => core.list(id),
    };
  }

  /** Tick the repo's queue until it is idle (fake CI finishes instantly, so polls resolve fast). */
  async drain(repoId: string, maxTicks = 200): Promise<string[]> {
    const core = this.queue(repoId);
    const did: string[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const r = await core.tick();
      did.push(r.did);
      if (r.next === null) break;
      // Let fake CI runs (finished on a macrotask) make progress between polls.
      await new Promise((res) => setTimeout(res, 0));
    }
    return did;
  }

  get pendingDrains(): number {
    let busy = this.draining.length;
    for (const q of this.agentQueues.values()) busy += q.loop.busy;
    for (const i of this.batchRuns.instances.values()) if (i.state === "running") busy++;
    return busy;
  }

  async settle(): Promise<void> {
    while (this.draining.length > 0) await Promise.allSettled([...this.draining]);
    for (const q of this.agentQueues.values()) await q.loop.settle();
  }
}
