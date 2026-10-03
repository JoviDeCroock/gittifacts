/**
 * The native host: Cloudflare Artifacts is the source of truth, the platform's own merge queue
 * is the only writer of the default branch, and evidence is written as git notes.
 *
 * A thin adapter over the coordinator's ports (store, ArtifactsGitHost via `GitHost`, the merge
 * queue DO). It publishes through the same helpers the ChangeWorkflow uses
 * (`persistClassification`, `persistTour`), so the adapter and the workflow write the same rows.
 */
import {
  type CoordinatorBindings,
  changeWorkflowId,
  openRevertChange,
  type Ports,
  persistClassification,
  persistTour,
} from "@app/coordinator";
import type { Change, Repo, Tour } from "@app/domain";
import {
  type ChangeMeta,
  type ChangeRef,
  classificationOf,
  type DiffInfo,
  type HostAdapter,
  type HostCapabilities,
  HostError,
  type HostEvents,
  type LaneVerdict,
  type MergeMethod,
  type MergeResult,
  NATIVE_CAPABILITIES,
  type ReviewRequest,
  type SandboxCheckout,
} from "@app/host";
import { normalizeArtifactsEvent } from "./events.js";
import { identityKindOf, nativeRef } from "./ref.js";

/** Sandboxes get a read token for the one repo they check out, briefly. */
export const SANDBOX_TOKEN_TTL_SECONDS = 600;

export interface ArtifactsHostDeps {
  /** The default-role ports: its GitHost refuses to write anywhere but change forks. */
  ports: Ports;
  bindings: CoordinatorBindings;
}

const MERGED_STATUSES: readonly Change["status"][] = [
  "merged",
  "rolling-out",
  "released",
  "reverted",
];
const CLOSED_STATUSES: readonly Change["status"][] = ["rejected", "abandoned"];

export class ArtifactsHost implements HostAdapter {
  readonly kind = "artifacts" as const;

  constructor(private readonly deps: ArtifactsHostDeps) {}

  capabilities(): HostCapabilities {
    return NATIVE_CAPABILITIES;
  }

  private async load(ref: ChangeRef): Promise<{ change: Change; repo: Repo }> {
    if (ref.host !== "artifacts") {
      throw new HostError("wrong-host", `the native host does not serve ${ref.host} changes`);
    }
    const { store } = this.deps.ports;
    const change = await store.getChange(ref.changeId);
    if (change === null || change.repoId !== ref.repoId) {
      throw new HostError("not-found", `change ${ref.changeId} not found in repo ${ref.repoId}`);
    }
    const repo = await store.getRepo(change.repoId);
    if (repo === null) throw new HostError("not-found", `repo ${change.repoId} not found`);
    return { change, repo };
  }

  async getChange(ref: ChangeRef): Promise<ChangeMeta> {
    const { change, repo } = await this.load(ref);
    const author = await this.deps.ports.store.getPrincipal(change.authorId);
    return {
      ref: nativeRef(change),
      title: change.title,
      body: change.claim.summary,
      author: {
        kind: identityKindOf(author?.kind),
        id: change.authorId,
        login: author?.name ?? null,
      },
      baseBranch: repo.defaultBranch,
      baseSha: change.baseSha,
      headSha: change.headSha,
      category: change.claim.category,
      planRefs: change.planId === null ? [] : [change.planId],
      revertOf: change.revertOf === null ? null : nativeRef({ ...change, id: change.revertOf }),
      agentTraceId: change.agentTraceId,
      // Every native change lives in its own fork (`task-<id>`): agents never get a write token
      // for the main repo, so the head is always untrusted, fork-like code.
      source: { fork: true, repo: change.forkName },
      state: MERGED_STATUSES.includes(change.status)
        ? "merged"
        : CLOSED_STATUSES.includes(change.status)
          ? "closed"
          : "open",
    };
  }

  async materialize(ref: ChangeRef, sha: string): Promise<SandboxCheckout> {
    const { change } = await this.load(ref);
    const { git } = this.deps.ports;
    if ((await git.commitParents(change.forkName, sha)) === null) {
      throw new HostError("not-found", `commit ${sha} is not in ${change.forkName}`);
    }
    const token = await git.mintToken(change.forkName, "read", SANDBOX_TOKEN_TTL_SECONDS);
    return {
      ref: nativeRef(change),
      sha,
      artifactsRepo: change.forkName,
      remote: git.remoteOf(change.forkName),
      token: { scope: "read", value: token.token, expiresAt: token.expiresAt },
      writable: false,
    };
  }

