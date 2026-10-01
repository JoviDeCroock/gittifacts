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
  LinkedIssue,
  PipelineRun,
  Plan,
  Principal,
  Repo,
  RepoPolicy,
  ReviewDecision,
  Tour,
} from "@app/domain";
import type { Evidence } from "@app/domain";
import type { EvidencePayload, LlmJudgment, SignedEvidence } from "@app/evidence";

// ---------------------------------------------------------------- store (D1)

export interface Store {
  getRepo(id: string): Promise<Repo | null>;
  getRepoByArtifactsName(artifactsName: string): Promise<Repo | null>;
  insertRepo(repo: Repo): Promise<void>;
  /** Shallow-merges `patch`, returns the new row. */
  updateRepo(id: string, patch: Partial<Omit<Repo, "id" | "createdAt">>): Promise<Repo>;
  /** Cache the policy evaluated from the default branch at `sha`. */
  setRepoPolicy(repoId: string, policy: RepoPolicy, sha: string): Promise<void>;

  getPlan(id: string): Promise<Plan | null>;

  getChange(id: string): Promise<Change | null>;
  getChangeByFork(forkName: string): Promise<Change | null>;
  insertChange(change: Change): Promise<void>;
  /** Shallow-merges `patch`, bumps `updatedAt`, returns the new row. */
  updateChange(id: string, patch: Partial<Omit<Change, "id" | "repoId" | "createdAt">>): Promise<Change>;
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
  listIssues(filter: { versionId?: string; changeId?: string; since?: string }): Promise<LinkedIssue[]>;

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
 */
export interface GitHost {
  /** Artifacts namespace this host operates on (e.g. "gittifacts-eu"). */
  readonly namespace: string;
  createRepo(name: string, opts: { defaultBranch: string; description?: string }): Promise<{ remote: string }>;
  /** Import from a public https git URL. Resolves when the repo is ready (polls *_IN_PROGRESS). */
  importRepo(name: string, url: string, opts?: { branch?: string }): Promise<{ remote: string; defaultBranch: string }>;
  /** Fork `source` → `target`. Resolves when ready. */
  forkRepo(source: string, target: string, opts?: { readOnly?: boolean }): Promise<{ remote: string }>;
  deleteRepo(name: string): Promise<void>;
  remoteOf(name: string): string;
  mintToken(repo: string, scope: "read" | "write", ttlSeconds: number): Promise<{ token: string; expiresAt: string }>;
  /** Tip of a branch, or null if the branch does not exist. */
  branchHead(repo: string, branch: string): Promise<string | null>;
  /** Parent shas of a commit (null if the commit is unknown in this repo). */
  commitParents(repo: string, sha: string): Promise<string[] | null>;
  treeOf(repo: string, sha: string): Promise<string | null>;
  readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null>;
  /** Unified diff between two commits that both exist in `repo`. */
  diff(repo: string, baseSha: string, headSha: string, opts?: { maxFileBytes?: number }): Promise<ChangeDiff>;
  readNote(repo: string, targetSha: string, notesRef?: string): Promise<string | null>;
  writeNote(
    repo: string,
    targetSha: string,
    content: string,
    opts?: { notesRef?: string; mode?: "replace" | "append" },
  ): Promise<void>;
  /** Copy the objects reachable from `sha` out of `fromRepo` into `toRepo`, pointing `toRef` at it. */
  transferObjects(fromRepo: string, toRepo: string, sha: string, toRef: string): Promise<void>;
  /** Compare-and-swap ref update. `oldSha` = 40 zeros to create. */
  updateRef(repo: string, ref: string, oldSha: string, newSha: string): Promise<FastForwardResult>;
  /** Create a commit whose tree is `treeSha` (used for pure reverts) and push it to `branch`. */
  commitTree(
    repo: string,
    input: { treeSha: string; parents: string[]; message: string; branch: string; expectedOld: string },
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

/** Where the run sink delivers `ci-finished` once a run is terminal. */
export interface CiReplyTo {
  workflow: "change";
  instanceId: string;
}

export interface CiStartInput {
  /** Chosen by the caller and deterministic, so `start` is idempotent per run id. */
  runId: string;
  changeId: string;
  repoId: string;
  /** Artifacts repo to check out (the change's fork). */
  repo: string;
  baseSha: string;
  headSha: string;
  /** Raw plan-mode output (the engine validates it as a PipelineSpec); null = engine defaults. */
  pipeline: unknown;
  /** full = user steps + evidence steps; cheap = typecheck + tests from the cached install snapshot. */
  profile: "full" | "cheap";
  replyTo: CiReplyTo | null;
}

export interface CiRunReport {
  run: PipelineRun;
  /** Raw evidence items from the evidence steps; the coordinator validates each one. */
  items: unknown[];
  outputs: {
    /** Worker bundle produced by the pipeline's `build` step (R2 key), if any. */
    bundleRef: string | null;
  };
  replyTo: CiReplyTo | null;
}

export interface CiEngine {
  start(input: CiStartInput): Promise<{ runId: string }>;
  /** Latest report for the run, or null when the engine does not know it. */
  status(runId: string): Promise<CiRunReport | null>;
  cancel(runId: string, reason: string): Promise<void>;
  restartFrom(runId: string, step: string): Promise<void>;
}

/**
 * Implemented by the coordinator (`createRunSink`); the CI engine calls it whenever a run changes
 * state. Terminal reports with a `replyTo` are forwarded to that ChangeWorkflow as `ci-finished`.
 */
export interface RunSink {
  report(report: CiRunReport): Promise<void>;
}

// ---------------------------------------------------------------- review (AI Gateway)

export interface Budget {
  changeId: string;
  limitUsd: number;
  spentUsd: number;
}

export interface Reviewer {
  /** Model judgments about scope/conformance. Raise-only signals. Never sees the author's summary. */
  judge(input: { plan: Plan | null; diff: ChangeDiff; budget: Budget }): Promise<{
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
  }): Promise<
    | { status: "ok"; tour: Tour; costUsd: number; budgetExceeded: boolean }
    | { status: "failed"; reason: string; costUsd: number; budgetExceeded: boolean }
  >;
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
  /** Upload a Worker version built from `sha` without routing traffic to it. */
  uploadVersion(input: {
    script: string;
    changeId: string;
    sha: string;
    bundleRef: string;
    message: string;
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

export interface Flags {
  /** Idempotent; returns the flag key (e.g. "change-<id>"). */
  ensureChangeFlag(changeId: string, opts: { enabled: boolean; description: string }): Promise<string>;
  setEnabled(flagKey: string, enabled: boolean): Promise<void>;
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
}

// ---------------------------------------------------------------- audit, notify, clock

export interface Audit {
  append(input: { principalId: string; action: string; subject: string; payload: unknown }): Promise<AuditEvent>;
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
export type PortsRole = "default" | "merge-queue";

/** The platform's own principal id, used for machine actions in the audit log. */
export const SYSTEM_PRINCIPAL_ID = "system";

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
}
