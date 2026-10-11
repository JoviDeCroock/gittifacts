/**
 * What the MCP tools need from the platform. `apps/platform` implements this with the same
 * service functions its HTTP routes call, so there is one implementation of every rule; this
 * package only validates input, checks scopes, and shapes output for agents.
 */
import type {
  ApiError,
  Change,
  Evidence,
  LaneReason,
  LinkedIssue,
  OverlapReport,
  PipelineRun,
  Plan,
  PlanDraftInput,
  Principal,
  Repo,
  StartChangeInput,
  Tour,
  WaitUntil,
} from "@app/domain";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ChangeListToolsBackend } from "./tools/changes.js";
import type { ImportToolsBackend } from "./tools/import.js";
import type { PlanToolsBackend } from "./tools/plans.js";
import type { QaToolsBackend } from "./tools/qa.js";
import type { QueueToolsBackend } from "./tools/queue.js";
import type { WorkspaceToolsBackend } from "./tools/workspace.js";

/** The authenticated agent, from the bearer verifier's `AuthInfo`. */
export interface McpCaller {
  principalId: string;
  scopes: readonly string[];
  authInfo: AuthInfo;
}

/**
 * Why `wait_for_change` answered. Besides reached / timeout / unreachable (the change ended), a
 * human may have sent it back: changes-requested, rejected or approval-withdrawn.
 */
export type WaitReasonData =
  | "reached"
  | "timeout"
  | "unreachable"
  | "changes-requested"
  | "rejected"
  | "approval-withdrawn";

export interface GitRemote {
  url: string;
  username: string;
  token: string;
  expiresAt: string;
  branch: string;
}

export interface LaneCountsData {
  lane0: number;
  lane1: number;
  lane2: number;
  awaitingReview: number;
  rollingOut: number;
  failing: number;
}

export interface WhoamiData {
  principal: Principal;
  canApprove: boolean;
  repos: { id: string; name: string; claim: Repo["claim"]; actions: string[] }[];
  quotas: {
    enforced: boolean;
    ciMinutesPerDay: number | null;
    ciMinutesUsedToday: number | null;
    artifactsOpsPerDay: number | null;
  };
}

export interface ClassificationSummary {
  lane: 0 | 1 | 2;
  computedLane: 0 | 1 | 2;
  reasons: LaneReason[];
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
}

export interface MutationOptions {
  idempotencyKey?: string | undefined;
}

export interface CreateProjectArgs {
  name?: string | undefined;
  template?: string | undefined;
  from?: string | undefined;
  description?: string | undefined;
  /** "push": an empty project whose human owner pushes the history (humans only). */
  importMode?: "push" | undefined;
}

/** Import by push: the one-time grant a human owner pushes a repo's history with. */
export interface ImportGrantData {
  /** The project's main repo remote. */
  url: string;
  branch: string;
  /** Artifacts write token for the main repo; closes at the first push, first Change or TTL. */
  token: string;
  expiresAt: string;
  command: string;
  closesWhen: string;
}

export interface NextStepData {
  title: string;
  call?: string | undefined;
  command?: string | undefined;
  why?: string | undefined;
}

export interface ProjectCreated {
  /** The repo id: what every other tool calls `repoId`. */
  repoId: string;
  /** @deprecated The same value as `repoId`; kept for agents and CLIs that read it (2026-10-04). */
  projectId: string;
  name: string;
  template: string | null;
  defaultBranch: string;
  remote: (GitRemote & { changeId: string }) | null;
  token: string | null;
  mcpUrl: string;
  previewUrl: string | null;
  claimUrl: string | null;
  bootstrapChangeId: string | null;
  nextSteps: NextStepData[];
  /** Only for `importMode: "push"` (a human caller). */
  importGrant?: ImportGrantData | undefined;
}

export type RepoRoleData = "owner" | "maintainer" | "reviewer" | "reader";

export interface MembersData {
  repoId: string;
  members: { principalId: string; name: string; role: RepoRoleData; addedAt: string }[];
  /** The caller's effective role (an agent: its owner's role, capped by its scopes). */
  viewerRole: RepoRoleData | null;
}

/** A human review of a change, as agents read it (`get_change_status.reviews`). */
export interface ChangeReviewData {
  id: string;
  decision: "approve" | "request-changes" | "reject";
  comment: string | null;
  /** The head it was given for (a review binds to one head). */
  headSha: string;
  reviewer: { id: string; name: string; kind: "human" | "agent" | "system" | "integration" };
  at: string;
  /** Set when the approval stopped counting (e.g. "qa-failed"). */
  withdrawn: { at: string; reason: string } | null;
}