  async diff(ref: ChangeRef): Promise<DiffInfo> {
    const { change } = await this.load(ref);
    if (change.headSha === null) throw new HostError("invalid", "nothing was pushed yet");
    return this.deps.ports.git.diff(change.forkName, change.baseSha, change.headSha);
  }

  /** A verdict for a head the change no longer has is dropped (it would describe old code). */
  async publishVerdict(ref: ChangeRef, verdict: LaneVerdict): Promise<void> {
    const { change } = await this.load(ref);
    if (change.headSha !== verdict.headSha) return;
    await persistClassification(this.deps.ports.store, {
      changeId: change.id,
      headSha: verdict.headSha,
      result: classificationOf(verdict),
    });
  }

  async publishTour(ref: ChangeRef, tour: Tour): Promise<void> {
    const { change } = await this.load(ref);
    if (tour.changeId !== change.id)
      throw new HostError("invalid", "the tour is for another change");
    if (tour.headSha !== change.headSha) return;
    await persistTour(this.deps.ports.store, change.id, tour);
  }

  /** Natively a review request is the change's status plus a notification (no assignees). */
  async requestReview(ref: ChangeRef, request: ReviewRequest): Promise<void> {
    const { change } = await this.load(ref);
    await this.deps.ports.store.updateChange(change.id, { status: "awaiting-review" });
    await this.deps.ports.notifier.notify({
      kind: "review-requested",
      changeId: change.id,
      repoId: change.repoId,
      message: `${change.title} needs a review: ${request.reason}`,
    });
  }

  /**
   * Admit the change to the platform's merge queue, guarded by `expectedHeadSha`. The queue lands
   * it later (fast-forward, rebasing when main moved) and drops it if the head moves meanwhile;
   * `main.advanced` follows. Only what the core admitted gets in: a human approval of this head,
   * or a Lane 0 classification of this head that needs no human, on a claimed project.
   */
  async merge(
    ref: ChangeRef,
    input: { expectedHeadSha: string; method: MergeMethod },
  ): Promise<MergeResult> {
    const { change, repo } = await this.load(ref);
    const { store } = this.deps.ports;
    if (change.headSha !== input.expectedHeadSha) {
      return {
        status: "refused",
        reason: "stale-head",
        detail: `the change's head is ${change.headSha ?? "nothing"}, not ${input.expectedHeadSha}; the new head is graded on its own`,
        currentHeadSha: change.headSha,
      };
    }
    const headSha = input.expectedHeadSha;
    if (MERGED_STATUSES.includes(change.status) || CLOSED_STATUSES.includes(change.status)) {
      return refused("closed", `the change is ${change.status}`, headSha);
    }
    const cls = await store.getClassification(change.id, headSha);
    const lane = cls?.lane ?? change.lane ?? 2;
    const laneZero =
      cls !== null &&
      cls.lane === 0 &&
      !cls.blocked &&
      !cls.requiresHumanApproval &&
      repo.claim.status === "claimed";
    const via = change.status === "approved" ? "review" : laneZero ? "lane-0" : null;
    if (via === null) {
      return refused("not-allowed", "this head is neither approved nor Lane 0", headSha);
    }
    await store.updateChange(change.id, { status: "queued" });
    const { position } = await this.deps.bindings.mergeQueue(change.repoId).enqueue({
      repoId: change.repoId,
      changeId: change.id,
      headSha,
      workflowInstanceId: changeWorkflowId(change.id, headSha),
      lane,
      approvedLane: via === "lane-0" ? 0 : lane,
      via,
    });
    return { status: "queued", position };
  }

  /** Natively a revert is a new Change (pure inverse when possible); `of` names what it undoes. */
  async revert(
    mergedSha: string,
    reason: string,
    opts: { of?: ChangeRef } = {},
  ): Promise<ChangeRef> {
    if (opts.of === undefined) {
      throw new HostError("invalid", "a native revert needs the change that merged it (`of`)");
    }
    const { change } = await this.load(opts.of);
    if (change.mergedSha !== mergedSha) {
      throw new HostError(
        "invalid",
        `${change.id} merged ${change.mergedSha ?? "nothing"}, not ${mergedSha}`,
      );
    }
    const out = await openRevertChange(this.deps, { original: change, reason });
    return nativeRef(out.change);
  }

  events(): HostEvents {
    return { normalize: (raw) => normalizeArtifactsEvent(this.deps.ports, raw) };
  }
}

function refused(
  reason: "not-allowed" | "closed",
  detail: string,
  currentHeadSha: string,
): MergeResult {
  return { status: "refused", reason, detail, currentHeadSha };
}
