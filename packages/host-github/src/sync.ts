/**
 * `GithubSync`: what a verified GitHub delivery does to the platform (spec §3.2, §3.3). Host-
 * neutral events come from `normalizeGithubDelivery`; from there:
 *
 * - a PR head (opened / reopened / ready / synchronize, against the default branch, not a draft):
 *   the repo's Artifacts mirror fetches the head (a short-lived read token, incremental), the PR's
 *   Change is created or updated (base = the merge base, so the diff is the PR's own), the
 *   `gittifacts/lane` run opens in progress, and the head goes down the native path: the change's
 *   ChangeCoordinator serializes heads and runs the ChangeWorkflow, exactly as for a push.
 * - closed: the Change is merged or abandoned (GitHub merged it; we never do in shadow mode).
 * - default-branch push: the mirror's default branch follows.
 * - reviews and merge groups are recorded only (M3 binds approvals, M5 answers merge groups).
 *
 * Every step is idempotent: deliveries are at least once and may race.
 */
import { type ChangeCoordinatorClient, type ExternalRemote, PUSHABLE_STATUSES, type Ports, SYSTEM_PRINCIPAL_ID, ZERO_SHA } from "@app/coordinator";
import { type Change, defaultPolicy, type GithubChangeHost, type Repo } from "@app/domain";
import type { Identity } from "@app/host";
import { claimedCategoryOf, type GitHubHost, planRefOf } from "./adapter.js";
import { changeIdFor, headBranchFor, mirrorNameFor, repoIdFor } from "./ids.js";
import { identityOf, normalizeGithubDelivery } from "./normalize.js";
import { type GithubDelivery, type GithubRepo, PullRequestEvent, PushEvent } from "./payloads.js";

/** A GitHub remote readable for one job; `release` revokes its token. */
export interface GithubSource {
  remote: ExternalRemote;
  release(): Promise<void>;
}

export interface GithubSyncDeps {
  /** Ports of the `github` role (writes the mirror). */
  ports: Ports;
  coordinator(changeId: string): Pick<ChangeCoordinatorClient, "onPush">;
  host: GitHubHost;
  installationId: number;
  appId: number;
  /** A read-only GitHub remote for this repo (contents: read, this repo only). */
  source(): Promise<GithubSource>;
  /** The principal a GitHub account authors as (created on first sight). */
  authorPrincipal(identity: Identity & { login: string }): Promise<string>;
  /** The platform adds the installation's linked humans as members. */
  onRepoCreated?(repo: Repo): Promise<void>;
}

export interface SyncOutcome {
  event: string;
  action: "graded" | "closed" | "mirrored" | "recorded" | "ignored";
  detail: string | null;
  changeId?: string;
  headSha?: string;
}

/** Unclaimed PRs grade as features: no special proof demanded, no special relief (DECISIONS). */
export const DEFAULT_PR_CATEGORY = "feature" as const;

export class GithubSync {
  constructor(private readonly deps: GithubSyncDeps) {}

  private log(action: string, subject: string, payload: unknown) {
    return this.deps.ports.audit.append({ principalId: SYSTEM_PRINCIPAL_ID, action, subject, payload });
  }

  async handle(delivery: GithubDelivery): Promise<SyncOutcome[]> {
    const out: SyncOutcome[] = [];
    for (const ev of normalizeGithubDelivery(delivery)) {
      if (ev.type === "change.opened" || ev.type === "change.updated") {
        out.push(await this.onHead(delivery));
      } else if (ev.type === "change.closed") {
        out.push(await this.onClosed(delivery, ev.merged, ev.mergedSha));
      } else if (ev.type === "main.advanced") {
        out.push(await this.onMain(delivery));
      } else {
        const where = "ref" in ev ? ev.ref : ev.repo;
        const subject = where.host === "github" ? `github:${where.owner}/${where.repo}` : "github";
        await this.log(`github.${ev.type}`, subject, ev);
        out.push({ event: ev.type, action: "recorded", detail: "recorded; acted on from M3/M5" });
      }
    }
    return out;
  }

