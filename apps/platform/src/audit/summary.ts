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
  "change.pushed": (p) => (str(p, "after") ? `Pushed ${short(str(p, "after"))}` : "Pushed"),
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
