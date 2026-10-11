/**
 * Request/response schemas for the HTTP API. Domain shapes come straight from @app/domain (zod);
 * `.meta({ id })` turns them into named OpenAPI components.
 */
import {
  AuditEvent,
  Change,
  ChangeDiff,
  ChangeOverlap,
  ChangeStatus,
  ApiError as DomainApiError,
  Evidence,
  Id,
  IsoDate,
  Lane,
  LinkedIssue,
  OverlapReport,
  PipelineRun,
  Plan,
  PlanDraftInput,
  Principal,
  Repo,
  ReviewDecision,
  RolloutPolicy,
  RolloutState,
  Scope,
  StartChangeInput,
  Tour,
} from "@app/domain";
import { ConflictResolution, Sha } from "@app/evidence";
import { z } from "zod";
import { ClassifyResultSchema } from "../store/rows.js";

// ---------------------------------------------------------------- shared

/** `ApiError` from @app/domain: every error says what to do next. */
export const ErrorSchema = DomainApiError.meta({ id: "Error" });

export const PrincipalSchema = Principal.meta({ id: "Principal" });
export const RepoSchema = Repo.meta({ id: "Repo" });
export const PlanSchema = Plan.extend({
  rejectedBy: Id.nullable(),
  rejectedAt: IsoDate.nullable(),
  rejectionReason: z.string().nullable(),
}).meta({ id: "Plan" });
export const ChangeSchema = Change.meta({ id: "Change" });
export const TourSchema = Tour.meta({ id: "Tour" });
export const EvidenceSchema = Evidence.meta({ id: "Evidence" });
export const ChangeDiffSchema = ChangeDiff.meta({ id: "ChangeDiff" });
export const ChangeOverlapSchema = ChangeOverlap.meta({ id: "ChangeOverlap" });
export const OverlapReportSchema = OverlapReport.extend({
  overlaps: z.array(ChangeOverlapSchema),
}).meta({ id: "OverlapReport" });
export const PipelineRunSchema = PipelineRun.meta({ id: "PipelineRun" });
export const LinkedIssueSchema = LinkedIssue.meta({ id: "LinkedIssue" });
export const AuditEventSchema = AuditEvent.extend({
  summary: z.string().describe('Readable one-liner, e.g. "Stage 25% started"'),
}).meta({ id: "AuditEvent" });
export const ReviewDecisionSchema = ReviewDecision.meta({ id: "ReviewDecision" });
export const RolloutPolicySchema = RolloutPolicy.meta({ id: "RolloutPolicy" });

/** The merge queue's resolution of a Change: what lands instead of the pushed head. */
export const ResolutionSchema = z
  .object({
    headSha: z.string().describe("The resolved head: what lands on main"),
    originalHeadSha: z.string().nullable().describe("The head the author pushed"),
    resolvedFrom: z.string().nullable().describe("The head the resolver started from"),
    ontoSha: z.string().nullable(),
    at: IsoDate,
    attempt: z.number().int(),
    kind: z.enum(["textual", "semantic"]),
    item: ConflictResolution.nullable().describe(
      "The sealed conflict-resolution evidence item (the diff from the merge with markers)",
    ),
    upstream: z.array(
      z.object({ changeId: z.string(), title: z.string().nullable(), sha: z.string().nullable() }),
    ),
    tourId: z.string().nullable(),
    approvalRequested: z
      .boolean()
      .describe("The resolution invalidated the approval: a person must approve what lands"),
    lane: Lane.nullable(),
    reasons: z.array(z.string()),
  })
  .meta({ id: "Resolution" });

export const PrincipalRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["human", "agent", "system", "integration"]),
    ownerId: z.string().nullable(),
  })
  .meta({ id: "PrincipalRef" });

/** Names for every principal id a response mentions, so clients need no lookup per id. */
export const PrincipalsMapSchema = z
  .record(z.string(), PrincipalRefSchema)
  .meta({ id: "PrincipalsMap" });

export const PrincipalWithOwnerSchema = Principal.extend({ ownerName: z.string().optional() });
export const RolloutStateSchema = RolloutState.meta({ id: "RolloutState" });
export const ClassifyResultApiSchema = ClassifyResultSchema.meta({ id: "ClassifyResult" });

export const SessionUserSchema = z
  .object({ id: z.string(), email: z.string(), name: z.string(), image: z.string().nullable() })
  .meta({ id: "SessionUser" });

export const GitRemoteSchema = z
  .object({
    url: z.string(),
    username: z.string(),
    token: z.string(),
    expiresAt: z.string(),
    branch: z.string(),
  })
  .meta({ id: "GitRemote", description: "Short-lived push token for the change's fork only." });

