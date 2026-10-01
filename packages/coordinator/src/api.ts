/**
 * The coordinator's facade. HTTP routes and MCP tools in `apps/platform` call this; they never
 * talk to Durable Objects or Workflows directly. Every method takes the acting principal and
 * enforces the lifecycle rules (e.g. no self-approval); the HTTP layer only enforces scopes.
 */
import type {
  Change,
  ClaimedCategory,
  ErrorFix,
  Lane,
  Principal,
  Repo,
  WaitUntil,
} from "@app/domain";

export interface GitRemoteGrant {
  url: string;
  username: string;
  token: string;
  expiresAt: string;
  branch: string;
}

export type CoordinatorErrorCode =
  | "not-found"
  | "invalid-input"
  | "forbidden"
  | "self-approval"
  | "conflict"
  | "invalid-state"
  | "threshold-not-met"
  | "upstream";

/** Every error says what to do next (onboarding §5): `fix.explanation` plus an optional call/command. */
export class CoordinatorError extends Error {
  readonly fix: ErrorFix;
  constructor(
    readonly code: CoordinatorErrorCode,
    message: string,
    fix: ErrorFix | string,
  ) {
    super(message);
    this.name = "CoordinatorError";
    this.fix = typeof fix === "string" ? { explanation: fix } : fix;
  }
}

/** Result of `waitFor`: the current snapshot, whether the milestone was reached, and why not. */
export interface WaitResult {
  change: Change;
  reached: boolean;
  /** reached | timeout | unreachable (the change ended without reaching the milestone). */
  reason: "reached" | "timeout" | "unreachable";
}

/** What `createRepo` asks the platform for: the files of a new repo's initial commit. */
export interface InitialCommitInput {
  repoId: string;
  name: string;
  defaultBranch: string;
  /** Template id, or null for an empty project. */
  template: string | null;
  description: string | null;
  claimed: boolean;
}

export interface InitialCommit {
  /** Repo path → content (mode 100644). */
  files: Record<string, string | Uint8Array>;
  message: string;
  /**
   * What `.platform/policy.ts` in `files` exports, when the provider generated it and so knows it.
   * It is cached for the initial commit, so the bootstrap Change needs no policy sandbox job.
   */
  policy?: unknown;
}

/**
 * The platform's source of initial commits (templates rendered with placeholders, `.platform/*`
 * and AGENTS.md from @app/conventions). Throw a `CoordinatorError("invalid-input")` for an
 * unknown template; it is called before anything is created.
 */
export type InitialCommitProvider = (input: InitialCommitInput) => Promise<InitialCommit>;

export interface CoordinatorApi {
  /**
   * A human (or an agent with an owner) gets a claimed repo; an ownerless agent an unclaimed one.
   * With an `initialCommit` provider configured, the repo starts with one commit on its default
   * branch (the template, or a minimal project). With an idempotency key the repo id is derived
   * from (actor, key): a retry returns the same repo.
   */
  createRepo(
    actor: Principal,
    input: {
      name: string;
      defaultBranch?: string;
      template?: string;
      description?: string;
      idempotencyKey?: string;
    },
  ): Promise<Repo>;

  /**
   * The bootstrap Change of a repo: platform-authored (`system`), category chore, base = head =
   * the initial commit. It runs the first CI and the first preview, then is released. It has no
   * lane and never enters review or the merge queue; `wait_for_change` works on it. Idempotent
   * per repo.
   */
  startBootstrapChange(actor: Principal, repoId: string): Promise<Change>;
  importRepo(
    actor: Principal,
    input: { name: string; url: string; branch?: string },
  ): Promise<Repo>;

  /**
   * Forks the repo to `task-<changeId>` and returns a push grant for that fork only.
   * With an idempotency key the change id is derived from (actor, key): a retry returns the same
   * change with a fresh grant.
   */
  startChange(
    actor: Principal,
    input: {
      repoId: string;
      planId?: string;
      title: string;
      category: ClaimedCategory;
      summary?: string;
      agentTraceId?: string;
      idempotencyKey?: string;
    },
  ): Promise<{ change: Change; remote: GitRemoteGrant }>;

  /** Fresh short-lived push token for the author's fork. */
  refreshPushGrant(actor: Principal, changeId: string): Promise<GitRemoteGrant>;

  /** Artifacts push event (from the PushRouter workflow). */
  onPush(event: { repoName: string; ref: string; before: string; after: string }): Promise<void>;

  /** Binds to the current head. A retry with the same idempotency key is a no-op. */
  submitReview(
    actor: Principal,
    changeId: string,
    input: {
      headSha?: string;
      decision: "approve" | "request-changes" | "reject";
      humanLane?: Lane;
      comment?: string;
      idempotencyKey?: string;
    },
  ): Promise<Change>;

  /** Human kill switch during rollout: flag off, roll back, open a revert change. */
  kill(actor: Principal, changeId: string, reason: string): Promise<Change>;

  /** Turn Lane 0 on/off for a repo (on requires the shadow agreement threshold). */
  setLane0(actor: Principal, repoId: string, enabled: boolean): Promise<Repo>;

  /** Verified Workers Issues webhook payload (already authenticated by the HTTP layer). */
  onIssue(payload: unknown): Promise<void>;

  abandon(actor: Principal, changeId: string): Promise<Change>;

  /**
   * `wait_for_change`: long-poll (backed by the change's Durable Object) until the change reaches
   * `until`, becomes unable to reach it, or `timeoutMs` (capped at 10 minutes) passes.
   */
  waitFor(
    actor: Principal,
    changeId: string,
    until: WaitUntil,
    timeoutMs: number,
  ): Promise<WaitResult>;

  /**
   * Subscription hook (SSE/webhooks): resolves with the change as soon as its `version` differs
   * from `since` (null = now), or after `timeoutMs` with `changed: false`. Loop it, passing the
   * returned `version`, to stream every change.
   */
  watchChange(
    actor: Principal,
    changeId: string,
    options: { since: string | null; timeoutMs: number },
  ): Promise<{ change: Change; changed: boolean; version: string }>;
}
