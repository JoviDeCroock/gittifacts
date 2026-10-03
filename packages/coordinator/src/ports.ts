/**
 * Ports: the only way the coordinator touches the outside world.
 *
 * `apps/platform` provides the Cloudflare implementations (D1/Drizzle, Artifacts + gitwire,
 * AI Gateway, Flagship, Workers Versions, Workers Issues, ...). Tests provide in-memory fakes.
 * Keep these interfaces small and intention-revealing; add methods rather than leaking SDKs.
 */
import type { ClassifyResult, ShadowSample } from "@app/classifier";
import type {
  AuditEvent,
  Change,
  ChangeDiff,
  Evidence,
  LinkedIssue,
  PipelineRun,
  Plan,
  Principal,
  Repo,
  RepoPolicy,
  ReviewDecision,
  Tour,
} from "@app/domain";
import type { EvidencePayload, LlmJudgment, Screenshots, SignedEvidence } from "@app/evidence";

// ---------------------------------------------------------------- store (D1)

export interface Store {
  getRepo(id: string): Promise<Repo | null>;
  getRepoByArtifactsName(artifactsName: string): Promise<Repo | null>;
  insertRepo(repo: Repo): Promise<void>;
  /** Shallow-merges `patch`, returns the new row. */
  updateRepo(id: string, patch: Partial<Omit<Repo, "id" | "createdAt">>): Promise<Repo>;
  /**
   * Record the repo's own Flagship app unless it already has one (compare-and-set on null), and
   * return the app the repo has afterwards: `appId`, or the one a concurrent writer stored first.
   */
  setRepoFlagshipApp(repoId: string, appId: string): Promise<string>;
  /** Cache the policy evaluated from the default branch at `sha`. */
  setRepoPolicy(repoId: string, policy: RepoPolicy, sha: string): Promise<void>;

  getPlan(id: string): Promise<Plan | null>;
  /** Platform-authored plans (the merge queue's "fix the flaky test"); optional. */
  insertPlan?(plan: Plan): Promise<void>;

  getChange(id: string): Promise<Change | null>;
  getChangeByFork(forkName: string): Promise<Change | null>;
  insertChange(change: Change): Promise<void>;
  /** Shallow-merges `patch`, bumps `updatedAt`, returns the new row. */
  updateChange(
    id: string,
    patch: Partial<Omit<Change, "id" | "repoId" | "createdAt">>,
  ): Promise<Change>;
  /** Changes in a repo with any of the given statuses (merge queue recovery, GC). */
  listChanges(repoId: string, statuses: Change["status"][]): Promise<Change[]>;
  /** The change whose `rolloutState.versionId` is `versionId` (Workers Issues → rollout). */
  getChangeByRolloutVersion(versionId: string): Promise<Change | null>;

  upsertRun(run: PipelineRun): Promise<void>;
  getRun(id: string): Promise<PipelineRun | null>;

  putDiff(changeId: string, diff: ChangeDiff): Promise<void>;
  getDiff(changeId: string, headSha: string): Promise<ChangeDiff | null>;

  putEvidence(evidence: Evidence): Promise<void>;
  getEvidence(changeId: string, headSha: string): Promise<Evidence | null>;

  putClassification(changeId: string, headSha: string, result: ClassifyResult): Promise<void>;
  getClassification(changeId: string, headSha: string): Promise<ClassifyResult | null>;

  putTour(tour: Tour): Promise<void>;

  putReview(review: ReviewDecision): Promise<void>;
  /** Human reviews of changes whose computed lane was 0, for shadow-mode agreement. */
  listShadowSamples(repoId: string): Promise<ShadowSample[]>;

  putIssue(issue: LinkedIssue & { scriptName: string; raw: unknown }): Promise<void>;
  listIssues(filter: {
    versionId?: string;
    changeId?: string;
    since?: string;
  }): Promise<LinkedIssue[]>;

  getPrincipal(id: string): Promise<Principal | null>;
}

// ---------------------------------------------------------------- git (Artifacts + @app/gitwire)

export type FastForwardResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "missing-object" | "rejected"; detail: string };

