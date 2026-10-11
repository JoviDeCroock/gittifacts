/**
 * GitHub deliveries → the host-neutral events (`@app/host`), so the platform reacts to one
 * vocabulary. Pure: no I/O. Anything we don't grade yields [].
 *
 * - pull_request opened/reopened/ready_for_review → change.opened; synchronize → change.updated
 *   (`forced` unknown → true; the sync refines it); closed → change.closed.
 * - pull_request_review submitted → review.submitted (bound to the reviewed commit).
 * - push to the default branch → main.advanced.
 * - merge_group checks_requested → queue.group_created (PR numbers from the queue branch name).
 * Fork PRs are normal events: their head is read from the base repo (`pull/<n>/head`).
 */
import type { HostEvent, Identity } from "@app/host";
import { classifyAuthor } from "./identity.js";
import {
  type GithubAccount,
  type GithubDelivery,
  MergeGroupEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  PushEvent,
} from "./payloads.js";

export interface NormalizeOptions {
  /** Extra agent logins (deployment config). */
  extraAgents?: readonly string[];
}

export function identityOf(
  account: GithubAccount,
  opts: NormalizeOptions & { headRef?: string | null } = {},
): Identity {
  return {
    kind: classifyAuthor(
      { login: account.login, type: account.type, headRef: opts.headRef ?? null },
      opts.extraAgents === undefined ? {} : { extraAgents: opts.extraAgents },
    ),
    id: String(account.id),
    login: account.login,
  };
}

const ownerRepo = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

const REVIEW_DECISIONS: Record<string, "approve" | "request-changes" | "comment"> = {
  approved: "approve",
  changes_requested: "request-changes",
  commented: "comment",
};

/** `refs/heads/gh-readonly-queue/main/pr-104-<sha>` → [104]. */
export function mergeGroupPrNumbers(headRef: string): number[] {
  return [...headRef.matchAll(/(?:^|\/)pr-(\d+)-[0-9a-f]{7,40}/g)].map((m) => Number(m[1]));
}

export function normalizeGithubDelivery(
  delivery: GithubDelivery,
  opts: NormalizeOptions = {},
): HostEvent[] {
  const { event, payload } = delivery;
  if (event === "pull_request") {
    const p = PullRequestEvent.safeParse(payload);
    if (!p.success) return [];
    const pr = p.data.pull_request;
    const ref = {
      host: "github" as const,
      ...ownerRepo(p.data.repository.full_name),
      number: pr.number,
    };
    switch (p.data.action) {
      case "opened":
      case "reopened":
      case "ready_for_review":
        return [
          {
            type: "change.opened",
            ref,
            headSha: pr.head.sha,
            baseSha: pr.base.sha,
            author: identityOf(pr.user, { ...opts, headRef: pr.head.ref }),
          },
        ];
      case "synchronize":
        return [
          {
            type: "change.updated",
            ref,
            headSha: p.data.after ?? pr.head.sha,
            previousHeadSha: p.data.before ?? null,
            forced: true,
          },
        ];
      case "edited":
      case "labeled":
      case "unlabeled": {
        const changes = (p.data as { changes?: Record<string, unknown> }).changes ?? {};
        const what: ("title" | "body" | "labels")[] =
          p.data.action === "edited"
            ? (["title", "body"] as const).filter((k) => k in changes)
            : ["labels"];
        return what.length === 0 ? [] : [{ type: "change.edited", ref, what }];
      }
      case "closed":
        return [
          {
            type: "change.closed",
            ref,
            merged: pr.merged === true,
            mergedSha: pr.merged === true ? pr.merge_commit_sha : null,
          },
        ];
      default:
        return [];
    }
  }
  if (event === "pull_request_review") {
    const p = PullRequestReviewEvent.safeParse(payload);
    if (!p.success || p.data.action !== "submitted") return [];
    const decision = REVIEW_DECISIONS[p.data.review.state.toLowerCase()];
    if (decision === undefined) return [];
    return [
      {
        type: "review.submitted",
        ref: {
          host: "github",
          ...ownerRepo(p.data.repository.full_name),
          number: p.data.pull_request.number,
        },
        headSha: p.data.review.commit_id,
        reviewer: identityOf(p.data.review.user, opts),
        decision,
      },
    ];
  }
  if (event === "push") {
    const p = PushEvent.safeParse(payload);
    if (!p.success) return [];
    const branch = p.data.repository.default_branch;
    if (p.data.ref !== `refs/heads/${branch}` || /^0{40}$/.test(p.data.after)) return [];
    return [
      {
        type: "main.advanced",
        repo: { host: "github", ...ownerRepo(p.data.repository.full_name) },
        branch,
        before: /^0{40}$/.test(p.data.before) ? null : p.data.before,
        after: p.data.after,
      },
    ];
  }
  if (event === "merge_group") {
    const p = MergeGroupEvent.safeParse(payload);
    if (!p.success || p.data.action !== "checks_requested") return [];
    const { owner, repo } = ownerRepo(p.data.repository.full_name);
    const mg = p.data.merge_group;
    return [
      {
        type: "queue.group_created",
        repo: { host: "github", owner, repo },
        groupId: mg.head_ref,
        headSha: mg.head_sha,
        baseSha: mg.base_sha,
        changes: mergeGroupPrNumbers(mg.head_ref).map((number) => ({
          host: "github",
          owner,
          repo,
          number,
        })),
      },
    ];
  }
  return [];
}
