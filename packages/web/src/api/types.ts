/**
 * Response and request shapes from docs/api.md (HTTP API contract v1).
 * Domain types come from @app/domain and @app/evidence (type-only imports).
 *
 * Fields marked GAP are not in docs/api.md yet; the UI tolerates their absence.
 */
import type {
  AuditEvent,
  Change,
  ChangeDiff,
  ChangeDiffFile,
  ClaimedCategory,
  DiffHunk,
  DiffLine,
  LinkedIssue,
  PipelineRun,
  RunStatus,
  Evidence,
  Lane,
  LaneReason,
  Plan,
  PlanDraftInput,
  Principal,
  Repo,
  RolloutState,
  Scope,
  StartChangeInput,
  Tour,
} from "@app/domain";

export type {
  AuditEvent,
  Change,
  ChangeDiff,
  ChangeDiffFile,
  ClaimedCategory,
  DiffHunk,
  DiffLine,
  LinkedIssue,
  PipelineRun,
  RunStatus,
  Evidence,
  Lane,
  LaneReason,
  Plan,
  PlanDraftInput,
  Principal,
  Repo,
  RolloutState,
  Scope,
  StartChangeInput,
  Tour,
};
export type { EvidenceItem, EvidenceKind } from "@app/evidence";

export type PrincipalKind = Principal["kind"];

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---------------------------------------------------------------- identity

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export interface MeResponse {
  principal: Principal;
  user: SessionUser | null;
}

export interface CreateAgentInput {
  name: string;
  scopes: Scope[];
}

export interface CreateAgentResponse {
  principal: Principal;
  token: string;
}

/** GAP: a principal directory lookup. Plans, changes and audit events only carry ids. */
export interface PrincipalRef {
  id: string;
  kind: PrincipalKind;
  name: string;
  ownerId: string | null;
  ownerName?: string | null;
}

// ---------------------------------------------------------------- repos

export interface LaneCounts {
  lane0: number;
  lane1: number;
  lane2: number;
  awaitingReview: number;
  rollingOut: number;
  failing: number;
  /** Draft plans waiting for a person's approval (docs/api.md additions); older servers omit it. */
  plansAwaitingApproval?: number;
}

export interface ShadowStats {
  samples: number;
  agreed: number;
  ratio: number | null;
  /** Samples still needed before the ratio counts (interpretation; see GAP notes). */
  needed: number;
  threshold: number;
  eligibleToEnableLane0: boolean;
}

export type RepoSummary = Repo & { counts: LaneCounts; shadow: ShadowStats };

export interface RepoDetail {
  repo: Repo;
  shadow: ShadowStats;
  counts: LaneCounts;
}

// ---------------------------------------------------------------- changes

export type ChangeSummary = Change & {
  planTitle: string | null;
  authorName: string;
  authorKind: "human" | "agent";
};

/** GAP: docs/api.md names ClassifyResult without defining it. */
export interface ClassifyResult {
  lane: Lane;
  computedLane: Lane;
  reasons: LaneReason[];
}

export interface ChangeDetail {
  change: Change;
  plan: Plan | null;
  runs: PipelineRun[];
  classification: ClassifyResult | null;
}

export type DiffFile = ChangeDiffFile;
export type DiffLineKind = DiffLine["kind"];
export type DiffFileStatus = ChangeDiffFile["status"];

export interface EvidenceVerification {
  ok: boolean;
  keyId?: string;
  reason?: string;
}

export interface EvidenceResponse {
  evidence: Evidence;
  verification: EvidenceVerification;
}

export type ReviewDecisionKind = "approve" | "request-changes" | "reject";

export interface ReviewInput {
  decision: ReviewDecisionKind;
  humanLane?: Lane;
  comment?: string;
}

export interface RolloutResponse {
  rollout: RolloutState | null;
  timeline: AuditEvent[];
}

// ---------------------------------------------------------------- audit

export interface AuditQuery {
  subject?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
  chain: { verified: boolean; brokenAt?: number };
  /** GAP: names and kinds for the principals referenced by `events`. */
  principals?: Record<string, PrincipalRef>;
}

// ---------------------------------------------------------------- claimable projects (onboarding O3)

export type ClaimStatus = "unclaimed" | "claimed" | "expired";

/** `GET /api/v1/claims/{token}`: what a claim link points at. No auth needed to read it. */
export interface ClaimView {
  status: ClaimStatus;
  project: {
    id: string;
    name: string;
    template: string | null;
    createdAt: string;
    expiresAt: string | null;
    previewUrl: string | null;
  };
  createdBy: { kind: "agent"; principalId: string; name: string };
  claimedBy: { principalId: string; name: string } | null;
  claimedAt: string | null;
  /** Plain words, server-provided: what claiming does. */
  claiming: string[];
  /** Plain words, server-provided: what an unclaimed project can't do. */
  limits: string[];
  turnstile: { siteKey: string };
  /** Filled from the session cookie when there is one. */
  viewer: { signedIn: boolean; principalId: string | null; isClaimer: boolean };
}

/** `POST /api/v1/claims/{token}` body. */
export interface ClaimInput {
  turnstileToken: string;
}

/** `POST /api/v1/claims/{token}` 200. `alreadyClaimed`: this same human had claimed it before. */
export interface ClaimResult {
  status: "claimed";
  project: { id: string; name: string };
  ownerId: string;
  claimedAt: string;
  alreadyClaimed: boolean;
  next: { repoPath: string };
}
