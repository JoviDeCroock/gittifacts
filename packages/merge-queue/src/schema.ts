/**
 * Public domain model of the agent-native merge queue (docs/prompts/03-merge-queue.md §3, §5).
 *
 * These schemas are the contract for the API, MCP tools and UI. Times are epoch milliseconds
 * (the core is clock-free: every time comes from an event's `now`).
 */
import { ErrorFix, Lane, LaneReason } from "@app/domain";
import { z } from "zod";

export { ErrorFix, Lane, LaneReason };

/** A git object id. The core never computes one; it only compares what the shell reports. */
export const Sha = z.string().min(1).max(128);
export type Sha = z.infer<typeof Sha>;

export const ChangeId = z.string().min(1).max(64);
export type ChangeId = z.infer<typeof ChangeId>;

/** Sentinel test target: "every test" (test impact analysis fell back because coverage is missing). */
export const ALL_TESTS = "*";

/**
 * What a Change can affect (§4.1). Two Changes conflict when their affected sets share a file, a
 * module of the reverse-dependency closure, or a test target.
 *
 * `complete: false` means the analyzer could not compute the set (or timed out). An incomplete set
 * conflicts with everything: the queue never defaults to parallel. `testTargets` containing
 * `ALL_TESTS` also conflicts with everything (it shares every test target).
 */
export const AffectedSet = z.object({
  files: z.array(z.string().min(1).max(500)).max(10_000),
  modules: z.array(z.string().min(1).max(500)).max(10_000),
  testTargets: z.array(z.string().min(1).max(500)).max(10_000),
  publicApi: z.boolean(),
  deploysTo: z.array(z.string().min(1).max(100)).max(50),
  complete: z.boolean(),
});
export type AffectedSet = z.infer<typeof AffectedSet>;

/** The affected set the core assumes when it has none: conflicts with everything. */
export function unknownAffectedSet(): AffectedSet {
  return {
    files: [],
    modules: [],
    testTargets: [ALL_TESTS],
    publicApi: true,
    deploysTo: [],
    complete: false,
  };
}

/**
 * Priority classes (§4.5), highest first: reverts and incident fixes → security fixes → then by
 * lane (Lane 0 → Lane 1 → Lane 2). `normal` entries are ranked by their current lane.
 */
export const PriorityClass = z.enum(["revert", "incident", "security", "normal"]);
export type PriorityClass = z.infer<typeof PriorityClass>;

/** A stack lands as one unit (`atomic`) or member by member in order (`incremental`). */
export const LandMode = z.enum(["atomic", "incremental"]);
export type LandMode = z.infer<typeof LandMode>;

export const EntryState = z.enum([
  "waiting",
  "speculating",
  "resolving",
  "passed",
  "merged",
  "ejected",
  /** Removed by `dequeue` (not an ejection). */
  "dequeued",
]);
export type EntryState = z.infer<typeof EntryState>;

export const TERMINAL_STATES: ReadonlySet<EntryState> = new Set(["merged", "ejected", "dequeued"]);

/** Why a waiting entry is not schedulable yet. */
export const HoldReason = z.enum([
  /** The affected set is still being computed. */
  "affected",
  /** A `dependsOn` entry is not in a batch yet (or not enqueued). */
  "dependency",
  /** A land-together plan group is incomplete. */
  "group",
  /** The lane rose above what was approved (resolution / quarantine): a human must approve. */
  "approval",
]);
export type HoldReason = z.infer<typeof HoldReason>;

export const EjectCode = z.enum([
  /** The entry is the bisected culprit of a real (reproduced, not flaky) test failure. */
  "tests-failed",
  /** The entry fails only together with an upstream Change, and the resolver could not fix it. */
  "semantic-conflict",
  /** The entry no longer applies cleanly and the resolver could not resolve it. */
  "textual-conflict",
  /** The resolver ran out of AI Gateway budget. */
  "resolution-budget-exhausted",
  /** An entry this one depends on (stack) was ejected or dequeued. */
  "dependency-ejected",
  /** Another member of this entry's land-together plan group (or atomic stack) failed. */
  "group-member-failed",
  /** Repeated infrastructure errors (CI could not produce a result). */
  "infra-error",
  /** A newer head was enqueued for the same Change. */
  "superseded",
]);
export type EjectCode = z.infer<typeof EjectCode>;

