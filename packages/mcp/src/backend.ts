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
import type { ImportToolsBackend } from "./tools/import.js";
import type { QueueToolsBackend } from "./tools/queue.js";
import type { WorkspaceToolsBackend } from "./tools/workspace.js";

/** The authenticated agent, from the bearer verifier's `AuthInfo`. */
export interface McpCaller {
  principalId: string;
  scopes: readonly string[];
  authInfo: AuthInfo;
}

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
}

export interface NextStepData {
  title: string;
  call?: string | undefined;
  command?: string | undefined;
  why?: string | undefined;
}

export interface ProjectCreated {
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
}

/** Every tool family's backend: the core tools below, remote workspaces and import detection. */
export interface McpBackend extends WorkspaceToolsBackend, ImportToolsBackend, QueueToolsBackend {
  whoami(caller: McpCaller): Promise<WhoamiData>;
  /** Repo (template / import / empty) + first CI + first preview + a first Change's fork. */
  createProject(
    caller: McpCaller,
    input: CreateProjectArgs,
    opts: MutationOptions,
  ): Promise<ProjectCreated>;
  listRepos(caller: McpCaller): Promise<Array<Repo & { counts: LaneCountsData }>>;
  createPlan(
    caller: McpCaller,
    input: z.output<typeof PlanDraftInput>,
    opts: MutationOptions,
  ): Promise<Plan>;
  startChange(
    caller: McpCaller,
    input: z.output<typeof StartChangeInput>,
    opts: MutationOptions,
  ): Promise<{ change: Change; remote: GitRemote }>;
  getChangeStatus(
    caller: McpCaller,
    changeId: string,
  ): Promise<{ change: Change; runs: PipelineRun[]; classification: ClassificationSummary | null }>;
  getEvidence(
    caller: McpCaller,
    changeId: string,
  ): Promise<{
    evidence: Evidence;
    verification: { ok: boolean; keyId?: string; reason?: string };
  }>;
  /** The change's latest tour; `stale` when it was generated for an older head. */
  getTour(caller: McpCaller, changeId: string): Promise<{ tour: Tour; stale: boolean }>;
  /** Ask a human to look at the change (notify + audit). Never approves anything. */
  requestReview(
    caller: McpCaller,
    changeId: string,
    message: string | undefined,
    opts: MutationOptions,
  ): Promise<{ change: Change; notified: boolean }>;
  listIssuesForChange(caller: McpCaller, changeId: string): Promise<LinkedIssue[]>;
  refreshPushToken(caller: McpCaller, changeId: string, opts: MutationOptions): Promise<GitRemote>;
  waitForChange(
    caller: McpCaller,
    changeId: string,
    until: WaitUntil,
    timeoutMs: number,
  ): Promise<{ change: Change; reached: boolean; reason: "reached" | "timeout" | "unreachable" }>;
  /** The platform's error envelope for anything a backend call threw. */
  errorEnvelope(err: unknown): ApiError;
}
