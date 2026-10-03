/**
 * Readable one-liners for audit events ("Stage 25% started", "Error rate 3.1% exceeded the 1.0%
 * limit"), generated server-side from the action and payload. A payload may carry its own
 * `summary` string, which wins; unknown actions fall back to a humanized action name.
 */
import type { AuditEvent } from "@app/domain";

type Payload = Record<string, unknown>;

const str = (p: Payload, k: string): string | null =>
  typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : null;
const num = (p: Payload, k: string): number | null =>
  typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : null;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : "");
const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function humanize(action: string): string {
  const words = action.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SUMMARIES: Record<string, (p: Payload) => string | null> = {
  "plan.created": (p) =>
    str(p, "title") ? `Plan "${clip(str(p, "title")!)}" drafted` : "Plan drafted",
  "plan.approved": (p) =>
    p.approverOwnsAuthor === true ? "Plan approved by the agent's owner" : "Plan approved",
  "plan.rejected": (p) =>
    p.withdrawnByAuthor === true
      ? "Plan withdrawn by its author"
      : str(p, "comment")
        ? `Plan rejected: ${clip(str(p, "comment")!)}`
        : "Plan rejected",
  "plan.superseded": (p) =>
    str(p, "by") ? `Plan superseded by ${str(p, "by")}` : "Plan superseded",
  "principal.agent-created": (p) => {
    const scopes = Array.isArray(p.scopes)
      ? p.scopes.filter((s) => typeof s === "string").join(", ")
      : "";
    return `Agent "${str(p, "name") ?? "agent"}" registered${scopes ? ` with ${scopes}` : ""}`;
  },
  "principal.tokens-revoked": (p) => {
    const n = num(p, "revoked") ?? 0;
    return `${n} token${n === 1 ? "" : "s"} revoked`;
  },
  "change.review-requested": (p) =>
    str(p, "message") ? `Review requested: ${clip(str(p, "message")!)}` : "Review requested",
  "change.started": () => "Change started",
  "change.pushed": (p) => {
    const head = str(p, "headSha") ?? str(p, "after");
    return head ? `Pushed ${short(head)}` : "Pushed";
  },
  "change.pipeline-started": (p) =>
    str(p, "headSha") ? `Pipeline started for ${short(str(p, "headSha"))}` : "Pipeline started",
  "change.ci-started": (p) =>
    str(p, "runId") ? `CI run ${str(p, "runId")} started` : "CI started",
  "change.ci-passed": () => "CI passed",
  "change.ci-failed": (p) => (str(p, "status") ? `CI ${str(p, "status")}` : "CI failed"),
  "change.policy-unavailable": () => "Base policy could not be read: Lane 0 is off for this change",
  "change.evidence-signed": (p) => {
    const n = num(p, "itemCount");
    const unverified = p.verified === false ? " (signature did not verify)" : "";
    return n === null
      ? `Evidence signed${unverified}`
      : `Evidence signed: ${n} item${n === 1 ? "" : "s"}${unverified}`;
  },
  "change.evidence-note-failed": () => "Evidence note could not be written to the fork",
  "change.judged": (p) => {
    const n = num(p, "judgments");
    return n === null
      ? "Reviewer agent judged the diff"
      : `Reviewer agent made ${n} judgment${n === 1 ? "" : "s"}`;
  },
  "change.judge-failed": () => "Reviewer agent judgment failed (treated as unknown)",
  "change.tour-generated": (p) => {
    const n = num(p, "stops");
    return n === null ? "Tour ready" : `Tour ready: ${n} stop${n === 1 ? "" : "s"}`;
  },
  "change.tour-failed": (p) =>
    str(p, "reason") ? `Tour failed: ${clip(str(p, "reason")!)}` : "Tour failed",
  "change.budget-exceeded": () => "AI review budget exceeded",
  "change.blocked": (p) =>
    p.ciStatus === "failed" ? "Blocked: CI failed" : "Blocked: evidence could not be verified",
  "change.queued": (p) => {
    const position = num(p, "position");
    return position === null ? "Queued for merge" : `Queued for merge (position ${position})`;
  },
  "change.approved": () => "Approved for merge",
  "change.changes-requested": () => "Changes requested",
  "change.rejected": () => "Rejected",
  "change.review-expired": () => "Review request expired",
  "change.merge-failed": (p) =>
    str(p, "detail") ? `Merge failed: ${clip(str(p, "detail")!)}` : "Merge failed",
  "change.released": (p) => (str(p, "reason") ? `Released (${str(p, "reason")})` : "Released"),
  "change.rollout-started": () => "Rollout started",
  "change.abandoned": () => "Abandoned",
  "change.killed": (p) => (str(p, "reason") ? `Killed: ${clip(str(p, "reason")!)}` : "Killed"),
  "change.revert-opened": (p) =>
    str(p, "revertId") ? `Revert change ${str(p, "revertId")} opened` : "Revert change opened",
  "change.revert-verified": (p) =>
    p.pureRevertVerified === true ? "Verified as a pure revert" : "Not a pure revert",
  "change.fork-deleted": () => "Fork deleted",
  "repo.created": (p) => (str(p, "name") ? `Repo ${str(p, "name")} created` : "Repo created"),
  "repo.imported": (p) =>
    str(p, "url") ? `Repo imported from ${clip(str(p, "url")!)}` : "Repo imported",
  "rollout.version-uploaded": (p) =>
    str(p, "versionId") ? `Version ${short(str(p, "versionId"))} uploaded` : "Version uploaded",
  "rollout.flag-off": () => "Kill switch: flag turned off",
  "rollout.skipped": (p) =>
    str(p, "reason") ? `Rollout skipped: ${str(p, "reason")}` : "Rollout skipped",
  "change.classified": (p) => {
    const lane = num(p, "lane");
    return lane === null ? "Classified" : `Routed to Lane ${lane}`;
  },
  "change.reviewed": (p) => (str(p, "decision") ? `Review: ${str(p, "decision")}` : "Reviewed"),
  "change.merged": (p) =>
    str(p, "mergedSha") ? `Merged as ${short(str(p, "mergedSha"))}` : "Merged",
  "rollout.stage": (p) => {
    const percent = num(p, "percent");
    return percent === null ? "Rollout stage started" : `Stage ${percent}% started`;
  },
  "rollout.regression": (p) => {
    const rate = num(p, "errorRate");
    const limit = num(p, "maxErrorRateIncrease");
    const groups = num(p, "newIssueGroups");
    if (rate !== null && limit !== null)
      return `Error rate ${pct(rate)} exceeded the ${pct(limit)} limit`;
    if (groups !== null) return `${groups} new issue group${groups === 1 ? "" : "s"} detected`;
    return "Regression detected";
  },
  // Which signal saw it: deploy trains name telemetry-poll regressions `telemetry-<train>-<n>`;
  // any other id is a Workers Issues issue (pushed by the webhook).
  "deploy.regression-attributed": (p) => {
    const issue = str(p, "issueId");
    const train = str(p, "trainId");
    const where = train === null ? "" : ` in train ${train}`;
    if (issue === null) return `Regression attributed${where}`;
    const seenBy = issue.startsWith("telemetry-")
      ? `the Workers Logs poll (${issue})`
      : `Workers Issues (issue ${issue})`;
    return `Regression attributed${where}${p.confirmed === true ? " and confirmed" : ""}, seen by ${seenBy}`;
  },
  "deploy.revert-failed": (p) =>
    `Automatic revert could not be opened${str(p, "error") ? ` (${clip(str(p, "error")!)})` : ""}: revert it by hand`,
  // The merge queue says why a step stopped and what happens next (journey 06: "no reason").
  "merge-queue.command-dropped": (p) => {
    const type = str(p, "type") ?? "a step";
    const n = num(p, "attempts");
    const cls = str(p, "errorClass");
    const err = str(p, "error");
    const why =
      err === null ? "no error recorded" : `${cls === null ? "" : `${cls}: `}${clip(err, 160)}`;
    const next = str(p, "next");
    return `Merge queue gave up on ${type}${n === null ? "" : ` after ${n} attempt${n === 1 ? "" : "s"}`} (${why})${next === null ? "" : `. Next: ${clip(next, 120)}`}`;
  },
  "merge-queue.build-errored": (p) =>
    `Batch tree could not be built (${clip(str(p, "message") ?? "no error recorded", 160)}); rebuilding it`,
  "merge-queue.batch-timed-out": (p) => {
    const ms = num(p, "limitMs");
    const what = str(p, "state") === "building" ? "building its tree" : "in CI";
    return `Batch stuck ${what} past the ${ms === null ? "time" : `${Math.round(ms / 60_000)} min`} limit; rebuilt, and a person was notified`;
  },
  "merge-queue.batch-gave-up": (p) =>
    `Batch gave up${num(p, "retries") === null ? "" : ` after ${num(p, "retries")} retries`}${str(p, "why") ? `: ${clip(str(p, "why")!)}` : ""}`,
  "merge-queue.alarm-error": (p) =>
    `Merge queue step failed, retrying${str(p, "error") ? ` (${clip(str(p, "error")!)})` : ""}`,
  "merge-queue.resolution": (p) => {
    const status = str(p, "status");
    const kind = str(p, "kind") ?? "a";
    if (status === "resolved")
      return `Resolver agent resolved the ${kind} conflict${str(p, "newHead") ? ` as ${short(str(p, "newHead"))}` : ""}`;
    return `Resolver agent could not resolve the ${kind} conflict${str(p, "cause") ? ` (${str(p, "cause")})` : ""}`;
  },
  "merge-queue.approval-requested": (p) => {
    const lane = num(p, "lane");
    const reasons = Array.isArray(p.reasons) ? p.reasons.filter((r) => typeof r === "string") : [];
    const resolution = reasons.some((r) => r.startsWith("merge-queue.resolution"));
    return `${resolution ? "The resolution needs" : "Needs"} a fresh${lane === null ? "" : ` Lane ${lane}`} approval${reasons.length > 0 ? ` (${clip(reasons.join(", "), 120)})` : ""}`;
  },
  "rollout.released": () => "Released: the watch window closed clean",
  "rollout.rolled-back": () => "Rolled back to the previous version",
};

export function summarizeAudit(
  event: Pick<AuditEvent, "action" | "subject">,
  payload: unknown,
): string {
  const p: Payload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Payload) : {};
  const own = str(p, "summary");
  if (own) return clip(own, 200);
  const known = SUMMARIES[event.action]?.(p);
  if (known) return known;
  const detail = str(p, "message") ?? str(p, "reason");
  return detail ? `${humanize(event.action)}: ${clip(detail)}` : humanize(event.action);
}
