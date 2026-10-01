/**
 * `CoordinatorBindings` over real Cloudflare bindings. Typed structurally so this module stays
 * importable from node (no `cloudflare:workers` import); `Workflow<P>` and
 * `DurableObjectNamespace` satisfy these shapes.
 */
import type {
  ChangeCoordinatorClient,
  CoordinatorBindings,
  MergeQueueClient,
  WorkflowHandle,
  WorkflowInstanceHandle,
  WorkflowRunStatus,
} from "./bindings.js";
import type { ChangeWorkflowParams, RolloutParams } from "./events.js";

/**
 * wrangler binding names the coordinator expects. `COORDINATOR` is also the name the CI engine
 * uses to reach its run sink (`env.COORDINATOR.getByName(changeId).onRunFinished`), so one
 * binding to the ChangeCoordinator class serves both.
 */
export const BINDING_NAMES = {
  changeWorkflow: "CHANGE_WORKFLOW",
  rolloutWorkflow: "ROLLOUT_WORKFLOW",
  pushRouter: "PUSH_ROUTER",
  changeCoordinator: "COORDINATOR",
  mergeQueue: "MERGE_QUEUE",
} as const;

interface WorkflowInstanceLike {
  id: string;
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<{ status: string }>;
}

export interface WorkflowLike<P> {
  create(options?: { id?: string; params?: P }): Promise<WorkflowInstanceLike>;
  get(id: string): Promise<WorkflowInstanceLike>;
}

export interface NamespaceLike {
  getByName(name: string): unknown;
}

export interface CoordinatorEnv {
  CHANGE_WORKFLOW: WorkflowLike<ChangeWorkflowParams>;
  ROLLOUT_WORKFLOW: WorkflowLike<RolloutParams>;
  COORDINATOR: NamespaceLike;
  MERGE_QUEUE: NamespaceLike;
}

const STATUSES: ReadonlySet<string> = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "rollingBack",
  "unknown",
]);

function instanceHandle(i: WorkflowInstanceLike): WorkflowInstanceHandle {
  return {
    id: i.id,
    sendEvent: (event) => i.sendEvent(event),
    terminate: () => i.terminate(),
    restart: () => i.restart(),
    status: async () => {
      const { status } = await i.status();
      return { status: STATUSES.has(status) ? (status as WorkflowRunStatus) : "unknown" };
    },
  };
}

export function workflowHandle<P>(wf: WorkflowLike<P>): WorkflowHandle<P> {
  return {
    create: async ({ id, params }) => instanceHandle(await wf.create({ id, params })),
    get: async (id) => instanceHandle(await wf.get(id)),
  };
}

export function cloudflareBindings(env: CoordinatorEnv): CoordinatorBindings {
  return {
    changeWorkflow: workflowHandle(env.CHANGE_WORKFLOW),
    rolloutWorkflow: workflowHandle(env.ROLLOUT_WORKFLOW),
    // The DO classes implement exactly these client interfaces, so their RPC stubs do too.
    changeCoordinator: (changeId) =>
      env.COORDINATOR.getByName(changeId) as ChangeCoordinatorClient,
    mergeQueue: (repoId) => env.MERGE_QUEUE.getByName(repoId) as MergeQueueClient,
  };
}