  /** The platform repo row + mirror of a GitHub repository (created on first sight). */
  async ensureRepo(r: GithubRepo): Promise<Repo> {
    const { store, git, clock } = this.deps.ports;
    const id = repoIdFor(r.id);
    const host = {
      kind: "github" as const,
      owner: r.owner.login,
      repo: r.name,
      githubRepoId: r.id,
      installationId: this.deps.installationId,
      appId: this.deps.appId,
      private: r.private,
    };
    const existing = await store.getRepo(id);
    if (existing !== null) {
      const same = JSON.stringify(existing.host) === JSON.stringify(host) && existing.defaultBranch === r.default_branch;
      return same ? existing : store.updateRepo(id, { host, defaultBranch: r.default_branch, name: r.full_name.slice(0, 100) });
    }
    const mirror = mirrorNameFor(r.id);
    if ((await git.branchHead(mirror, r.default_branch).catch(() => undefined)) === undefined) {
      try {
        await git.createRepo(mirror, { defaultBranch: r.default_branch, description: `GitHub mirror of ${r.full_name}` });
      } catch (e) {
        // Another delivery created it first.
        if ((await git.branchHead(mirror, r.default_branch).catch(() => undefined)) === undefined) throw e;
      }
    }
    const repo: Repo = {
      id,
      namespace: git.namespace,
      artifactsName: mirror,
      name: r.full_name.slice(0, 100),
      defaultBranch: r.default_branch,
      jurisdiction: "eu",
      importedFrom: `https://github.com/${r.full_name}`,
      policy: defaultPolicy(),
      policySha: null,
      deployTarget: null,
      claim: { status: "claimed", ownerId: null, expiresAt: null },
      template: null,
      host,
      createdAt: clock.now().toISOString(),
    };
    await store.insertRepo(repo);
    await this.deps.onRepoCreated?.(repo);
    await this.log("github.repo-mirrored", `repo:${id}`, { fullName: r.full_name, mirror });
    return repo;
  }

  /** Fetch `sha` from GitHub into the mirror at `ref` (read token revoked right after). */
  private async fetch(mirror: string, sha: string, ref: string): Promise<void> {
    const { git } = this.deps.ports;
    if (git.fetchExternal === undefined) throw new Error("this GitHost cannot fetch from GitHub");
    const src = await this.deps.source();
    try {
      await git.fetchExternal(src.remote, mirror, { sha, toRef: ref });
    } finally {
      await src.release();
    }
  }