/** Machine-readable ejection (§3): the `fix` tells the authoring agent exactly what to do next. */
export const EjectReason = z.object({
  code: EjectCode,
  message: z.string().min(1).max(2000),
  fix: ErrorFix,
  evidenceRefs: z.array(z.string().max(300)).max(50),
  /** Failing tests that justified the ejection, if any. */
  failingTests: z.array(z.string()).max(100).default([]),
  /** Upstream Changes involved (conflicts) or the ejected dependency. */
  upstream: z.array(ChangeId).max(50).default([]),
});
export type EjectReason = z.infer<typeof EjectReason>;

export const EnqueuedBy = z.object({
  principalId: z.string().min(1).max(64),
  kind: z.enum(["human", "agent", "system"]),
  /** Agent session (fair-share + in-flight cap key). Null for humans/system. */
  sessionId: z.string().min(1).max(100).nullable(),
});
export type EnqueuedBy = z.infer<typeof EnqueuedBy>;

/** Evidence summary used by the predictor (§4.6). Missing values only lower the estimate. */
export const EvidenceSummary = z.object({
  redGreen: z.boolean().nullable(),
  /** Changed-line coverage 0..1. */
  coverage: z.number().min(0).max(1).nullable(),
  mutationScore: z.number().min(0).max(1).nullable(),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummary>;

export const Prediction = z.object({
  /** Estimated probability the entry passes on the queue's tree. */
  p: z.number().min(0).max(1),
  /** Multiplicative factors that produced `p` (transparent heuristic). */
  factors: z.record(z.string(), z.number()),
  model: z.string(),
});
export type Prediction = z.infer<typeof Prediction>;

export const ResolutionState = z.object({
  kind: z.enum(["textual", "semantic"]),
  attempts: z.number().int().nonnegative(),
  upstream: z.array(ChangeId),
  files: z.array(z.string()),
  failingTests: z.array(z.string()),
  /** Upstream Change the resolver blamed (required for semantic conflicts). */
  blamed: ChangeId.nullable(),
  resolved: z.boolean(),
});
export type ResolutionState = z.infer<typeof ResolutionState>;

export const QueueEntry = z.object({
  changeId: ChangeId,
  headSha: Sha,
  /** The principal that authored the Change (never its resolver or approver). */
  authorId: z.string().min(1).max(64),
  enqueuedAt: z.number().int(),
  enqueuedBy: EnqueuedBy,
  /** Arrival order (FIFO tiebreak). */
  seq: z.number().int().nonnegative(),
  priority: PriorityClass,
  /** Current lane. Only ever rises (resolution, quarantine). */
  lane: Lane,
  /** Highest lane a valid approval covers. lane > approvedLane ⇒ held for approval. */
  approvedLane: Lane,
  /** Lane reasons the queue added (on top of the classifier's). */
  laneReasons: z.array(LaneReason),
  /** Outstanding stack dependencies (merged ones are removed). */
  dependsOn: z.array(ChangeId),
  landMode: LandMode,
  plangroup: z.string().min(1).max(64).nullable(),
  /** Members of a land-together group merge in one CAS or not at all. */
  landTogether: z.boolean(),
  /** Expected number of members of the plan group (null: whoever is enqueued). */
  groupSize: z.number().int().positive().nullable(),
  revertOf: ChangeId.nullable(),
  /** An automatic revert (rollout regression) puts the queue in `frozen` until it lands. */
  automaticRevert: z.boolean(),
  /** Flagship flag that switches the Change off (null: not individually switchable). */
  flagKey: z.string().max(200).nullable(),
  affected: AffectedSet.nullable(),
  affectedRequestedAt: z.number().int().nullable(),
  state: EntryState,
  hold: HoldReason.nullable(),
  /** Times this entry sat in a failing batch. */
  attempts: z.number().int().nonnegative(),
  infraErrors: z.number().int().nonnegative(),
  trackId: z.string().nullable(),
  batchId: z.string().nullable(),
  ejectReason: EjectReason.nullable(),
  resolution: ResolutionState.nullable(),
  resolverIds: z.array(z.string()),
  /** A fresh human approval is required (lane rose or the resolution touched lines outside its hunks). */
  approvalRequired: z.boolean(),
  size: z.object({ lines: z.number().int().nonnegative(), files: z.number().int().nonnegative() }),
  evidence: EvidenceSummary,
  prediction: Prediction.nullable(),
  /** Fair-queuing virtual finish tag. */
  wfqTag: z.number(),
  /** Test each unit alone after a failure (no-bisection mode). */
  isolate: z.boolean(),
  dequeueRequested: z.boolean(),
  firstBatchAt: z.number().int().nullable(),
  mergedSha: Sha.nullable(),
  terminalAt: z.number().int().nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

/** One atomic landing unit: a single entry, an atomic stack or a land-together plan group. */
export const Unit = z.object({ changeIds: z.array(ChangeId).min(1) });
export type Unit = z.infer<typeof Unit>;

export const TestScope = z.union([z.literal("all"), z.array(z.string())]);
export type TestScope = z.infer<typeof TestScope>;

/** What the core knows about one tested tree. */
export const TreeVerdict = z.object({
  treeSha: Sha,
  commitSha: Sha,
  baseSha: Sha,
  scope: TestScope,
  runIds: z.array(z.string()),
  passed: z.boolean(),
  /** Real failures (reproduced on the tree, not on main). Must be empty to land. */
  failing: z.array(z.string()),
  /** Quarantined tests: never counted as passing; recorded in the merge evidence. */
  quarantined: z.array(z.string()),
  /** Tests that failed once and passed when re-run on exactly this tree. */
  flakyRetried: z.array(z.string()),
});
export type TreeVerdict = z.infer<typeof TreeVerdict>;

export const BatchKind = z.enum([
  /** A speculative batch in a track's chain: full run on (parent tip | main) + entries. */
  "chain",
  /** A bisection probe: full run on a prefix of a failed chain batch (reuses its commits). */
  "probe",
  /** Revalidation of passed chain batches rebased onto main: impacted targets only. */
  "landing",
]);
export type BatchKind = z.infer<typeof BatchKind>;

export const BatchState = z.enum([
  "pending", // waiting for its base tree (parent not built yet)
  "building", // BuildBatchTree issued
  "ready", // tree built, waiting for a CI slot
  "running",
  "rechecking", // flake re-check in flight
  "passed",
  "landing", // CAS in flight (or member of a landing batch)
  "landed",
  "failed",
  "bisecting",
  "cancelled",
]);
export type BatchState = z.infer<typeof BatchState>;

export const Batch = z.object({
  id: z.string(),
  kind: BatchKind,
  trackId: z.string().nullable(),
  /** Chain: previous batch in the chain (null: built on `rootBase`). Landing: previous landing batch. */
  parentId: z.string().nullable(),
  /** Main sha the chain this batch belongs to was rooted on. */
  rootBase: Sha,
  rootSeq: z.number().int().nonnegative(),
  baseSha: Sha.nullable(),
  units: z.array(Unit),
  /** Every queue entry in this batch's tree on top of `rootBase` (ancestors + own), in order. */
  lineage: z.array(ChangeId),
  state: BatchState,
  tipSha: Sha.nullable(),
  treeSha: Sha.nullable(),
  /** One commit per entry, in order (bisection probes reuse prefixes of these). */
  commits: z.array(z.object({ changeId: ChangeId, commitSha: Sha, treeSha: Sha })),
  refName: z.string(),
  runId: z.string().nullable(),
  runSeq: z.number().int().nonnegative(),
  startedAt: z.number().int().nullable(),
  targets: TestScope,
  verdict: TreeVerdict.nullable(),
  /** Pending failure under re-check: the failing tests reported by the run. */
  recheck: z.object({ tests: z.array(z.string()), mainSha: Sha }).nullable(),
  bisect: z
    .object({
      lo: z.number().int().nonnegative(),
      hi: z.number().int().positive(),
      probeIds: z.array(z.string()),
      round: z.number().int().nonnegative(),
      failingTests: z.array(z.string()),
      runIds: z.array(z.string()),
    })
    .nullable(),
  probe: z.object({ of: z.string(), prefixUnits: z.number().int().positive() }).nullable(),
  /** Landing batch: the passed chain batches it revalidates, in landing order. */
  members: z.array(z.string()),
  fallbackOf: z.string().nullable(),
  /** Revalidation failed (or is impossible): the next land needs a full run on main. */
  noRevalidate: z.boolean(),
  createdAt: z.number().int(),
  readyAt: z.number().int().nullable(),
  infraRetries: z.number().int().nonnegative(),
});
export type Batch = z.infer<typeof Batch>;

export const Track = z.object({
  id: z.string(),
  /** Batches not yet landed, in landing order (head first). */
  chain: z.array(z.string()),
  createdAt: z.number().int(),
  /** Express track: revert/incident entries rooted on main while the queue is frozen. */
  express: z.boolean(),
});
export type Track = z.infer<typeof Track>;

export const FreezeReason = z.object({
  kind: z.enum(["post-merge-check", "revert-in-progress", "manual"]),
  at: z.number().int(),
  sha: Sha.nullable(),
  changeId: ChangeId.nullable(),
  signer: z.object({ principalId: z.string(), signature: z.string() }).nullable(),
  message: z.string().max(2000),
});
export type FreezeReason = z.infer<typeof FreezeReason>;

// ------------------------------------------------------------------ agent-facing events (§5)

const At = z.number().int();

export const QueueEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("entered_batch"),
    at: At,
    changeId: ChangeId,
    batchId: z.string(),
    trackId: z.string(),
    position: z.number().int().nonnegative(),
    batchSize: z.number().int().positive(),
    predictedPassProbability: z.number().min(0).max(1).nullable(),
  }),
  z.object({
    type: z.literal("resolving_conflict"),
    at: At,
    changeId: ChangeId,
    kind: z.enum(["textual", "semantic"]),
    upstream: z.array(ChangeId),
    attempt: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("resolution_ready"),
    at: At,
    changeId: ChangeId,
    newHeadSha: Sha,
    lane: Lane,
    blamedUpstream: ChangeId.nullable(),
    approvalRequired: z.boolean(),
  }),
  z.object({ type: z.literal("ejected"), at: At, changeId: ChangeId, reason: EjectReason }),
  z.object({
    type: z.literal("merged"),
    at: At,
    changeId: ChangeId,
    mergedSha: Sha,
    treeSha: Sha,
    casId: z.string(),
    timeInQueueMs: z.number().int().nonnegative(),
    lane: Lane,
    deploysTo: z.array(z.string()),
    flagKey: z.string().nullable(),
    files: z.array(z.string()),
    modules: z.array(z.string()),
  }),
  z.object({
    type: z.literal("deployed"),
    at: At,
    trainId: z.string(),
    worker: z.string(),
    versionId: z.string(),
    changeIds: z.array(ChangeId),
  }),
  z.object({
    type: z.literal("flag_killed"),
    at: At,
    trainId: z.string(),
    worker: z.string(),
    changeId: ChangeId,
    flagKey: z.string(),
    issueId: z.string(),
  }),
  z.object({ type: z.literal("frozen"), at: At, reason: FreezeReason }),
  z.object({
    type: z.literal("thawed"),
    at: At,
    by: z.string(),
    invalidatedBatches: z.number().int().nonnegative(),
  }),
]);
export type QueueEvent = z.infer<typeof QueueEvent>;
export type QueueEventType = QueueEvent["type"];
