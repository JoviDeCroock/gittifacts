/**
 * Audit actions in words. The audit log and the rollout timeline both show them; the raw action
 * stays available as a tooltip and in the filter, so these labels are for reading, not matching.
 */
const LABEL: Record<string, string> = {
  "change.started": "Change started",
  "change.bootstrap-started": "Bootstrap change started",
  "change.pushed": "Pushed",
  "change.pipeline-started": "Pipeline started",
  "change.ci-started": "CI started",
  "change.ci-passed": "CI passed",
  "change.ci-failed": "CI failed",
  "change.preview": "Preview deployed",
  "change.screenshots": "Screenshots taken",
  "change.evidence-signed": "Evidence signed",
  "change.judged": "Model judgment recorded",
  "change.judge-skipped": "Model judgment skipped (verified revert)",
  "change.classified": "Lane computed",
  "change.tour-generated": "Tour written",
  "change.tour-failed": "Tour could not be written",
  "change.review-requested": "Review requested",
  "change.reviewed": "Reviewed",
  "change.approved": "Approved",
  "change.queued": "Entered the merge queue",
  "change.merged": "Merged into main",
  "change.killed": "Killed by a person",
  "change.abandoned": "Abandoned",
  "change.revert-opened": "Revert change opened",
  "change.revert-verified": "Revert verified as the exact inverse",
  "change.revert-push-deferred": "Revert push deferred",
  "change.fork-deleted": "Fork deleted",
  "change.fork-gc-failed": "Fork cleanup failed",
  "change.push-grant-refreshed": "Push token refreshed",
  "merge.completed": "Merged into main",
  "merge-queue.enqueued": "Queued",
  "merge-queue.merge-evidence": "Merge evidence signed",
  "merge-queue.evidence-resigned": "Merge evidence re-signed",
  "merge-queue.result-reused": "Earlier test result reused",
  "merge-queue.alarm-error": "Merge queue step failed, retrying",
  "merge-queue.command-dropped": "Merge queue gave up on a step",
  "merge-queue.build-errored": "Batch tree could not be built",
  "merge-queue.batch-timed-out": "Batch stuck past its time limit",
  "merge-queue.batch-gave-up": "Batch gave up after retries",
  "merge-queue.resolution": "Conflict resolved by the resolver agent",
  "merge-queue.approval-requested": "Fresh approval requested",
  "deploy.train-deployed": "Deploy train deployed",
  "deploy.train-released": "Deploy train released",
  "deploy.train-rolled-back": "Deploy train rolled back",
  "deploy.regression-attributed": "Regression traced to this change",
  "deploy.flag-off": "Flag turned off",
  "deploy.revert-failed": "Automatic revert failed: revert it by hand",
  "deployment.created": "Deployment reported",
  "rollout.via-train": "Rolling out on a deploy train",
  "rollout.stage.started": "Stage started",
  "rollout.stage.completed": "Stage completed",
  "rollout.check.passed": "Health check passed",
  "rollout.check.failed": "Health check breached the limit",
  "rollout.watch.started": "Watch window opened",
  "rollout.released": "Released",
  "rollout.rolled-back": "Rolled back to the previous version",
  "rollout.killed": "Killed by a person",
  "rollout.issue-undelivered": "Issue notification not delivered",
  "flag.disabled": "Flag turned off",
  "revert.opened": "Revert change opened",
  "review.approved": "Approved",
  "change.created": "Change opened",
  "plan.created": "Plan drafted",
  "plan.approved": "Plan approved",
  "plan.rejected": "Plan rejected",
  "plan.superseded": "Plan superseded",
  "repo.created": "Repository created",
  "repo.imported": "Repository imported",
  "repo.flag-app-created": "Flag app created",
  "repo.member-removed": "Member removed",
  "repo.platform-config-requested": "Platform config requested",
  "repo.platform-config-proposed": "Platform config proposed",
  "project.unclaimed-created": "Unclaimed project created",
  "project.claimed": "Project claimed",
  "project.claim-refused": "Claim refused",
  "project.expired": "Unclaimed project expired",
  "principal.agent-created": "Agent created",
  "principal.tokens-revoked": "Agent tokens revoked",
  "agent-session.created": "Agent connected",
  "agent-session.revoked": "Agent session revoked",
  "oauth.consent-approved": "Connection approved",
  "oauth.consent-denied": "Connection denied",
  "workspace.opened": "Workspace opened",
  "workspace.pushed": "Workspace pushed",
  "workspace.closed": "Workspace closed",
  "limit.hit": "Limit reached",
};

/** Words that read wrong when only the first letter is capitalised. */
const ACRONYM: Record<string, string> = { ci: "CI", api: "API", mcp: "MCP", oauth: "OAuth", llm: "model", pr: "PR" };

export function actionLabel(action: string): string {
  const known = LABEL[action];
  if (known) return known;
  // Unknown action: spell it out; "change." adds nothing next to a change, so it goes.
  const tail = action.replace(/^change\./, "").replace(/[._-]+/g, " ").trim();
  const words = tail.split(" ").map((w) => ACRONYM[w] ?? w);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Actions a reader should notice: something failed, was undone or was stopped. */
export function isBadAction(action: string): boolean {
  return /failed|rolled-back|killed|regression|alarm-error|refused|undelivered|dropped|errored|timed-out|gave-up/.test(action);
}