  private async onHead(delivery: GithubDelivery): Promise<SyncOutcome> {
    const event = delivery.event;
    const p = PullRequestEvent.safeParse(delivery.payload);
    if (!p.success) return { event, action: "ignored", detail: "unreadable pull_request payload" };
    const { pull_request: pr, repository: r } = p.data;
    if (pr.state !== "open") return { event, action: "ignored", detail: "pull request is closed" };
    if (pr.draft) return { event, action: "ignored", detail: "draft (graded when ready for review)" };
    // Policy and the merge queue are about the default branch; stacked PRs are out of M2's scope.
    if (pr.base.ref !== r.default_branch) {
      return { event, action: "ignored", detail: `base ${pr.base.ref} is not the default branch` };
    }
    const { store, git, clock } = this.deps.ports;
    const repo = await this.ensureRepo(r);
    const mirror = repo.artifactsName;
    const changeId = changeIdFor(r.id, pr.number);
    const headBranch = headBranchFor(pr.number);
    const headSha = pr.head.sha;

    // 1. The mirror: the head (fork heads too: GitHub serves them from the base repo), and the
    //    default branch the first time (afterwards, default-branch pushes move it).
    await this.fetch(mirror, headSha, `refs/heads/${headBranch}`);
    if ((await git.branchHead(mirror, r.default_branch)) === null) {
      await this.fetch(mirror, pr.base.sha, `refs/heads/${r.default_branch}`);
    }

    // 2. The Change: one per PR. Its base is the merge base, so its diff is the PR's own.
    const baseSha = await this.deps.host.mergeBase(pr.base.sha, headSha);
    const author = identityOf(pr.user, { headRef: pr.head.ref });
    const hostInfo: GithubChangeHost = {
      kind: "github",
      number: pr.number,
      headBranch,
      fork: pr.head.repo === null || pr.head.repo.id !== r.id,
      headRepo: pr.head.repo?.full_name ?? null,
      baseRef: pr.base.ref,
      author: { login: pr.user.login, id: pr.user.id, kind: author.kind },
      url: pr.html_url,
    };
    // A platform Plan referenced in the body links only if it belongs to this repo.
    const planRef = planRefOf(pr.body);
    const plan = planRef === null ? null : await store.getPlan(planRef);
    const planId = plan !== null && plan.repoId === repo.id ? plan.id : null;
    let change = await store.getChange(changeId);
    const previous = change?.headSha ?? null;
    if (change === null) {
      const now = clock.now().toISOString();
      change = {
        id: changeId,
        repoId: repo.id,
        planId,
        title: (pr.title || `#${pr.number}`).slice(0, 200),
        claim: { category: claimedCategoryOf(pr) ?? DEFAULT_PR_CATEGORY, summary: pr.body?.slice(0, 10_000) ?? null },
        baseSha,
        headSha: null,
        forkName: mirror,
        authorId: await this.deps.authorPrincipal({ ...author, login: pr.user.login }),
        status: "awaiting-push",
        computedLane: null,
        lane: null,
        laneReasons: [],
        evidenceId: null,
        tourId: null,
        flagKey: null,
        mergedSha: null,
        rolloutState: null,
        revertOf: null,
        revertedBy: null,
        agentTraceId: null,
        host: hostInfo,
        createdAt: now,
        updatedAt: now,
      } satisfies Change;
      await store.insertChange(change);
    } else {
      await store.updateChange(changeId, {
        title: (pr.title || `#${pr.number}`).slice(0, 200),
        claim: { category: claimedCategoryOf(pr) ?? change.claim.category, summary: pr.body?.slice(0, 10_000) ?? null },
        baseSha,
        planId,
        host: hostInfo,
        // Reopened after closing: pushable again.
        ...(PUSHABLE_STATUSES.includes(change.status) ? {} : { status: "awaiting-push" as const }),
      });
    }

    // 3. The check run, in progress, as soon as we know the head (best effort: if GitHub refuses
    //    now, the verdict creates it completed). A replaced head's run is closed, never left open.
    try {
      await this.deps.host.startCheck(changeId, headSha);
      if (previous !== null && previous !== headSha) {
        await this.deps.host.supersedeCheck(changeId, previous, headSha);
      }
    } catch (e) {
      await this.log("github.check-start-failed", `change:${changeId}`, { headSha, error: (e as Error).message });
    }

    // 4. From here it is the native path: serialized heads, the ChangeWorkflow, gradeChange.
    const pushed = await this.deps.coordinator(changeId).onPush({
      changeId,
      ref: `refs/heads/${headBranch}`,
      before: previous ?? ZERO_SHA,
      after: headSha,
    });
    await this.log("github.pr-head", `change:${changeId}`, { headSha, previous, outcome: pushed.action });
    return {
      event,
      action: pushed.action === "ignored" ? "ignored" : "graded",
      detail: pushed.action === "ignored" ? pushed.reason : null,
      changeId,
      headSha,
    };
  }

  private async onClosed(delivery: GithubDelivery, merged: boolean, mergedSha: string | null): Promise<SyncOutcome> {
    const p = PullRequestEvent.safeParse(delivery.payload);
    if (!p.success) return { event: delivery.event, action: "ignored", detail: "unreadable payload" };
    const changeId = changeIdFor(p.data.repository.id, p.data.pull_request.number);
    const { store } = this.deps.ports;
    const change = await store.getChange(changeId);
    if (change === null) return { event: delivery.event, action: "ignored", detail: "never graded", changeId };
    await store.updateChange(changeId, merged ? { status: "merged", mergedSha } : { status: "abandoned" });
    await this.log(merged ? "github.pr-merged" : "github.pr-closed", `change:${changeId}`, { mergedSha });
    return { event: delivery.event, action: "closed", detail: merged ? "merged on GitHub" : "closed", changeId };
  }

  private async onMain(delivery: GithubDelivery): Promise<SyncOutcome> {
    const p = PushEvent.safeParse(delivery.payload);
    if (!p.success) return { event: delivery.event, action: "ignored", detail: "unreadable payload" };
    const repo = await this.deps.ports.store.getRepo(repoIdFor(p.data.repository.id));
    // Only repos we already grade: a push alone never creates a mirror.
    if (repo === null) return { event: delivery.event, action: "ignored", detail: "repo not graded yet" };
    await this.fetch(repo.artifactsName, p.data.after, `refs/heads/${repo.defaultBranch}`);
    return { event: delivery.event, action: "mirrored", detail: p.data.after };
  }
}