export const LaneCountsSchema = z
  .object({
    lane0: z.number().int(),
    lane1: z.number().int(),
    lane2: z.number().int(),
    awaitingReview: z.number().int(),
    rollingOut: z.number().int(),
    failing: z.number().int(),
    plansAwaitingApproval: z.number().int(),
  })
  .meta({
    id: "LaneCounts",
    description:
      "lane0..lane2 count changes that have not merged yet (awaiting-push … queued) by routed lane; the rest count by status.",
  });

export const ShadowStatsSchema = z
  .object({
    samples: z
      .number()
      .int()
      .describe("Human reviews of changes the classifier computed as Lane 0."),
    agreed: z.number().int(),
    ratio: z.number().nullable().describe("agreed / samples; null when there are no samples."),
    needed: z
      .number()
      .int()
      .nullable()
      .describe(
        "More agreeing Lane-0 reviews needed before Lane 0 can be enabled (0 = eligible); null when agreement alone can never reach the threshold.",
      ),
    threshold: z.number(),
    eligibleToEnableLane0: z.boolean(),
  })
  .meta({ id: "ShadowStats" });

export const RepoSummarySchema = Repo.extend({
  counts: LaneCountsSchema,
  shadow: ShadowStatsSchema,
}).meta({
  id: "RepoSummary",
});

export const ChangeSummarySchema = Change.extend({
  planTitle: z.string().nullable(),
  authorName: z.string(),
  authorKind: z.enum(["human", "agent", "system", "integration"]),
}).meta({ id: "ChangeSummary" });

export const VerificationSchema = z
  .object({ ok: z.boolean(), keyId: z.string().optional(), reason: z.string().optional() })
  .meta({ id: "Verification" });

export const ChainStatusSchema = z
  .object({ verified: z.boolean(), brokenAt: z.number().int().optional() })
  .meta({ id: "ChainStatus" });

// ---------------------------------------------------------------- params & queries

export const RepoIdParam = z.object({ repoId: Id });
export const PlanIdParam = z.object({ planId: Id });
export const ChangeIdParam = z.object({ changeId: Id });
export const PrincipalIdParam = z.object({ id: Id });

export const ChangeListQuery = z.object({
  status: z
    .string()
    .optional()
    .describe("Comma-separated ChangeStatus values, e.g. awaiting-review,failing"),
  lane: z.enum(["0", "1", "2"]).optional(),
});

export const AuditQuery = z.object({
  subject: z.string().min(1).max(200).optional(),
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .optional()
    .describe("nextCursor from the previous page"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function parseStatusList(raw: string | undefined): ChangeStatus[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return z.array(ChangeStatus).parse(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// ---------------------------------------------------------------- bodies

export const CreateAgentBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(Scope).min(1),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

export const CreateRepoBody = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, '.', '_' and '-' only"),
  importFrom: z.string().url().startsWith("https://").optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  template: z.string().min(1).max(100).optional(),
});

export const Lane0Body = z.object({ enabled: z.boolean() });
export const DeployTargetBody = z.object({
  script: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/)
    .nullable()
    .describe(
      "Short Worker name (lowercase letters, digits, dashes; 1–39 chars); the platform deploys to `gf-<repoId>-<script>`. null clears the deploy target.",
    ),
});

export const PlanDraftBody = PlanDraftInput.meta({ id: "PlanDraftInput" });
export const ApprovePlanBody = z.object({ comment: z.string().max(10_000).optional() });
export const RejectPlanBody = z.object({ comment: z.string().min(1).max(10_000) });
export const WithdrawPlanBody = z.object({ reason: z.string().max(2000).optional() });

export const StartChangeBody = StartChangeInput.meta({ id: "StartChangeInput" });
export const ReviewBody = z.object({
  decision: z.enum(["approve", "request-changes", "reject"]),
  humanLane: Lane.optional(),
  comment: z.string().max(10_000).optional(),
  /** Bind the review to a head; defaults to the change's current head. */
  headSha: Sha.optional(),
});
export const KillBody = z.object({ reason: z.string().min(1).max(2000) });
export const RequestReviewBody = z.object({ message: z.string().max(2000).optional() });
/** `rerun_ci`: why CI runs again on the same head (audited). */
export const RerunBody = z.object({ reason: z.string().max(2000).optional() });
/** `close_change`: why the change is closed without merging (audited). */
export const CloseBody = z.object({ reason: z.string().max(2000).optional() });

/** Optional on every create/mutate call; retries with the same key are safe (onboarding §5). */
export const IdempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Client-chosen key; a retry with the same key and body replays the first response"),
});
