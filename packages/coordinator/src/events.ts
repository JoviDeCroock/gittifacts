/**
 * Workflow params and the events the coordinator sends between its Workflows and Durable Objects.
 * Every event payload is validated with zod on receipt (events cross trust boundaries: the CI run
 * sink, the HTTP layer, webhooks).
 */
import { LinkedIssue, PipelineRun, RolloutPolicy } from "@app/domain";
import { Sha } from "@app/evidence";
import { z } from "zod";

// ---------------------------------------------------------------- workflow params

export const ChangeWorkflowParams = z.object({
  changeId: z.string().min(1),
  headSha: Sha,
});
export type ChangeWorkflowParams = z.infer<typeof ChangeWorkflowParams>;

export const RolloutParams = z.object({
  changeId: z.string().min(1),
  /** Bundle built for the merged sha (null → the rollout is skipped). */
  bundleRef: z.string().nullable(),
  /** The rollout policy that governed the change (read from its base). */
  rollout: RolloutPolicy,
});
export type RolloutParams = z.infer<typeof RolloutParams>;

// ---------------------------------------------------------------- ChangeWorkflow events

export const EVENT_CI_FINISHED = "ci-finished";
export const EVENT_REVIEW = "review";
export const EVENT_MERGED = "merged";
export const EVENT_MERGE_CONFLICT = "merge-conflict";
export const EVENT_ISSUE = "issue";

export const CiFinishedEvent = z.object({
  run: PipelineRun,
  /** Raw evidence items (validated one by one when the bundle is assembled). */
  items: z.array(z.unknown()).default([]),
  /** Evidence steps that produced nothing valid: their signals stay missing (→ escalate). */
  evidenceErrors: z.array(z.object({ step: z.string(), message: z.string() })).default([]),
  outputs: z
    .object({
      bundleRef: z.string().nullable().default(null),
      /** Container snapshot per passed step (`build` is what previews start from). */
      snapshots: z.record(z.string(), z.string()).default({}),
    })
    .default({ bundleRef: null, snapshots: {} }),
});
export type CiFinishedEvent = z.infer<typeof CiFinishedEvent>;

export const ReviewEvent = z.object({
  reviewId: z.string().min(1),
  headSha: Sha,
  reviewerId: z.string().min(1),
  decision: z.enum(["approve", "request-changes", "reject"]),
});
export type ReviewEvent = z.infer<typeof ReviewEvent>;

export const MergedEvent = z.object({
  mergedSha: Sha,
  /** The reviewed head when the queue had to rebase, else null. */
  rebasedFrom: Sha.nullable(),
  /** Bundle for the merged sha when the queue re-built after a rebase, else null. */
  bundleRef: z.string().nullable(),
  /**
   * `train`: the merge queue's deploy trains roll this Change out (with the others merged around
   * it); the ChangeWorkflow must not start its own RolloutWorkflow. Default: `rollout`.
   */
  deployVia: z.enum(["rollout", "train"]).default("rollout"),
});
export type MergedEvent = z.input<typeof MergedEvent>;

/**
 * The agent-native merge queue ejected the Change. Sent with the `merged` event type (the only
 * one the ChangeWorkflow waits for while queued) so the workflow wakes at once; it fails
 * `MergedEvent` validation and carries the machine-readable reason.
 */
export const QueueEjectedEvent = z.object({
  ejected: z.literal(true),
  reason: z
    .object({
      code: z.string(),
      message: z.string(),
      fix: z.object({
        explanation: z.string(),
        call: z.string().optional(),
        command: z.string().optional(),
      }),
    })
    .passthrough(),
});
export type QueueEjectedEvent = z.infer<typeof QueueEjectedEvent>;

export const MergeConflictEvent = z.object({
  reason: z.enum(["conflict", "checks-failed", "stale-exhausted", "rejected", "error"]),
  detail: z.string(),
  files: z.array(z.string()).default([]),
});
export type MergeConflictEvent = z.infer<typeof MergeConflictEvent>;

export const IssueEvent = LinkedIssue;
export type IssueEvent = LinkedIssue;
