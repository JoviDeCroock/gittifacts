import { Sha, SignedEvidence } from "@app/evidence";
import { z } from "zod";
import { RepoPolicy } from "./policy.js";

export const Id = z.string().min(1).max(64);
export const IsoDate = z.string().datetime();

// ---------------------------------------------------------------- principals

export const Scope = z.enum([
  "repo:read",
  "repo:admin",
  "plan:create",
  "plan:approve",
  "change:create",
  "change:review",
  "policy:admin",
]);
export type Scope = z.infer<typeof Scope>;

export const PrincipalKey = z.object({
  id: z.string(),
  alg: z.literal("Ed25519"),
  /** base64url raw 32-byte public key */
  publicKey: z.string(),
  createdAt: IsoDate,
  revokedAt: IsoDate.nullable(),
});
export type PrincipalKey = z.infer<typeof PrincipalKey>;

export const Principal = z.object({
  id: Id,
  kind: z.enum(["human", "agent", "system"]),
  name: z.string().min(1).max(120),
  /** For agents: the human who registered and is accountable for it. */
  ownerId: Id.nullable(),
  keys: z.array(PrincipalKey),
  scopes: z.array(Scope),
  /**
   * Agents only: the repos this principal may act on. `null` (or absent) means every repo its
   * owner can access; a delegated session only gets `null` when the human picks "all repos"
   * explicitly. Humans and the system principal leave it absent.
   */
  repoIds: z.array(Id).nullable().optional(),
});
export type Principal = z.infer<typeof Principal>;

// ---------------------------------------------------------------- repos

export const Jurisdiction = z.enum(["eu", "us", "unrestricted"]);
export type Jurisdiction = z.infer<typeof Jurisdiction>;

export const Repo = z.object({
  id: Id,
  namespace: z.string(),
  artifactsName: z.string(),
  name: z.string().min(1).max(100),
  defaultBranch: z.string().default("main"),
  jurisdiction: Jurisdiction,
  importedFrom: z.string().url().nullable(),
  policy: RepoPolicy,
  /** sha of default branch the cached policy was read from */
  policySha: Sha.nullable(),
  /** Worker script the repo deploys to (for rollout), if any. */
  deployTarget: z.string().nullable(),
  /**
   * Unclaimed projects are created without an account (onboarding §4): previews only, no
   * secrets, no production deploys, no Lane 0, tight quotas, and they expire unless claimed.
   */
  claim: z.object({
    status: z.enum(["claimed", "unclaimed"]),
    /** Human principal who owns the project (null while unclaimed). */
    ownerId: Id.nullable(),
    /** Unclaimed projects are deleted after this instant. */
    expiresAt: IsoDate.nullable(),
  }),
  /** Template the project was created from, if any. */
  template: z.string().nullable(),
  createdAt: IsoDate,
});
export type Repo = z.infer<typeof Repo>;

// ---------------------------------------------------------------- plans

