/**
 * Approvals from GitHub (spec §3.4): a PR review (APPROVED / CHANGES_REQUESTED) or the check
 * run's buttons, mapped to the same record as an approval on gittifacts (`recordHostReview`).
 * It counts only from a human with write access to the repo who is not the PR's author; agents
 * and bots never approve. The sender is re-checked with GitHub every time (a button can be pressed
 * by anyone who can see the check run).
 */
import { recordHostReview } from "@app/coordinator";
import type { Identity } from "@app/host";
import { z } from "zod";
import type { GitHubHost } from "./adapter.js";
import { changeIdFor } from "./ids.js";
import { identityOf } from "./normalize.js";
import type { GithubDelivery } from "./payloads.js";
import { GithubAccount, GithubRepo, PullRequestReviewEvent } from "./payloads.js";
import type { GithubSyncDeps, SyncOutcome } from "./sync.js";
import { askForQa } from "./sync-qa.js";

const REVIEW_STATES: Record<string, "approve" | "request-changes"> = {
  approved: "approve",
  changes_requested: "request-changes",
};

/**
 * Who may approve: a human with write access who isn't the author. Null = may; else why not.
 * A full-review request only adds scrutiny, so the author may ask for one (`approving: false`).
 */
async function mayReview(
  host: GitHubHost,
  who: Identity & { login: string },
  authorId: number,
  approving = true,
): Promise<string | null> {
  if (who.kind !== "human")
    return `${who.login} is ${who.kind === "agent" ? "a coding agent" : "a bot"}: only humans approve`;
  if (approving && Number(who.id) === authorId)
    return "the author can't approve their own pull request";
  if (host.publisher === null || !(await host.publisher.canWrite(who.login)))
    return `${who.login} has no write access to the repository`;
  return null;
}

export async function onReview(
  deps: GithubSyncDeps,
  delivery: GithubDelivery,
): Promise<SyncOutcome> {
  const event = delivery.event;
  const p = PullRequestReviewEvent.safeParse(delivery.payload);
  if (!p.success) return { event, action: "ignored", detail: "unreadable review payload" };
  const decision = REVIEW_STATES[p.data.review.state.toLowerCase()];
  if (decision === undefined)
    return { event, action: "ignored", detail: "a comment, not a decision" };
  const pr = p.data.pull_request;
  const changeId = changeIdFor(p.data.repository.id, pr.number);
  const who = { ...identityOf(p.data.review.user), login: p.data.review.user.login };
  const why = await mayReview(deps.host, who, pr.user.id);
  if (why !== null) return refused(deps, event, changeId, why);
  const principalId = await (deps.reviewerPrincipal ?? deps.authorPrincipal)(who);
  const out = await recordHostReview(deps.ports, {
    changeId,
    headSha: p.data.review.commit_id,
    reviewer: { principalId, kind: "human" },
    decision,
    source: "github-review",
    id: `ghr-${p.data.review.id}`,
  });
  if (!out.recorded) return refused(deps, event, changeId, out.reason);
  await refreshSummary(
    deps,
    changeId,
    p.data.repository.owner.login,
    p.data.repository.name,
    pr.number,
  );
  return {
    event,
    action: "recorded",
    detail: `${decision} by ${who.login}`,
    changeId,
    headSha: out.review.headSha,
  };
}

const CheckAction = z.object({
  action: z.literal("requested_action"),
  check_run: z
    .object({
      id: z.number(),
      head_sha: z.string(),
      name: z.string(),
      external_id: z.string().nullable().optional(),
    })
    .passthrough(),
  requested_action: z.object({ identifier: z.enum(["approve_tour", "full_review", "run_qa"]) }),
  repository: GithubRepo,
  sender: GithubAccount,
});

export async function onCheckAction(
  deps: GithubSyncDeps,
  delivery: GithubDelivery,
): Promise<SyncOutcome> {
  const event = delivery.event;
  const p = CheckAction.safeParse(delivery.payload);
  if (!p.success || p.data.check_run.name !== "gittifacts/lane")
    return { event, action: "ignored", detail: "not our button" };
  const changeId = p.data.check_run.external_id ?? "";
  const change = await deps.ports.store.getChange(changeId);
  if (change?.host == null || change.repoId !== `gh-${p.data.repository.id}`) {
    return { event, action: "ignored", detail: "unknown change" };
  }
  if (p.data.requested_action.identifier === "run_qa") {
    if (change.headSha !== p.data.check_run.head_sha)
      return refused(deps, event, changeId, "the button is on an older head");
    return askForQa(deps, { event, changeId, account: p.data.sender, via: "github-check" });
  }
  const who = { ...identityOf(p.data.sender), login: p.data.sender.login };
  const approving = p.data.requested_action.identifier === "approve_tour";
  const why = await mayReview(deps.host, who, change.host.author.id, approving);
  if (why !== null) return refused(deps, event, changeId, why);
  const head = p.data.check_run.head_sha;
  if (p.data.requested_action.identifier === "full_review") {
    if (change.headSha !== head)
      return refused(deps, event, changeId, "the button is on an older head");
    await deps.host.publisher?.recordFullReview(changeId, head, who.login);
    // A full review asked for: the walkthrough's flagged stops go on the diff for this head.
    try {
      await deps.host.publishRequestedTour(changeId, change.host.number);
    } catch (e) {
      await deps.ports.audit.append({
        principalId: "system",
        action: "github.review-post-failed",
        subject: `change:${changeId}`,
        payload: { error: (e as Error).message },
      });
    }
    await deps.ports.audit.append({
      principalId: await (deps.reviewerPrincipal ?? deps.authorPrincipal)(who),
      action: "change.full-review-requested",
      subject: `change:${changeId}`,
      payload: { headSha: head, via: "github-check", login: who.login },
    });
  } else {
    const out = await recordHostReview(deps.ports, {
      changeId,
      headSha: head,
      reviewer: {
        principalId: await (deps.reviewerPrincipal ?? deps.authorPrincipal)(who),
        kind: "human",
      },
      decision: "approve",
      source: "github-check",
      id: `ghc-${p.data.check_run.id}-${p.data.sender.id}`,
    });
    if (!out.recorded) return refused(deps, event, changeId, out.reason);
  }
  await refreshSummary(
    deps,
    changeId,
    p.data.repository.owner.login,
    p.data.repository.name,
    change.host.number,
  );
  return {
    event,
    action: "recorded",
    detail: `${p.data.requested_action.identifier} by ${who.login}`,
    changeId,
    headSha: head,
  };
}

async function refused(
  deps: GithubSyncDeps,
  event: string,
  changeId: string,
  reason: string,
): Promise<SyncOutcome> {
  await deps.ports.audit.append({
    principalId: "system",
    action: "github.review-not-counted",
    subject: `change:${changeId}`,
    payload: { reason },
  });
  return { event, action: "ignored", detail: reason, changeId };
}

/** The summary comment shows approvals: refresh it (best effort). */
export async function refreshSummary(
  deps: GithubSyncDeps,
  changeId: string,
  owner: string,
  repo: string,
  number: number,
) {
  try {
    await deps.host.publishSummary({ host: "github", owner, repo, number });
  } catch (e) {
    await deps.ports.audit.append({
      principalId: "system",
      action: "github.summary-failed",
      subject: `change:${changeId}`,
      payload: { error: (e as Error).message },
    });
  }
}
