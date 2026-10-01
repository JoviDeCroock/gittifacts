/**
 * Request/response schemas for the HTTP API. Domain shapes come straight from @app/domain (zod);
 * `.meta({ id })` turns them into named OpenAPI components.
 */
import {
  AuditEvent,
  Change,
  ChangeDiff,
  ChangeStatus,
  ApiError as DomainApiError,
  Evidence,
  Id,
  Lane,
  LinkedIssue,
  PipelineRun,
  Plan,
  PlanDraftInput,
  Principal,
  Repo,
  RolloutState,
  Scope,
  StartChangeInput,
  Tour,
} from "@app/domain";
import { Sha } from "@app/evidence";
import { z } from "zod";
import { ClassifyResultSchema } from "../store/rows.js";

// ---------------------------------------------------------------- shared

/** `ApiError` from @app/domain: every error says what to do next. */
export const ErrorSchema = DomainApiError.meta({ id: "Error" });

export const PrincipalSchema = Principal.meta({ id: "Principal" });
export const RepoSchema = Repo.meta({ id: "Repo" });
export const PlanSchema = Plan.meta({ id: "Plan" });
export const ChangeSchema = Change.meta({ id: "Change" });
export const TourSchema = Tour.meta({ id: "Tour" });
export const EvidenceSchema = Evidence.meta({ id: "Evidence" });
export const ChangeDiffSchema = ChangeDiff.meta({ id: "ChangeDiff" });
export const PipelineRunSchema = PipelineRun.meta({ id: "PipelineRun" });
export const LinkedIssueSchema = LinkedIssue.meta({ id: "LinkedIssue" });
export const AuditEventSchema = AuditEvent.meta({ id: "AuditEvent" });
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
  .meta({ id: "GitRemote", description: "Short-lived push grant for the change's fork only." });

export const LaneCountsSchema = z
  .object({
    lane0: z.number().int(),
    lane1: z.number().int(),
    lane2: z.number().int(),
    awaitingReview: z.number().int(),
    rollingOut: z.number().int(),
    failing: z.number().int(),
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
  authorKind: z.enum(["human", "agent", "system"]),
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

export const PlanDraftBody = PlanDraftInput.meta({ id: "PlanDraftInput" });
export const ApprovePlanBody = z.object({ comment: z.string().max(10_000).optional() });
export const RejectPlanBody = z.object({ comment: z.string().min(1).max(10_000) });

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

/** Optional on every create/mutate call; retries with the same key are safe (onboarding §5). */
export const IdempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Client-chosen key; a retry with the same key and body replays the first response"),
});
