/**
 * How the coordinator reaches its own Durable Objects and Workflows. `cloudflareBindings(env)`
 * builds these from real bindings; tests pass in-process fakes. Only plain, serializable values
 * cross these interfaces (they are RPC boundaries in production).
 */
import type { Change, WaitUntil } from "@app/domain";
import type { ChangeWorkflowParams, RolloutParams } from "./events.js";

// ---------------------------------------------------------------- workflows

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "rollingBack"
  | "unknown";

export interface WorkflowInstanceHandle {
  readonly id: string;
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
  terminate(): Promise<void>;
  /** Restart from the beginning (used when an old head is pushed again). */
  restart(): Promise<void>;
  status(): Promise<{ status: WorkflowRunStatus }>;
}

export interface WorkflowHandle<P> {
  /** Throws if an instance with `id` already exists. */
  create(options: { id: string; params: P }): Promise<WorkflowInstanceHandle>;
  /** Throws if there is no instance with `id`. */
  get(id: string): Promise<WorkflowInstanceHandle>;
}

// ---------------------------------------------------------------- ChangeCoordinator DO

export interface PushInput {
  changeId: string;
  ref: string;
  before: string;
  after: string;
}

export type PushOutcome =
  | { action: "started"; headSha: string; instanceId: string; superseded: string | null }
  | { action: "duplicate"; headSha: string; instanceId: string | null }
  | { action: "ignored"; reason: string };

export interface ChangeCoordinatorState {
  changeId: string | null;
  forkName: string | null;
  headSha: string | null;
  instanceId: string | null;
  runId: string | null;
  spentUsd: number;
  gcAt: number | null;
}

export interface ChangeCoordinatorClient {
  onPush(input: PushInput): Promise<PushOutcome>;
  /**
   * Start the ChangeWorkflow of a bootstrap Change (no push: its head is the repo's initial
   * commit). Idempotent: a second call finds the same instance.
   */
  startBootstrap(input: {
    changeId: string;
    headSha: string;
  }): Promise<{ instanceId: string; created: boolean }>;
  /** The ChangeWorkflow for `instanceId` started CI run `runId` (ignored if superseded). */
  registerRun(input: { changeId: string; instanceId: string; runId: string }): Promise<void>;
  /** AI spend across every head of the change; returns the new total. */
  recordSpend(input: { changeId: string; usd: number }): Promise<number>;
  spent(changeId: string): Promise<number>;
  /** Terminate the in-flight workflow and cancel its CI run. */
  abandon(changeId: string): Promise<void>;
  /** Delete the change's fork after `delayMs` (Artifacts bills per operation). */
  scheduleForkGc(input: { changeId: string; forkName: string; delayMs: number }): Promise<void>;
  state(changeId: string): Promise<ChangeCoordinatorState>;

  /** Long-poll until the change reaches `until` (see milestones.ts) or `timeoutMs` passes. */
  waitFor(input: { changeId: string; until: WaitUntil; timeoutMs: number }): Promise<{
    change: Change | null;
    reached: boolean;
    reason: "reached" | "timeout" | "unreachable";
  }>;
  /** Long-poll until the change's version (`changeVersion`) differs from `since`. */
  watch(input: { changeId: string; since: string | null; timeoutMs: number }): Promise<{
    change: Change | null;
    changed: boolean;
  }>;
  /** The change row was updated: re-check waiters. */
  changed(changeId: string): Promise<void>;
  /**
   * Idempotency for mutations on this change: true for the first caller of `key` (within
   * `ttlMs`), false for repeats. `releaseKey` undoes a claim whose operation failed.
   */
  claimKey(input: { changeId: string; key: string; ttlMs: number }): Promise<boolean>;
  releaseKey(input: { changeId: string; key: string }): Promise<void>;
}

// ---------------------------------------------------------------- MergeQueue DO

export interface EnqueueInput {
  repoId: string;
  changeId: string;
  /** The approved head; the queue drops the item if the change's head moves. */
  headSha: string;
  /** The ChangeWorkflow instance that receives `merged` / `merge-conflict`. */
  workflowInstanceId: string;
}

export interface MergeQueueEntry {
  changeId: string;
  headSha: string;
  phase: string;
  attempts: number;
  enqueuedAt: string;
  lastError: string | null;
}

export interface MergeQueueClient {
  enqueue(input: EnqueueInput): Promise<{ position: number }>;
  remove(input: { repoId: string; changeId: string }): Promise<boolean>;
  list(repoId: string): Promise<MergeQueueEntry[]>;
}

// ---------------------------------------------------------------- all together

export interface CoordinatorBindings {
  changeWorkflow: WorkflowHandle<ChangeWorkflowParams>;
  rolloutWorkflow: WorkflowHandle<RolloutParams>;
  changeCoordinator(changeId: string): ChangeCoordinatorClient;
  mergeQueue(repoId: string): MergeQueueClient;
}

/** Workflow `create` throws when the id exists; this tells that apart from real failures. */
export async function createOrGet<P>(
  wf: WorkflowHandle<P>,
  id: string,
  params: P,
): Promise<{ instance: WorkflowInstanceHandle; created: boolean }> {
  try {
    return { instance: await wf.create({ id, params }), created: true };
  } catch (createError) {
    try {
      return { instance: await wf.get(id), created: false };
    } catch {
      throw createError;
    }
  }
}

/** Best effort: an instance that is gone or finished is not an error when terminating. */
export async function terminateQuietly<P>(wf: WorkflowHandle<P>, id: string): Promise<boolean> {
  try {
    const instance = await wf.get(id);
    const { status } = await instance.status();
    if (status === "complete" || status === "errored" || status === "terminated") return false;
    await instance.terminate();
    return true;
  } catch {
    return false;
  }
}
