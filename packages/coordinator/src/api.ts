/**
 * The coordinator's facade. HTTP routes and MCP tools in `apps/platform` call this; they never
 * talk to Durable Objects or Workflows directly. Every method takes the acting principal and
 * enforces the lifecycle rules (e.g. no self-approval); the HTTP layer only enforces scopes.
 */
import type { Change, ClaimedCategory, Lane, Principal, Repo } from "@app/domain";

export interface GitRemoteGrant {
  url: string;
  username: string;
  token: string;
  expiresAt: string;
  branch: string;
}

export class CoordinatorError extends Error {
  constructor(
    readonly code:
      | "not-found"
      | "forbidden"
      | "self-approval"
      | "conflict"
      | "invalid-state"
      | "threshold-not-met"
      | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export interface CoordinatorApi {
  createRepo(actor: Principal, input: { name: string; defaultBranch?: string }): Promise<Repo>;
  importRepo(actor: Principal, input: { name: string; url: string; branch?: string }): Promise<Repo>;

  /** Forks the repo to `task-<changeId>` and returns a push grant for that fork only. */
  startChange(
    actor: Principal,
    input: {
      repoId: string;
      planId?: string;
      title: string;
      category: ClaimedCategory;
      summary?: string;
      agentTraceId?: string;
    },
  ): Promise<{ change: Change; remote: GitRemoteGrant }>;

  /** Fresh short-lived push token for the author's fork. */
  refreshPushGrant(actor: Principal, changeId: string): Promise<GitRemoteGrant>;

  /** Artifacts push event (from the PushRouter workflow). */
  onPush(event: { repoName: string; ref: string; before: string; after: string }): Promise<void>;

  submitReview(
    actor: Principal,
    changeId: string,
    input: {
      headSha?: string;
      decision: "approve" | "request-changes" | "reject";
      humanLane?: Lane;
      comment?: string;
    },
  ): Promise<Change>;

  /** Human kill switch during rollout: flag off, roll back, open a revert change. */
  kill(actor: Principal, changeId: string, reason: string): Promise<Change>;

  /** Turn Lane 0 on/off for a repo (on requires the shadow agreement threshold). */
  setLane0(actor: Principal, repoId: string, enabled: boolean): Promise<Repo>;

  /** Verified Workers Issues webhook payload (already authenticated by the HTTP layer). */
  onIssue(payload: unknown): Promise<void>;

  abandon(actor: Principal, changeId: string): Promise<Change>;
}