export const PlanStatus = z.enum(["draft", "approved", "superseded", "rejected"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const RiskDeclaration = z.object({
  area: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
});

export const Plan = z.object({
  id: Id,
  repoId: Id,
  title: z.string().min(3).max(200),
  intent: z.string().min(10).max(10_000),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(50),
  outOfScope: z.array(z.string().min(1).max(1000)).max(50),
  riskDeclarations: z.array(RiskDeclaration).max(50),
  /**
   * Globs of paths the plan expects to touch. A Change whose diff leaves this set is
   * scope drift. Empty means "not declared" which the classifier treats as unknown.
   */
  scopePaths: z.array(z.string().min(1).max(300)).max(100),
  /** Routes whose before/after screenshots belong in the tour. */
  affectedRoutes: z.array(z.string().max(300)).max(20),
  status: PlanStatus,
  authorId: Id,
  approvedBy: Id.nullable(),
  approvedAt: IsoDate.nullable(),
  /** base64url Ed25519 signature by the platform over the canonical plan + approver. */
  approvalSignature: z.string().nullable(),
  supersedes: Id.nullable(),
  createdAt: IsoDate,
});
export type Plan = z.infer<typeof Plan>;

export const PlanDraftInput = Plan.pick({
  repoId: true,
  title: true,
  intent: true,
  acceptanceCriteria: true,
  outOfScope: true,
  riskDeclarations: true,
  scopePaths: true,
  affectedRoutes: true,
}).extend({
  outOfScope: Plan.shape.outOfScope.default([]),
  riskDeclarations: Plan.shape.riskDeclarations.default([]),
  scopePaths: Plan.shape.scopePaths.default([]),
  affectedRoutes: Plan.shape.affectedRoutes.default([]),
  supersedes: Id.optional(),
});
export type PlanDraftInput = z.input<typeof PlanDraftInput>;

// ---------------------------------------------------------------- changes

/** What the author says this change is. An input to risk, never the decision. */
export const ClaimedCategory = z.enum([
  "fix",
  "feature",
  "refactor",
  "dependency",
  "transform",
  "revert",
  "docs",
  "chore",
]);
export type ClaimedCategory = z.infer<typeof ClaimedCategory>;

export const ChangeStatus = z.enum([
  "awaiting-push", // fork created, nothing pushed yet
  "running", // pipeline in flight for headSha
  "failing", // pipeline red
  "awaiting-review", // classified lane >= 1, tour ready
  "approved", // human approved the tour (or lane 0 enabled)
  "queued", // in merge queue
  "merged", // fast-forwarded main
  "rolling-out",
  "released", // watch window closed clean
  "reverted",
  "rejected",
  "abandoned",
]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export const Lane = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type Lane = z.infer<typeof Lane>;

export const LaneReason = z.object({
  /** Stable machine code, e.g. "api.breaking", "signal.missing.coverage". */
  code: z.string(),
  /** The minimum lane this reason forces. */
  lane: Lane,
  message: z.string(),
  /** Evidence item id this reason is anchored to, if any. */
  evidenceRef: z.string().optional(),
});
export type LaneReason = z.infer<typeof LaneReason>;

export const RolloutStage = z.object({
  percent: z.number().int().min(0).max(100),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
});

export const RolloutState = z.object({
  status: z.enum(["pending", "rolling", "watching", "released", "rolling-back", "rolled-back", "failed"]),
  versionId: z.string().nullable(),
  previousVersionId: z.string().nullable(),
  stages: z.array(RolloutStage),
  watchUntil: IsoDate.nullable(),
  flagKey: z.string().nullable(),
  lastCheck: z
    .object({
      at: IsoDate,
      errorRate: z.number().nullable(),
      baselineErrorRate: z.number().nullable(),
      requests: z.number().int(),
      newIssueGroups: z.number().int(),
    })
    .nullable(),
});
export type RolloutState = z.infer<typeof RolloutState>;

export const Change = z.object({
  id: Id,
  repoId: Id,
  planId: Id.nullable(),
  title: z.string().min(1).max(200),
  claim: z.object({
    category: ClaimedCategory,
    /** The author's own summary. Stored, never shown to the reviewer agent. */
    summary: z.string().max(10_000).nullable(),
  }),
  baseSha: Sha,
  headSha: Sha.nullable(),
  forkName: z.string(),
  authorId: Id,
  status: ChangeStatus,
  /** What the classifier computed, before shadow mode. */
  computedLane: Lane.nullable(),
  /** What the platform actually routes on (computed lane, raised by shadow mode). */
  lane: Lane.nullable(),
  laneReasons: z.array(LaneReason),
  evidenceId: Id.nullable(),
  tourId: Id.nullable(),
  flagKey: z.string().nullable(),
  mergedSha: Sha.nullable(),
  rolloutState: RolloutState.nullable(),
  revertOf: Id.nullable(),
  revertedBy: Id.nullable(),
  agentTraceId: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Change = z.infer<typeof Change>;

export const StartChangeInput = z.object({
  repoId: Id,
  planId: Id.optional(),
  title: z.string().min(1).max(200),
  category: ClaimedCategory,
  summary: z.string().max(10_000).optional(),
  agentTraceId: z.string().max(200).optional(),
});
export type StartChangeInput = z.input<typeof StartChangeInput>;

// ---------------------------------------------------------------- diff

export const FileDiffStat = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type FileDiffStat = z.infer<typeof FileDiffStat>;

export const DiffStats = z.object({
  baseSha: Sha,
  headSha: Sha,
  files: z.array(FileDiffStat),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffStats = z.infer<typeof DiffStats>;

export const Evidence = SignedEvidence.extend({
  id: Id,
  baseSha: Sha,
  createdAt: IsoDate,
  /** Whether the note was written to refs/notes/evidence in the repo. */
  notesWritten: z.boolean(),
});
export type Evidence = z.infer<typeof Evidence>;

// ---------------------------------------------------------------- tours

export const HunkRef = z.object({
  file: z.string(),
  /** 1-based line range on the head side (or base side for deletions). */
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  side: z.enum(["head", "base"]).default("head"),
});
export type HunkRef = z.infer<typeof HunkRef>;

export const TourVerdict = z.enum(["proven", "unproven", "risk"]);
export type TourVerdict = z.infer<typeof TourVerdict>;

/** "transform" and "resolution" (a merge-queue conflict resolution) are written by the platform only. */
export const TourStopKind = z.enum([
  "intent",
  "behavior",
  "risk",
  "proof",
  "uncovered",
  "transform",
  "resolution",
  "other",
]);

export const TourStop = z.object({
  kind: TourStopKind,
  title: z.string().min(1).max(160),
  why: z.string().min(1).max(1200),
  hunkRefs: z.array(HunkRef).max(20),
  evidenceRefs: z.array(z.string()).max(20),
  verdict: TourVerdict,
});
export type TourStop = z.infer<typeof TourStop>;

export const Tour = z.object({
  id: Id,
  changeId: Id,
  headSha: Sha,
  stops: z.array(TourStop).min(1).max(15),
  leastConfident: z.array(z.string().min(1).max(600)).min(1).max(10),
  notDone: z.array(z.string().min(1).max(600)).min(1).max(10),
  generatedBy: z.object({
    principalId: Id,
    model: z.string(),
    promptVersion: z.string(),
    attempts: z.number().int().min(1),
    costUsd: z.number().min(0),
  }),
  createdAt: IsoDate,
});
export type Tour = z.infer<typeof Tour>;

// ---------------------------------------------------------------- reviews & shadow

export const ReviewDecision = z.object({
  id: Id,
  changeId: Id,
  headSha: Sha,
  reviewerId: Id,
  decision: z.enum(["approve", "request-changes", "reject"]),
  /** What lane the human thinks this deserved, if they said. */
  humanLane: Lane.nullable(),
  computedLane: Lane,
  comment: z.string().max(10_000).nullable(),
  createdAt: IsoDate,
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

// ---------------------------------------------------------------- audit

export const AuditEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: IsoDate,
  principalId: Id,
  action: z.string().min(1).max(100),
  /** e.g. "change:abc", "plan:xyz", "repo:r1" */
  subject: z.string().min(1).max(200),
  /** base64url SHA-256 of canonical JSON payload */
  payloadHash: z.string(),
  /** hash of previous event (genesis: 43 x "A") */
  prevHash: z.string(),
  /** base64url SHA-256 over canonical {seq, at, principalId, action, subject, payloadHash, prevHash} */
  hash: z.string(),
  /** platform Ed25519 signature over `hash` */
  signature: z.string(),
  keyId: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// ---------------------------------------------------------------- diffs & runs (API shapes)

export const DiffLine = z.object({
  kind: z.enum(["add", "del", "ctx"]),
  oldNo: z.number().int().positive().nullable(),
  newNo: z.number().int().positive().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const ChangeDiffFile = FileDiffStat.extend({
  /** Every hunk of this file was reproduced by a verified transform. */
  transformVerified: z.boolean(),
  /** Hunks are omitted for binary or very large files. */
  hunks: z.array(DiffHunk),
  truncated: z.boolean(),
});
export type ChangeDiffFile = z.infer<typeof ChangeDiffFile>;

export const ChangeDiff = z.object({
  baseSha: Sha,
  headSha: Sha,
  files: z.array(ChangeDiffFile),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangeDiff = z.infer<typeof ChangeDiff>;

export function diffStatsOf(diff: ChangeDiff): DiffStats {
  return {
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    additions: diff.additions,
    deletions: diff.deletions,
    files: diff.files.map(({ transformVerified: _t, hunks: _h, truncated: _x, ...stat }) => stat),
  };
}

export const RunStatus = z.enum(["queued", "running", "passed", "failed", "cancelled", "superseded", "errored"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const PipelineRun = z.object({
  id: Id,
  changeId: Id,
  headSha: Sha,
  engine: z.enum(["cloudflare-ci", "workflows"]),
  status: RunStatus,
  startedAt: IsoDate.nullable(),
  finishedAt: IsoDate.nullable(),
  steps: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["user", "evidence"]),
      status: z.enum(["pending", "running", "passed", "failed", "skipped", "cancelled", "cached"]),
      durationMs: z.number().nonnegative().nullable(),
      logRef: z.string().nullable(),
    }),
  ),
});
export type PipelineRun = z.infer<typeof PipelineRun>;

export const LinkedIssue = z.object({
  id: z.string(),
  changeId: Id.nullable(),
  title: z.string(),
  count: z.number().int().nonnegative(),
  firstSeen: IsoDate,
  lastSeen: IsoDate,
  versionId: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type LinkedIssue = z.infer<typeof LinkedIssue>;

// ---------------------------------------------------------------- agent ergonomics (onboarding §5)

/** Every error tells the caller what to do next. */
export const ErrorFix = z.object({
  explanation: z.string().min(1).max(2000),
  /** A concrete MCP tool call that would fix it, e.g. `start_change({ planId: "pln_123" })`. */
  call: z.string().max(500).optional(),
  /** A shell command that would fix it, e.g. `git push origin HEAD:refs/heads/change`. */
  command: z.string().max(500).optional(),
  docsUrl: z.string().url().optional(),
});
export type ErrorFix = z.infer<typeof ErrorFix>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fix: ErrorFix,
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** A suggested next action returned by create/mutate calls so agents never have to guess. */
export const NextStep = z.object({
  title: z.string().min(1).max(200),
  why: z.string().max(600).optional(),
  call: z.string().max(500).optional(),
  command: z.string().max(500).optional(),
  docsUrl: z.string().url().optional(),
});
export type NextStep = z.infer<typeof NextStep>;

export const WaitUntil = z.enum(["evidence_ready", "lane_assigned", "tour_ready", "merged", "reverted"]);
export type WaitUntil = z.infer<typeof WaitUntil>;

/** Header carrying a client-chosen idempotency key on every create/mutate call. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
