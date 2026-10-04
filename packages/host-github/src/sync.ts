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
import { type Change, defaultPolicy, type GithubChangeHost, type Plan, type Repo } from "@app/domain";
import type { Identity } from "@app/host";
import { claimedCategoryOf, type GitHubHost } from "./adapter.js";
import { changeIdFor, headBranchFor, mirrorNameFor, repoIdFor } from "./ids.js";
import { WALKTHROUGH_LABEL } from "./terms.js";
import { identityOf, normalizeGithubDelivery } from "./normalize.js";
import { type GithubDelivery, type GithubRepo, IssueEvent, type PullRequest, PullRequestEvent, PushEvent } from "./payloads.js";
import { PLAN_LABEL } from "./plans.js";
import { resolvePlan } from "./sync-plans.js";
import { onCheckAction, onReview, refreshSummary } from "./sync-reviews.js";

/** A GitHub remote readable for one job; `release` revokes its token. */
export interface GithubSource {
  remote: ExternalRemote;
  release(): Promise<void>;
}

export interface GithubSyncDeps {
  /** Ports of the `github` role (writes the mirror). */
  ports: Ports;
  coordinator(changeId: string): Pick<ChangeCoordinatorClient, "onPush" | "regrade">;
  host: GitHubHost;
  installationId: number;
  appId: number;
  /** A read-only GitHub remote for this repo (contents: read, this repo only). */
  source(): Promise<GithubSource>;
  /** The principal a GitHub account authors as (created on first sight). */
  authorPrincipal(identity: Identity & { login: string }): Promise<string>;
  /** The platform adds the installation's linked humans as members. */
  onRepoCreated?(repo: Repo): Promise<void>;
  /** Who a GitHub reviewer acts as: the human who linked that GitHub login, else its own principal. */
  reviewerPrincipal?(identity: Identity & { login: string }): Promise<string>;
  /** Plans from issues and plan files (the platform signs approvals). Absent: no such plans. */
  plans?: { upsert(plan: Plan): Promise<Plan> };
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
    // Not host events: approvals from the check run's buttons, and plan labels on issues.
    if (delivery.event === "check_run") return [await onCheckAction(this.deps, delivery)];
    if (delivery.event === "issues") return this.onIssue(delivery);
    for (const ev of normalizeGithubDelivery(delivery)) {
      if (ev.type === "review.submitted") {
        out.push(await onReview(this.deps, delivery));
      } else if (ev.type === "change.edited") {
        out.push(await this.onEdited(delivery));
      } else if (ev.type === "change.opened" || ev.type === "change.updated") {
        out.push(await this.onHead(delivery));
      } else if (ev.type === "change.closed") {
        out.push(await this.onClosed(delivery, ev.merged, ev.mergedSha));
      } else if (ev.type === "main.advanced") {
        out.push(await this.onMain(delivery));
      } else {
        // A merge group: we answer merge_group as a required check from M5.
        const subject = ev.repo.host === "github" ? `github:${ev.repo.owner}/${ev.repo.repo}` : "github";
        await this.log(`github.${ev.type}`, subject, ev);
        out.push({ event: ev.type, action: "recorded", detail: "recorded; acted on in M5" });
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
    // The Plan: a reference in the body (platform Plan or plan file), else a labelled issue.
    const link = await resolvePlan(this.deps, this.deps.host, { pr, githubRepoId: r.id, repoId: repo.id, mirror, baseSha });
    const planId = link.planId;
    hostInfo.issueRefs = link.issueRefs;
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
    //    now, the verdict creates it completed). A replaced head's run is closed, never left open,
    //    and its tour review says "stale" and is minimized.
    try {
      await this.deps.host.startCheck(changeId, headSha);
      if (previous !== null && previous !== headSha) {
        await this.deps.host.supersedeCheck(changeId, previous, headSha);
        await this.deps.host.publisher?.staleOlder(changeId, pr.number, headSha);
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
    await this.log("github.pr-head", `change:${changeId}`, { headSha, previous, outcome: pushed.action, plan: link });
    if (previous !== null && previous !== headSha) {
      await refreshSummary(this.deps, changeId, r.owner.login, r.name, pr.number);
    }
    return {
      event,
      action: pushed.action === "ignored" ? "ignored" : "graded",
      detail: pushed.action === "ignored" ? pushed.reason : null,
      changeId,
      headSha,
    };
  }

  /** Title, description or labels changed: if the claim or the Plan changed, grade the head again. */
  private async onEdited(delivery: GithubDelivery): Promise<SyncOutcome> {
    const event = delivery.event;
    const p = PullRequestEvent.safeParse(delivery.payload);
    if (!p.success) return { event, action: "ignored", detail: "unreadable payload" };
    const { pull_request: pr, repository: r } = p.data;
    const changeId = changeIdFor(r.id, pr.number);
    // The walkthrough label asks for the flagged stops on the diff (idempotent per head).
    if (pr.labels.some((l) => l.name === WALKTHROUGH_LABEL)) {
      try {
        if ((await this.deps.host.publishRequestedTour(changeId, pr.number)) === "posted") {
          await this.deps.host.publishSummary({ host: "github", owner: r.owner.login, repo: r.name, number: pr.number });
        }
      } catch (e) {
        await this.log("github.review-post-failed", `change:${changeId}`, { error: (e as Error).message });
      }
    }
    return this.reconsider(event, changeId, pr, "the title, description or labels changed");
  }

  /** A plan label or issue text changed: PRs closing that issue may have another Plan now. */
  private async onIssue(delivery: GithubDelivery): Promise<SyncOutcome[]> {
    const event = delivery.event;
    const p = IssueEvent.safeParse(delivery.payload);
    if (!p.success) return [{ event, action: "ignored", detail: "unreadable payload" }];
    const { action, issue, label, repository: r } = p.data;
    if ((action === "labeled" || action === "unlabeled") && label?.name !== PLAN_LABEL) {
      return [{ event, action: "ignored", detail: "not the plan label" }];
    }
    if (!["labeled", "unlabeled", "edited"].includes(action)) return [{ event, action: "ignored", detail: action }];
    const open = await this.deps.ports.store.listChanges(repoIdFor(r.id), [...PUSHABLE_STATUSES]);
    const linked = open.filter((c) => c.host?.issueRefs?.includes(issue.number) === true);
    const out: SyncOutcome[] = [];
    for (const c of linked.slice(0, 20)) {
      if (c.host == null) continue;
      const pr = await this.deps.host.pull(c.host.number);
      out.push(await this.reconsider(event, c.id, pr, `issue #${issue.number} was ${action}`));
    }
    return out.length > 0 ? out : [{ event, action: "ignored", detail: "no open PR closes it" }];
  }

  private async reconsider(event: string, changeId: string, pr: PullRequest, reason: string): Promise<SyncOutcome> {
    const { store } = this.deps.ports;
    const change = await store.getChange(changeId);
    if (change?.host == null || change.headSha === null) return { event, action: "ignored", detail: "not graded yet", changeId };
    const repo = await store.getRepo(change.repoId);
    if (repo?.host == null) return { event, action: "ignored", detail: "repo not mirrored", changeId };
    const before = change.planId === null ? null : await store.getPlan(change.planId);
    const link = await resolvePlan(this.deps, this.deps.host, {
      pr, githubRepoId: repo.host.githubRepoId, repoId: repo.id, mirror: repo.artifactsName, baseSha: change.baseSha,
    });
    const after = link.planId === null ? null : await store.getPlan(link.planId);
    const category = claimedCategoryOf(pr) ?? change.claim.category;
    await store.updateChange(changeId, {
      title: (pr.title || `#${pr.number}`).slice(0, 200),
      claim: { category, summary: pr.body?.slice(0, 10_000) ?? null },
      planId: link.planId,
      host: { ...change.host, issueRefs: link.issueRefs },
    });
    const changed =
      category !== change.claim.category ||
      link.planId !== change.planId ||
      (before?.status ?? null) !== (after?.status ?? null);
    if (!changed) return { event, action: "recorded", detail: "nothing that grades changed", changeId };
    const head = change.headSha;
    try {
      await this.deps.host.publisher?.staleOlder(changeId, pr.number, head, { sameHeadToo: true });
      await this.deps.host.startCheck(changeId, head, { fresh: true });
    } catch (e) {
      await this.log("github.check-start-failed", `change:${changeId}`, { headSha: head, error: (e as Error).message });
    }
    const out = await this.deps.coordinator(changeId).regrade({ changeId, reason });
    await this.log("github.pr-regrade", `change:${changeId}`, { headSha: head, reason, plan: link, category });
    return { event, action: out.action === "ignored" ? "ignored" : "graded", detail: reason, changeId, headSha: head };
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