/**
 * Writes (`writeNote`, `transferObjects` target, `updateRef`, `commitTree`, write tokens) to a main
 * repo are only allowed on the GitHost built for the `merge-queue` role (see `PortsRole`). Every
 * other GitHost must refuse to write anywhere but a change fork (`task-*`). Main-repo write
 * tokens are minted internally with TTL <= 300 s and never leave the host.
 *
 * The one exception is `writeInitialCommit`: every role may use it, because it can only create
 * the first commit of a branch that does not exist yet (CAS against the zero SHA). It can never
 * rewrite or extend history, so "only the merge queue moves main" still holds.
 *
 * `mintImportToken` is the other, narrower one (import by push, DECISIONS 2026-10-02): a write
 * token for a main repo whose default branch does not exist yet, handed to a human owner for the
 * repo's initial import. The platform revokes it (`revokeToken`) at the first push to the repo,
 * the first Change, or its TTL (<= 30 min), whichever comes first.
 */
export interface GitHost {
  /** Artifacts namespace this host operates on (e.g. "gittifacts-eu"). */
  readonly namespace: string;
  createRepo(
    name: string,
    opts: { defaultBranch: string; description?: string },
  ): Promise<{ remote: string }>;
  /** Import from a public https git URL. Resolves when the repo is ready (polls *_IN_PROGRESS). */
  importRepo(
    name: string,
    url: string,
    opts?: { branch?: string },
  ): Promise<{ remote: string; defaultBranch: string }>;
  /** Fork `source` → `target`. Resolves when ready. */
  forkRepo(
    source: string,
    target: string,
    opts?: { readOnly?: boolean },
  ): Promise<{ remote: string }>;
  deleteRepo(name: string): Promise<void>;
  remoteOf(name: string): string;
  mintToken(
    repo: string,
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: string }>;
  /**
   * Import by push: a write token for main repo `repo`, only while `refs/heads/<branch>` does
   * not exist (checked against the advertised refs right before minting; refused otherwise, and
   * for change forks). TTL clamped to <= 1800 s. Returns the token id, so it can be revoked.
   */
  mintImportToken(
    repo: string,
    input: { branch: string; ttlSeconds: number },
  ): Promise<{ token: string; tokenId: string; expiresAt: string }>;
  /** Revoke a token of `repo` by id. False when the host could not confirm the revocation. */
  revokeToken(repo: string, tokenId: string): Promise<boolean>;
  /** Tip of a branch, or null if the branch does not exist. */
  branchHead(repo: string, branch: string): Promise<string | null>;
  /** Parent shas of a commit (null if the commit is unknown in this repo). */
  commitParents(repo: string, sha: string): Promise<string[] | null>;
  treeOf(repo: string, sha: string): Promise<string | null>;
  readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null>;
  /** Unified diff between two commits that both exist in `repo`. */
  diff(
    repo: string,
    baseSha: string,
    headSha: string,
    opts?: { maxFileBytes?: number },
  ): Promise<ChangeDiff>;
  readNote(repo: string, targetSha: string, notesRef?: string): Promise<string | null>;
  writeNote(
    repo: string,
    targetSha: string,
    content: string,
    opts?: { notesRef?: string; mode?: "replace" | "append" },
  ): Promise<void>;
  /** Copy the objects reachable from `sha` out of `fromRepo` into `toRepo`, pointing `toRef` at it. */
  transferObjects(fromRepo: string, toRepo: string, sha: string, toRef: string): Promise<void>;
  /**
   * GitHub mode: fetch the objects reachable from `sha` out of an external git remote (a GitHub
   * repository, read with a short-lived installation token) into `toRepo` (a mirror), and point
   * `toRef` at it (non-fast-forward allowed). Incremental: the target's tips are the haves.
   */
  fetchExternal?(
    source: ExternalRemote,
    toRepo: string,
    input: { sha: string; toRef: string },
  ): Promise<void>;
  /** Compare-and-swap ref update. `oldSha` = 40 zeros to create. */
  updateRef(repo: string, ref: string, oldSha: string, newSha: string): Promise<FastForwardResult>;
  /**
   * The first commit of an empty repo: `files` (repo path → content, mode 100644) as one root
   * commit on `refs/heads/<branch>`, pushed with old SHA = zero so it fails once the branch exists.
   */
  writeInitialCommit(
    repo: string,
    input: {
      branch: string;
      files: Readonly<Record<string, string | Uint8Array>>;
      message: string;
      author?: { name: string; email: string };
    },
  ): Promise<{ sha: string; treeSha: string }>;
  /** Create a commit whose tree is `treeSha` (used for pure reverts) and push it to `branch`. */
  commitTree(
    repo: string,
    input: {
      treeSha: string;
      parents: string[];
      message: string;
      branch: string;
      expectedOld: string;
    },
  ): Promise<{ sha: string }>;
}