/** A platform page a person can open: a plan or a change. */
export type WebPage = { planId: string } | { changeId: string };

/** Every tool family's backend: the core tools below, remote workspaces and import detection. */
export interface McpBackend
  extends WorkspaceToolsBackend,
    ImportToolsBackend,
    QueueToolsBackend,
    QaToolsBackend,
    PlanToolsBackend,
    ChangeListToolsBackend {
  /** The absolute URL of `page` on the platform, to hand to a person. */
  webUrl(page: WebPage): string;
  whoami(caller: McpCaller): Promise<WhoamiData>;
  /** Repo (template / import / empty) + first CI + first preview + a first Change's fork. */
  createProject(
    caller: McpCaller,
    input: CreateProjectArgs,
    opts: MutationOptions,
  ): Promise<ProjectCreated>;
  listRepos(caller: McpCaller): Promise<Array<Repo & { counts: LaneCountsData }>>;
  /** A repo's human members and their roles (read-only; owners manage members on the web). */
  listMembers(caller: McpCaller, repoId: string): Promise<MembersData>;
  createPlan(
    caller: McpCaller,
    input: z.output<typeof PlanDraftInput>,
    opts: MutationOptions,
  ): Promise<Plan>;
  startChange(
    caller: McpCaller,
    input: z.output<typeof StartChangeInput>,
    opts: MutationOptions,
  ): Promise<{
    change: Change;
    remote: GitRemote;
    /** Open Changes on the same plan or paths; null when the check could not run. */
    overlaps: OverlapReport | null;
  }>;
  getChangeStatus(
    caller: McpCaller,
    changeId: string,
  ): Promise<{
    change: Change;
    runs: PipelineRun[];
    classification: ClassificationSummary | null;
    /** The current head's preview once it answered (from its evidence); absent = unknown. */
    previewUrl?: string | null;
    /** Human reviews of every head, oldest first. */
    reviews: ChangeReviewData[];
    /** Open Changes on the same plan or paths; null when the check could not run. */
    overlaps: OverlapReport | null;
  }>;
  getEvidence(
    caller: McpCaller,
    changeId: string,
  ): Promise<{
    evidence: Evidence;
    verification: { ok: boolean; keyId?: string; reason?: string };
  }>;
  /** The change's latest tour; `stale` when it was generated for an older head. */
  getTour(caller: McpCaller, changeId: string): Promise<{ tour: Tour; stale: boolean }>;
  /**
   * GitHub mode: the Change that grades pull request `owner/repo#123` (not-found when the
   * platform doesn't grade that repository). Optional: hosts without GitHub mode omit it.
   */
  resolveGithubChange?(caller: McpCaller, ref: string): Promise<string>;
  /** Ask a human to look at the change (notify + audit). Never approves anything. */
  requestReview(
    caller: McpCaller,
    changeId: string,
    message: string | undefined,
    opts: MutationOptions,
  ): Promise<{ change: Change; notified: boolean }>;
  /** CI, evidence, lane and tour again on the same head (author, its owner or a maintainer). */
  rerunCi(
    caller: McpCaller,
    changeId: string,
    reason: string | undefined,
    opts: MutationOptions,
  ): Promise<{ change: Change; headSha: string }>;
  /** Close (abandon) a change that won't merge (author, its owner or a maintainer). */
  closeChange(
    caller: McpCaller,
    changeId: string,
    reason: string | undefined,
    opts: MutationOptions,
  ): Promise<Change>;
  listIssuesForChange(caller: McpCaller, changeId: string): Promise<LinkedIssue[]>;
  refreshPushToken(caller: McpCaller, changeId: string, opts: MutationOptions): Promise<GitRemote>;
  waitForChange(
    caller: McpCaller,
    changeId: string,
    until: WaitUntil,
    timeoutMs: number,
  ): Promise<{
    change: Change;
    reached: boolean;
    reason: WaitReasonData;
    /** With "timeout": seconds before calling again (the platform was interrupted when > 0). */
    retryAfterSec?: number;
  }>;
  /** The platform's error envelope for anything a backend call threw. */
  errorEnvelope(err: unknown): ApiError;
}
