/**
 * The contract between the pure core and its IO shells: the `MergeQueue` Durable Object (one per
 * repo, single writer of main and refs/queue/*) and the `BatchRunWorkflow` (one per CI run).
 *
 * Loop (DO): validate the input with `CoreEvent.parse` → `step(state, event, { now: <the wall clock> })`
 * → persist `state` in the same transaction as an outbox of `commands` → execute the outbox
 * (idempotently; every command carries the ids its result echoes) → feed results back as events.
 * If `step` throws `InvariantViolation`, persist nothing, alert, and stop processing (never "fix"
 * the state by hand). Arm an alarm ≤ 60 s while anything is live and send `Tick` on it.
 *
 * The deploy trains run the same way with `trainStep` (they may live in the same DO).
 */
import type { CommandOf, CoreEventInput } from "./protocol.js";
import type { TrainCommand, TrainEventInput } from "./trains.js";

type Emit = (event: CoreEventInput) => Promise<void>;

/** What the DO must do for each core command. Each handler eventually emits the named event(s). */
export interface QueueShell {
  /**
   * Rebase/cherry-pick `entries` (heads from the Changes' forks) one by one onto `baseSha` in the
   * main repo's object store, write `refName` (= refs/queue/<batchId>) to the tip.
   * → `RebaseResult{ clean, tipSha, treeSha, commits[] }` (one commit per entry, in order) or
   *   `RebaseResult{ conflict, changeId, files, upstream }` at the first entry that doesn't apply.
   */
  buildBatchTree(cmd: CommandOf<"BuildBatchTree">, emit: Emit): Promise<void>;
  /**
   * Start a BatchRunWorkflow (see `BatchRunWorkflowContract`) for `commitSha`.
   * → `BatchResult{ runId, treeSha, outcome, failingTests, scope }` (fail fast is allowed).
   */
  startBatchRun(cmd: CommandOf<"StartBatchRun">, emit: Emit): Promise<void>;
  /** Terminate the workflow and its containers (`CiEngine.cancel`). No result event. */
  cancelBatchRun(cmd: CommandOf<"CancelBatchRun">): Promise<void>;
  /**
   * Re-run exactly `tests` on `commitSha` AND on `mainSha` (in parallel).
   * → `FlakeRecheckResult{ runId, results: [{ test, onBatch, onMain }] }`. `__run__` = whole run.
   */
  runFlakeRecheck(cmd: CommandOf<"RunFlakeRecheck">, emit: Emit): Promise<void>;
  /**
   * Spawn the resolver agent (never a principal in `excludePrincipals`) in a sandbox with the
   * AI Gateway budget; store the resolution diff as evidence (`ConflictResolution`); re-evidence
   * and re-classify the resolved head on the merged tree.
   * → `ResolutionResult{ attempt, resolverId, outcome }` (semantic: must name `blamedUpstream`).
   */
  requestResolution(cmd: CommandOf<"RequestResolution">, emit: Emit): Promise<void>;
  /** Run the affected-set analyzer (`@app/affected`). → `AffectedSetComputed{ headSha, affected }`. */
  computeAffectedSet(cmd: CommandOf<"ComputeAffectedSet">, emit: Emit): Promise<void>;
  /**
   * Compare-and-swap refs/heads/<default> from `expectedOld` to `newSha` (receive-pack old-oid;
   * Artifacts rejects stale with "ng <ref> stale ref"). On ok: re-sign each entry's evidence for
   * `treeSha` (with `evidence`: verdict, carried runs, quarantined tests, lane raises), copy notes,
   * audit `change.merged`, re-classify the `laneRaises`. → `CasResult{ ok | stale(actualSha) | rejected }`.
   */
  cas(cmd: CommandOf<"Cas">, emit: Emit): Promise<void>;
  /** Delete refs/queue/<batchId> (idempotent; Artifacts bills per operation). */
  deleteQueueRef(cmd: CommandOf<"DeleteQueueRef">): Promise<void>;
  /** Publish a §5 event (webhooks/SSE, wake `wait_for_merge` long-polls). */
  emit(cmd: CommandOf<"Emit">): Promise<void>;
  /** Append to the hash-chained audit log (AuditLog DO); keep `signature` for human-signed events. */
  audit(cmd: CommandOf<"Audit">): Promise<void>;
  /** Open a Plan (e.g. "Fix flaky test X") assigned to the repo's agents. */
  openPlan(cmd: CommandOf<"OpenPlan">): Promise<void>;
  /** Ask a human (not in `excludePrincipals`) to approve at `lane`. → `Approved{ lane, approver }`. */
  requestApproval(cmd: CommandOf<"RequestApproval">, emit: Emit): Promise<void>;
  /** Prediction/outcome log for a learned model (not audited). */
  telemetry(cmd: CommandOf<"Telemetry">): Promise<void>;
}

