/** The agent-native merge queue's shell (node-safe; the DO class is in merge-queue-do.ts). */
export {
  type QueueActor,
  QueueAgentApi,
  type QueueRefusal,
  type QueueRequest,
  type QueueRequestResult,
  type QueueResult,
  type WaitForMergeResult,
} from "./agent-api.js";
export { BatchRunParams, runBatchRun, summarizeStatus } from "./batch-run.js";
export { casKey, shaKey } from "./cas.js";
export {
  QUEUE_SCRATCH_PREFIX,
  QueueContext,
  type QueueIntent,
  type ResolverFactory,
  scratchRepoFor,
} from "./context.js";
export { buildEnqueued, evidenceSummary, switchableFlag } from "./enqueue.js";
export {
  type CommandFailure,
  describeFailure,
  failureText,
  redactSecrets,
} from "./failure.js";
export { CoordinatorQueueShell } from "./handlers.js";
export { BuildResult, type QueueJobs, type ReplaySpec } from "./jobs.js";
export { type HaltInfo, QueueHaltedError, QueueLoop } from "./loop.js";
export { diffText } from "./resolve.js";
export {
  DO_QUEUE_CONFIG,
  LIVE_TICK_MS,
  MergeQueueService,
  type MergeQueueServiceDeps,
} from "./service.js";
export { type QueueProblem, type QueueStall, type StallNext, stallsOf } from "./stalls.js";
export { type EventRow, type OutboxRow, QueueStore, type Transact } from "./store.js";
export { CoordinatorTrainShell, type TrainProgress } from "./trains.js";
export {
  entryView,
  overviewView,
  type QueueEntryView,
  type QueueOverviewView,
  type TrainView,
} from "./views.js";