// ---------------------------------------------------------------- sandbox jobs (not the CI pipeline)

export interface SandboxJobs {
  /** Evaluate `.platform/ci.ts` at `sha` in plan mode (or produce defaults). Returns raw JSON. */
  planPipeline(input: { repo: string; sha: string }): Promise<unknown>;
  /** Evaluate `.platform/policy.ts` at `sha`. Returns the raw exported object (validated by caller). */
  evaluatePolicy(input: { repo: string; sha: string }): Promise<unknown | null>;
  /** Rebase `headSha` (in `fork`) onto `ontoSha` (in `mainRepo`), pushing the result to the fork. */
  rebase(input: {
    fork: string;
    mainRepo: string;
    headSha: string;
    ontoSha: string;
    branch: string;
  }): Promise<{ status: "clean"; newSha: string } | { status: "conflict"; files: string[] }>;
  /**
   * `git revert --no-edit <sha>` on top of `ontoSha` in `fork` (used when main moved past the
   * merge, so a pure tree revert is impossible). Pushes the result to `branch` in the fork with
   * CAS against `ontoSha`.
   */
  revert(input: {
    fork: string;
    sha: string;
    ontoSha: string;
    branch: string;
    message: string;
  }): Promise<{ status: "clean"; newSha: string } | { status: "conflict"; files: string[] }>;
}

// ---------------------------------------------------------------- CI (@app/ci-engine)

/**
 * Structural mirror of `@app/ci-engine`'s `CiEngine` contract (engine.ts). Mirrored rather than
 * imported so this package does not type-check (or load) the engine's Worker sources; the
 * engine's `WorkflowsCiEngine` is assignable to it.
 *
 * Runs report back through `RunSink.onRunFinished(summary)`, which the CI workflow calls on
 * `env.COORDINATOR.getByName(changeId)`: bind `COORDINATOR` to the ChangeCoordinator DO class.
 */
export interface CiRunRequest {
  /** `[A-Za-z0-9][A-Za-z0-9_-]{0,99}`; start is idempotent per run id. */
  runId: string;
  changeId: string;
  repo: { remote: string; tokenProvider: "artifacts" };
  /** The change's fork. */
  artifactsRepo: string;
  headSha: string;
  baseSha: string;
  /** A plan-mode PipelineSpec; omitted → the engine plans it from `pipelineFrom`. */
  pipeline?: unknown;
  /** Omitted → the engine's default evidence steps; [] → none (cheap re-checks). */
  evidenceSteps?: unknown[];
  pipelineFrom?: "base" | "head";
  /** Per-run quotas (the engine requires `limits` or the deprecated `budget`). */
  limits?: { maxMinutes: number; maxLogBytes?: number; instance?: string };
  /** Deprecated by the engine in favour of `limits`. */
  budget?: { maxMinutes: number };
  /** `registries-only` for unclaimed projects (sandbox egress allowlisted to package registries). */
  network?: "open" | "registries-only";
  /** Merge-queue revalidation: only these test targets (`GITTIFACTS_TEST_TARGETS` in user steps). */
  testTargets?: string[];
}

export type CiRunState = "queued" | "running" | "passed" | "failed" | "cancelled" | "superseded";

export interface CiRunStatus {
  id: string;
  changeId: string;
  headSha: string;
  baseSha: string;
  engine: string;
  status: CiRunState;
  startedAt: string | null;
  finishedAt: string | null;
  steps: Array<{
    name: string;
    kind: "user" | "evidence";
    status: string;
    durationMs: number | null;
    logRef: string | null;
    cacheHit?: boolean;
  }>;
  error?: string;
}

export interface CiEngine {
  start(req: CiRunRequest): Promise<{ runId: string }>;
  /** Throws when the engine does not know the run. */
  status(runId: string): Promise<CiRunStatus>;
  /** A reason starting with "superseded" reports the run as superseded. */
  cancel(runId: string, reason: string): Promise<void>;
  restartFrom(runId: string, step: string): Promise<void>;
}