/**
 * Events the shell produces on its own: `Enqueued`/`Dequeued`/`Reprioritized` (API/MCP calls,
 * after auth + zod validation + idempotency keys), `PostMergeCheckFailed` (post-merge CI on main),
 * `Freeze`/`Thaw` (human-signed), `Unquarantined` (the fix-the-test Plan landed), `MainAdvanced`
 * (reconciliation: main moved outside the queue), `Tick` (alarm), `ConfigUpdated` (policy from BASE).
 */
export type ShellOriginatedEvent = Extract<
  CoreEventInput,
  {
    type:
      | "Enqueued"
      | "Dequeued"
      | "Reprioritized"
      | "PostMergeCheckFailed"
      | "Freeze"
      | "Thaw"
      | "Unquarantined"
      | "MainAdvanced"
      | "Tick"
      | "ConfigUpdated";
  }
>;

/** The BatchRunWorkflow: one instance per `StartBatchRun.runId`, built on the existing CiEngine. */
export interface BatchRunWorkflowContract {
  /**
   * Params = the StartBatchRun command. Check out `commitSha` (refs/queue/<batchId>) from the main
   * repo, restore dependency snapshots, run the required checks (`targets === "all"`) or only the
   * listed test targets plus the pipeline's non-test steps (revalidation), and report the tested
   * tree. Report as soon as a required step fails (fail fast). Infra errors → outcome "errored".
   */
  run(
    params: CommandOf<"StartBatchRun">,
  ): Promise<Extract<CoreEventInput, { type: "BatchResult" }>>;
}

/** Deploy-train shell: Flagship, gradual deployments, Workers Issues. */
export interface TrainShell {
  /** Upload a version containing the train's Changes, deploy; → `TrainDeployed{ versionId }` or `TrainDeployFailed`. */
  startDeployTrain(
    cmd: Extract<TrainCommand, { type: "StartDeployTrain" }>,
    emit: (e: TrainEventInput) => Promise<void>,
  ): Promise<void>;
  /** `Flags.off(flagKey)`; watch telemetry → `RegressionCleared` (or nothing: the machine escalates on Tick). */
  killFlag(
    cmd: Extract<TrainCommand, { type: "KillFlag" }>,
    emit: (e: TrainEventInput) => Promise<void>,
  ): Promise<void>;
  /** Roll the Worker back to before the train → `RollbackDone`. */
  rollbackTrain(
    cmd: Extract<TrainCommand, { type: "RollbackTrain" }>,
    emit: (e: TrainEventInput) => Promise<void>,
  ): Promise<void>;
  /** Open the pure-inverse revert Change and enqueue it (`priority: "revert"`, `automaticRevert: true`). */
  requestRevert(cmd: Extract<TrainCommand, { type: "RequestRevert" }>): Promise<void>;
  /** Workers Issues webhook → `IssueReported{ worker, versionId, issueId, frames }`; merges → `ChangeMerged`. */
}
