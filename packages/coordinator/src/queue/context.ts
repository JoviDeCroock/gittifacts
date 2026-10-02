/**
 * What every queue command handler shares: the repo, Ports (merge-queue role: the only main-repo
 * writer), the DO's store and loop, and small helpers (where a head lives, delivering results to a
 * Change's workflow, the scratch repo's name).
 */
import type { Change, Repo } from "@app/domain";
import type { QueueState } from "@app/merge-queue";
import type { ConflictResolver } from "@app/resolver";
import type { CoordinatorBindings, WorkflowHandle } from "../bindings.js";
import { changeSubject, QUEUE_SCRATCH_PREFIX, repoSubject } from "../ids.js";
import { withChangeNotifications } from "../milestones.js";
import { errorMessage } from "../policy.js";
import { type Ports, SYSTEM_PRINCIPAL_ID } from "../ports.js";
import type { BatchRunParams } from "./batch-run.js";
import type { QueueJobs, ReplaySpec } from "./jobs.js";
import type { QueueStore } from "./store.js";

export { QUEUE_SCRATCH_PREFIX };

/** The queue's scratch repo: batch trees and resolutions are built here, never in main. */
export function scratchRepoFor(repoId: string): string {
  return `${QUEUE_SCRATCH_PREFIX}${repoId}`;
}

/** Resolver agent factory, per model (the base policy's `ai.reviewerModel`; "auto" allowed). */
export type ResolverFactory = (model: string) => ConflictResolver;

/** What the shell registers per Change (ChangeWorkflow instance, enqueue options). */
export interface QueueIntent {
  workflowInstanceId: string | null;
  /** Options from `enqueue` (MCP/HTTP); applied when the ChangeWorkflow enqueues. */
  options: {
    priority?: "normal" | "security" | "incident" | "revert";
    dependsOn?: string[];
    plangroup?: string | null;
    landTogether?: boolean;
    groupSize?: number | null;
    landMode?: "atomic" | "incremental";
    incidentPlanId?: string | null;
    automaticRevert?: boolean;
  };
  requestedBy: {
    principalId: string;
    kind: "human" | "agent" | "system";
    sessionId: string | null;
  } | null;
  /** The head the ChangeWorkflow enqueued (null: not admitted yet). */
  admittedHead: string | null;
  /** The Change's title (views, without a D1 read per entry). */
  title?: string | null;
  updatedAt: number;
}

export interface QueueContextDeps {
  repoId: string;
  ports: Ports;
  bindings: CoordinatorBindings;
  store: QueueStore;
  jobs: QueueJobs;
  /** The BatchRunWorkflow binding (one instance per run). */
  batchRuns: WorkflowHandle<BatchRunParams>;
  resolver?: ResolverFactory;
  /** Current core state (read-only; handlers never mutate it). */
  state(): QueueState;
  /** Workflow-id namespace of this queue's lifetime (survives restarts, not state resets). */
  epoch: string;
  /** The CI engine accepts `testTargets` (impacted-target revalidation runs). */
  targetsSupported?: boolean;
  /**
   * Deploy trains (absent: merged Changes roll out one by one through the RolloutWorkflow).
   * `changeMerged` must be synchronous and idempotent per Change (it feeds `ChangeMerged`).
   */
  trains?: {
    changeMerged(input: {
      changeId: string;
      sha: string;
      deploysTo: string[];
      flagKey: string | null;
      files: string[];
      modules: string[];
    }): void;
  };
}

export class QueueContext {
  readonly ports: Ports;
  private repoCache: { repo: Repo; at: number } | null = null;

  constructor(readonly deps: QueueContextDeps) {
    // "merged"/"failing" updates wake `wait_for_change` long-polls on the change's DO.
    this.ports = withChangeNotifications(deps.ports, deps.bindings);
  }

  get repoId(): string {
    return this.deps.repoId;
  }

  now(): number {
    return this.ports.clock.now().getTime();
  }

  async repo(): Promise<Repo> {
    const at = this.now();
    if (this.repoCache !== null && at - this.repoCache.at < 30_000) return this.repoCache.repo;
    const repo = await this.ports.store.getRepo(this.deps.repoId);
    if (repo === null) throw new Error(`repo ${this.deps.repoId} not found`);
    this.repoCache = { repo, at };
    return repo;
  }

  get scratch(): string {
    return scratchRepoFor(this.deps.repoId);
  }

  async change(changeId: string): Promise<Change> {
    const c = await this.ports.store.getChange(changeId);
    if (c === null) throw new Error(`change ${changeId} not found`);
    return c;
  }

  /** Where `headSha` of `changeId` lives and what its own work replays from. */
  async replaySpec(changeId: string, headSha: string): Promise<ReplaySpec> {
    const known = this.deps.store.getHead(changeId, headSha);
    if (known !== null) return { changeId, headSha, ...known };
    const change = await this.change(changeId);
    return { changeId, headSha, replayBase: change.baseSha, repo: change.forkName };
  }

  intent(changeId: string): QueueIntent | null {
    return this.deps.store.getIntent<QueueIntent>(changeId);
  }

  /** Send a ChangeWorkflow event; undelivered is audited (the workflow also polls the row). */
  async deliver(changeId: string, type: string, payload: unknown): Promise<boolean> {
    const instanceId = this.intent(changeId)?.workflowInstanceId ?? null;
    if (instanceId === null) return false;
    try {
      const instance = await this.deps.bindings.changeWorkflow.get(instanceId);
      await instance.sendEvent({ type, payload });
      return true;
    } catch (e) {
      await this.audit(changeSubject(changeId), "merge-queue.event-undelivered", {
        type,
        instanceId,
        error: errorMessage(e),
      });
      return false;
    }
  }

  async audit(subject: string, action: string, payload: unknown): Promise<void> {
    await this.ports.audit.append({ principalId: SYSTEM_PRINCIPAL_ID, action, subject, payload });
  }

  repoSubject(): string {
    return repoSubject(this.deps.repoId);
  }
}