/** What the CI workflow calls when a run finishes (payload validated by the coordinator). */
export interface RunSink {
  onRunFinished(summary: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------- review (AI Gateway)

export interface Budget {
  changeId: string;
  limitUsd: number;
  spentUsd: number;
}

/**
 * The reviewer agent. `model` is the base policy's `ai.reviewerModel` ("auto" = the platform's
 * routing); implementations pick their model client by it.
 */
export interface Reviewer {
  /** Model judgments about scope/conformance. Raise-only signals. Never sees the author's summary. */
  judge(input: { plan: Plan | null; diff: ChangeDiff; budget: Budget; model?: string }): Promise<{
    items: LlmJudgment[];
    costUsd: number;
    budgetExceeded: boolean;
  }>;
  /** The guided tour. Validated against the Tour schema; one regeneration on failure. */
  tour(input: {
    change: Pick<Change, "id" | "title" | "headSha" | "baseSha">;
    plan: Plan | null;
    diff: ChangeDiff;
    evidence: SignedEvidence;
    classification: ClassifyResult;
    budget: Budget;
    model?: string;
  }): Promise<
    | { status: "ok"; tour: Tour; costUsd: number; budgetExceeded: boolean }
    | { status: "failed"; reason: string; costUsd: number; budgetExceeded: boolean }
  >;
}

// ---------------------------------------------------------------- previews (preview gateway)

export interface PreviewRequest {
  changeId: string;
  repoId: string;
  /** The Artifacts repo CI checked out: the change's fork, or the main repo for a bootstrap. */
  artifactsRepo: string;
  headSha: string;
  /** The CI run's step snapshots: previews start from `build` (else `install` + build). */
  snapshots: Record<string, string>;
  /** Unclaimed projects' previews never get internet access. */
  claimed: boolean;
  /** The repo's template id, if any (routes; templates without a runtime have no preview). */
  template: string | null;
}

export type PreviewOutcome =
  | { status: "ready"; url: string; pinnedUrl: string; readyMs: number }
  | { status: "skipped" | "error"; url: string | null; reason: string };

/**
 * Change previews: the project's built Worker under workerd in a container, behind the preview
 * gateway (a clearly marked domain with a banner). Informational evidence: `skipped` is fine,
 * `error` raises the lane (unknown → escalate).
 */
export interface Previews {
  /** Start (or wake) the change's preview at `headSha` and wait (bounded) until it serves. */
  start(input: PreviewRequest): Promise<PreviewOutcome>;
  /** Screenshot `routes` of a serving preview; refs are blob keys under `screenshots/<changeId>/`. */
  screenshots(input: {
    changeId: string;
    headSha: string;
    url: string;
    routes: string[];
    template: string | null;
  }): Promise<Screenshots>;
}

/** Onboarding metrics (time-to-first-green). Best effort: failures never affect the change. */
export interface Onboarding {
  /** A repo's bootstrap Change has sealed evidence (first CI finished) and its preview outcome. */
  bootstrapReady(input: {
    repoId: string;
    changeId: string;
    ciStatus: "passed" | "failed" | "errored" | "cancelled" | "unknown";
    evidenceAt: string;
    preview: PreviewOutcome | null;
  }): Promise<void>;
}

// ---------------------------------------------------------------- signing

export interface Signer {
  readonly keyId: string;
  signEvidence(payload: EvidencePayload): Promise<SignedEvidence>;
  verifyEvidence(signed: SignedEvidence): Promise<{ ok: boolean; reason?: string }>;
  /** Detached signature over canonical JSON of `value` (plan approvals, audit entries). */
  signDocument(value: unknown): Promise<string>;
}

// ---------------------------------------------------------------- release

export interface Deployer {
  /**
   * Upload a Worker version built from `sha` without routing traffic to it. The version binds
   * `FLAGS` to `flagshipAppId`, the deploying project's own Flagship app, and to no other.
   */
  uploadVersion(input: {
    script: string;
    changeId: string;
    sha: string;
    bundleRef: string;
    message: string;
    flagshipAppId: string;
  }): Promise<{ versionId: string }>;
  currentVersions(script: string): Promise<Array<{ versionId: string; percentage: number }>>;
  /** Split traffic between two versions (percentages must sum to 100). */
  setSplit(
    script: string,
    split: Array<{ versionId: string; percentage: number }>,
    message: string,
  ): Promise<void>;
  /** 100% to `versionId`. */
  rollback(script: string, versionId: string, message: string): Promise<void>;
}

/**
 * Kill-switch flags. Every project with a deploy target has its own Flagship app (cross-tenant
 * isolation: a project's Workers bind only their own app); change flags are created and flipped
 * in that app. The platform's own flags live in a separate app no project Worker binds.
 */
export interface Flags {
  /**
   * The id of the app named `name`, created when there is none. Names are not unique in
   * Flagship: with several, the oldest wins (so a retried create converges).
   */
  ensureApp(name: string): Promise<string>;
  /** Delete an app and its flags; a missing app is fine. Fails while a Worker still binds it. */
  deleteApp(appId: string): Promise<void>;
  /** Idempotent; returns the flag key (e.g. "change-<id>"). */
  ensureChangeFlag(
    appId: string,
    changeId: string,
    opts: { enabled: boolean; description: string },
  ): Promise<string>;
  setEnabled(appId: string, flagKey: string, enabled: boolean): Promise<void>;
}

export interface Telemetry {
  /**
   * Error rate of `versionId` vs `baselineVersionId` since `since`, and Workers Issues
   * attributed to the version. `null` rates mean "unknown" — callers treat unknown as unhealthy
   * only once `minRequests` should have been reached.
   */
  check(input: {
    script: string;
    versionId: string;
    baselineVersionId: string | null;
    since: string;
  }): Promise<{
    requests: number;
    errorRate: number | null;
    baselineErrorRate: number | null;
    newIssueGroups: number;
    issues: LinkedIssue[];
  }>;
  /**
   * The newest occurrence of a Workers Issue (`GET …/observability/issues/{id}/occurrences`):
   * the Issues webhook names the issue and its Worker but not the version, which the occurrence
   * carries. `null` when the issue has no retained occurrence.
   */
  issueOccurrence?(issueId: string): Promise<IssueOccurrence | null>;
}

export interface IssueOccurrence {
  scriptName: string | null;
  versionId: string | null;
  /** The error's stack, as Workers Issues recorded it (source-mapped when available). */
  stack: string | null;
  at: string | null;
}

// ---------------------------------------------------------------- audit, notify, clock

export interface Audit {
  append(input: {
    principalId: string;
    action: string;
    subject: string;
    payload: unknown;
  }): Promise<AuditEvent>;
}

export interface Notifier {
  notify(input: {
    kind:
      | "review-requested"
      | "merged"
      | "rollout-stage"
      | "regression-detected"
      | "reverted"
      | "failing"
      | "budget-exceeded";
    changeId: string;
    repoId: string;
    message: string;
  }): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/**
 * Which component a `Ports` bundle is built for. Only `merge-queue` gets a GitHost that may write
 * to main repos (the MergeQueue DO is the only writer of the default branch).
 */
/**
 * - `default`: writes change forks only.
 * - `merge-queue`: the only writer of native main repos.
 * - `github`: GitHub mode's mirror sync; writes change forks and GitHub mirrors (`ghm-*`), whose
 *   source of truth is GitHub, never a native main repo.
 */
export type PortsRole = "default" | "merge-queue" | "github";

/** An external git remote (GitHub) and its credentials for one fetch. */
export interface ExternalRemote {
  url: string;
  auth?: { basic: { username: string; password: string } };
}

/** GitHub mirrors are `ghm-<github repo id>` (packages/host-github/src/ids.ts). */
export const isGithubMirrorRepo = (name: string): boolean => /^ghm-\d+$/.test(name);

/** The platform's own principal id, used for machine actions in the audit log. */
export const SYSTEM_PRINCIPAL_ID = "system";

/** What an actor-driven facade call needs on a repo (apps/platform/src/access/roles.ts). */
export type RepoNeed = "read" | "contribute" | "review" | "approve" | "admin";

/**
 * Repo access (membership) for the facade. Every actor-driven call (start a change, push token,
 * review, kill switch, Lane 0, abandon, wait/watch) asks before acting, so the rule holds even
 * when a route or tool forgets. `hidden`: the actor may not even see the repo (the facade answers
 * not-found, which leaks nothing); `denied`: it sees the repo but may not do this (forbidden).
 * Optional: without it the facade keeps only its own rules (unit tests with fakes).
 */
export interface RepoAccess {
  check(actor: Principal, repoId: string, need: RepoNeed): Promise<"allowed" | "hidden" | "denied">;
}

export interface Ports {
  store: Store;
  git: GitHost;
  sandbox: SandboxJobs;
  ci: CiEngine;
  reviewer: Reviewer;
  signer: Signer;
  deployer: Deployer;
  flags: Flags;
  telemetry: Telemetry;
  audit: Audit;
  notifier: Notifier;
  clock: Clock;
  /** Change previews; without it preview and screenshot evidence is `skipped`. */
  previews?: Previews;
  /** Onboarding metrics sink. */
  onboarding?: Onboarding;
  /** Repo membership checks for actor-driven calls (the platform's src/access/). */
  access?: RepoAccess;
}
