/**
 * The core's protocol: events in (things that happened), commands out (IO the shell must do).
 *
 *   step(state, event, { now }) → { state, commands }
 *
 * The `MergeQueue` DO persists `state`, then executes `commands` (idempotently: every command
 * carries the ids its result event must echo). Results come back as events. The simulator executes
 * the same commands against a fake world. Every input event is zod-validated by the shell.
 */
import { z } from "zod";
import { QueueConfig } from "./config.js";
import {
  AffectedSet,
  ChangeId,
  EnqueuedBy,
  EvidenceSummary,
  Lane,
  LaneReason,
  LandMode,
  PriorityClass,
  QueueEvent,
  Sha,
  TestScope,
  TreeVerdict,
} from "./schema.js";

const Signer = z.object({
  principalId: z.string().min(1).max(64),
  kind: z.enum(["human", "agent", "system"]),
  /** Detached signature over the freeze/thaw document (purpose `gittifacts/audit-entry`). */
  signature: z.string().min(1).max(500),
});
export type Signer = z.infer<typeof Signer>;

// ------------------------------------------------------------------ events (inputs)

export const EnqueuedEvent = z.object({
  type: z.literal("Enqueued"),
  changeId: ChangeId,
  headSha: Sha,
  authorId: z.string().min(1).max(64),
  enqueuedBy: EnqueuedBy,
  priority: PriorityClass.default("normal"),
  /** Lane the classifier assigned on the Change's evidence. */
  lane: Lane,
  /** Highest lane covered by the approval the Change already has (defaults to `lane`). */
  approvedLane: Lane.optional(),
  /** Unmerged Changes this one is stacked on (merged ones must be left out by the shell). */
  dependsOn: z.array(ChangeId).max(50).default([]),
  landMode: LandMode.default("incremental"),
  plangroup: z.string().min(1).max(64).nullable().default(null),
  landTogether: z.boolean().default(false),
  groupSize: z.number().int().positive().max(100).nullable().default(null),
  revertOf: ChangeId.nullable().default(null),
  automaticRevert: z.boolean().default(false),
  flagKey: z.string().max(200).nullable().default(null),
  /** Already-computed affected set (else the core asks for one with `ComputeAffectedSet`). */
  affected: AffectedSet.nullable().default(null),
  size: z
    .object({ lines: z.number().int().nonnegative(), files: z.number().int().nonnegative() })
    .default({ lines: 0, files: 0 }),
  evidence: EvidenceSummary.default({ redGreen: null, coverage: null, mutationScore: null }),
});

export const CommitInfo = z.object({ changeId: ChangeId, commitSha: Sha, treeSha: Sha });

export const CoreEvent = z.discriminatedUnion("type", [
  EnqueuedEvent,
  z.object({
    type: z.literal("Dequeued"),
    changeId: ChangeId,
    by: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal("Reprioritized"),
    changeId: ChangeId,
    priority: PriorityClass,
    by: z.object({ principalId: z.string(), kind: z.enum(["human", "agent", "system"]) }),
    /** Raising to `incident` needs a human or an incident Plan. */
    incidentPlanId: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("AffectedSetComputed"),
    changeId: ChangeId,
    headSha: Sha,
    affected: AffectedSet,
  }),
  z.object({
    type: z.literal("RebaseResult"),
    batchId: z.string(),
    result: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("clean"),
        tipSha: Sha,
        treeSha: Sha,
        /** One commit per entry, in order. */
        commits: z.array(CommitInfo),
      }),
      z.object({
        status: z.literal("conflict"),
        changeId: ChangeId,
        files: z.array(z.string()).max(1000),
        /** Upstream Changes the shell found touching the conflicting hunks (best effort). */
        upstream: z.array(ChangeId).max(50).default([]),
      }),
    ]),
  }),
  z.object({
    type: z.literal("BatchResult"),
    batchId: z.string(),
    runId: z.string(),
    /** The tree the run actually tested (must equal the built tree). */
    treeSha: Sha,
    outcome: z.enum(["passed", "failed", "errored", "cancelled"]),
    /** Every required check that failed (test targets). */
    failingTests: z.array(z.string()).max(10_000).default([]),
    /** Targets the run covered. */
    scope: TestScope,
    durationMs: z.number().nonnegative().optional(),
    logRef: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("FlakeRecheckResult"),
    batchId: z.string(),
    runId: z.string(),
    results: z
      .array(
        z.object({
          test: z.string(),
          onBatch: z.enum(["passed", "failed"]),
          onMain: z.enum(["passed", "failed"]),
        }),
      )
      .max(10_000),
  }),
  z.object({
    type: z.literal("ResolutionResult"),
    changeId: ChangeId,
    attempt: z.number().int().positive(),
    resolverId: z.string().min(1).max(64),
    outcome: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("resolved"),
        newHeadSha: Sha,
        /** Lane the re-classification on the merged tree computed (the core keeps the max). */
        lane: Lane,
        laneReasons: z.array(LaneReason).default([]),
        /** The resolution touched lines outside the conflict hunks (⇒ ≥ Lane 1 + tour stop). */
        outsideHunks: z.boolean(),
        /** Upstream Change that caused the conflict (required for semantic conflicts). */
        blamedUpstream: ChangeId.nullable(),
        /** Evidence ref of the stored `ConflictResolution`. */
        resolutionRef: z.string().max(300),
        /** Affected set of the resolved head, if the resolver computed it. */
        affected: AffectedSet.nullable().default(null),
      }),
      z.object({ status: z.literal("failed"), message: z.string().max(2000) }),
      /** Semantic only: no upstream Change explains the failure; the Change itself is broken. */
      z.object({ status: z.literal("not-a-conflict"), message: z.string().max(2000) }),
      z.object({ status: z.literal("budget-exhausted"), message: z.string().max(2000) }),
    ]),
  }),
  z.object({
    type: z.literal("CasResult"),
    casId: z.string(),
    result: z.enum(["ok", "stale", "rejected"]),
    /** On stale: what main actually points at. */
    actualSha: Sha.nullable().default(null),
    detail: z.string().max(2000).default(""),
  }),
  z.object({
    /** Main moved without the queue (should never happen: the DO is the only writer). */
    type: z.literal("MainAdvanced"),
    sha: Sha,
  }),
  z.object({
    type: z.literal("PostMergeCheckFailed"),
    sha: Sha,
    checks: z.array(z.string()).max(1000),
  }),
  z.object({
    /** A revert landed (normally the core sees its own CAS; this is for recovery). */
    type: z.literal("RevertLanded"),
    changeId: ChangeId,
    sha: Sha,
  }),
  z.object({ type: z.literal("Freeze"), signer: Signer, reason: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("Thaw"), signer: Signer, reason: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal("Approved"),
    changeId: ChangeId,
    lane: Lane,
    approver: z.object({ principalId: z.string(), kind: z.enum(["human", "agent", "system"]) }),
  }),
  z.object({ type: z.literal("Unquarantined"), test: z.string(), by: z.string() }),
  z.object({ type: z.literal("Tick") }),
  z.object({ type: z.literal("ConfigUpdated"), config: QueueConfig }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
export type CoreEventInput = z.input<typeof CoreEvent>;
export type EnqueuedEvent = z.infer<typeof EnqueuedEvent>;
export type CoreEventOf<T extends CoreEvent["type"]> = Extract<CoreEvent, { type: T }>;

// ------------------------------------------------------------------ commands (outputs)

export const BuildBatchTree = z.object({
  type: z.literal("BuildBatchTree"),
  batchId: z.string(),
  /** `refs/queue/<batchId>`: written only by the DO, deleted with `DeleteQueueRef`. */
  refName: z.string(),
  baseSha: Sha,
  /** Rebase/cherry-pick these heads in order, one commit each. Stop at the first conflict. */
  entries: z.array(z.object({ changeId: ChangeId, headSha: Sha })),
});

export const StartBatchRun = z.object({
  type: z.literal("StartBatchRun"),
  batchId: z.string(),
  runId: z.string(),
  kind: z.enum(["chain", "probe", "landing"]),
  refName: z.string(),
  baseSha: Sha,
  commitSha: Sha,
  treeSha: Sha,
  entries: z.array(ChangeId),
  /** "all" required checks, or only these test targets (revalidation). */
  targets: TestScope,
});

export const LaneRaise = z.object({ changeId: ChangeId, lane: Lane, reasons: z.array(LaneReason) });
export type LaneRaise = z.infer<typeof LaneRaise>;

/** What justifies a CAS: the evidence must describe exactly the tree that lands. */
export const CasEvidence = z.object({
  /** Verdict on exactly `treeSha` (the tree main will point at). */
  verdict: TreeVerdict,
  /**
   * Revalidation: the full runs each member batch passed before it was rebased onto main, and
   * why their results carry over (`disjointFrom`: changes landed since, all disjoint).
   */
  carried: z.array(
    z.object({
      batchId: z.string(),
      verdict: TreeVerdict,
      disjointFrom: z.array(ChangeId),
    }),
  ),
  /** Quarantined tests in the entries' affected sets: recorded, never counted as passing. */
  quarantined: z.array(z.string()),
  /** Entries whose lane the queue raised (the shell re-classifies and records it). */
  laneRaises: z.array(LaneRaise),
});
export type CasEvidence = z.infer<typeof CasEvidence>;

export const AuditCommand = z.object({
  type: z.literal("Audit"),
  action: z.string().min(1).max(100),
  subject: z.string().min(1).max(200),
  principalId: z.string(),
  /** Present for human-signed events (manual freeze/thaw). */
  signature: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export const Command = z.discriminatedUnion("type", [
  BuildBatchTree,
  StartBatchRun,
  z.object({
    type: z.literal("CancelBatchRun"),
    batchId: z.string(),
    runId: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("RunFlakeRecheck"),
    batchId: z.string(),
    runId: z.string(),
    treeSha: Sha,
    commitSha: Sha,
    mainSha: Sha,
    tests: z.array(z.string()),
  }),
  z.object({
    type: z.literal("RequestResolution"),
    changeId: ChangeId,
    attempt: z.number().int().positive(),
    kind: z.enum(["textual", "semantic"]),
    headSha: Sha,
    /** Resolve onto this tree (+ `preceding` entries applied in order). */
    ontoSha: Sha,
    preceding: z.array(ChangeId),
    upstream: z.array(ChangeId),
    files: z.array(z.string()),
    failingTests: z.array(z.string()),
    /** The resolver must not be one of these principals (the Change's author). */
    excludePrincipals: z.array(z.string()),
  }),
  z.object({ type: z.literal("ComputeAffectedSet"), changeId: ChangeId, headSha: Sha }),
  z.object({
    type: z.literal("Cas"),
    casId: z.string(),
    /** Compare-and-swap: main must still point here. */
    expectedOld: Sha,
    newSha: Sha,
    treeSha: Sha,
    entries: z.array(z.object({ changeId: ChangeId, headSha: Sha, lane: Lane })),
    evidence: CasEvidence,
  }),
  z.object({ type: z.literal("DeleteQueueRef"), refName: z.string() }),
  z.object({ type: z.literal("Emit"), event: QueueEvent }),
  AuditCommand,
  z.object({
    type: z.literal("OpenPlan"),
    kind: z.literal("fix-flaky-test"),
    test: z.string(),
    title: z.string(),
    evidenceRefs: z.array(z.string()),
  }),
  z.object({
    type: z.literal("RequestApproval"),
    changeId: ChangeId,
    lane: Lane,
    reasons: z.array(LaneReason),
    /** No self-approval: neither the author nor any resolver of this Change. */
    excludePrincipals: z.array(z.string()),
  }),
  z.object({
    /** Prediction log (§4.6): predictions and outcomes, for a learned model later. Not audited. */
    type: z.literal("Telemetry"),
    kind: z.enum(["prediction", "outcome", "lane-downgrade-ignored", "rejected-event"]),
    data: z.record(z.string(), z.unknown()),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandOf<T extends Command["type"]> = Extract<Command, { type: T }>;
