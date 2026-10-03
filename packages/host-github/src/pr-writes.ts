/**
 * What gittifacts writes on a pull request besides the check run (spec §3.4, research §1.1 and
 * §9.7–9.8): one COMMENT review per head carrying the tour (≤ 20 inline stops anchored to their
 * hunks; least-confident and not-done in the body), and one summary comment edited in place.
 * Reviews can't be deleted or moved, so a newer head stales the older review (body and stops say
 * "stale") and minimizes it. Nothing here approves or blocks.
 */
import type { LaneVerdict } from "@app/host";
import type { Tour, TourStop } from "@app/domain";

export const MAX_INLINE_STOPS = 20;
export const BODY_MAX = 60_000;
export const SUMMARY_MARKER = "<!-- gittifacts:summary -->";

const VERDICT_WORD = { proven: "Proven", unproven: "Unproven", risk: "Risk" } as const;
const LANE_WORD = { 0: "Lane 0: no review needed", 1: "Lane 1: a quick look with a guided tour", 2: "Lane 2: full review" } as const;

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
}

const short = (sha: string) => sha.slice(0, 7);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function stopBody(stop: TourStop, i: number, n: number): string {
  const evidence = stop.evidenceRefs.length > 0 ? `\n\nEvidence: ${stop.evidenceRefs.map((e) => `\`${e}\``).join(", ")}` : "";
  return `**Stop ${i + 1} of ${n} · ${VERDICT_WORD[stop.verdict]} · ${stop.kind}**: ${stop.title}\n\n${cut(stop.why, 1200)}${evidence}`;
}

function anchor(stop: TourStop): Omit<ReviewComment, "body"> | null {
  const h = stop.hunkRefs[0];
  if (h === undefined) return null;
  const side = h.side === "base" ? "LEFT" : "RIGHT";
  const base = { path: h.file, line: h.endLine, side } as const;
  return h.startLine < h.endLine ? { ...base, start_line: h.startLine, start_side: side } : base;
}

/** The review for one head: `POST /pulls/{n}/reviews`, event COMMENT, pinned to the graded commit. */
export function tourReview(tour: Tour, verdict: Pick<LaneVerdict, "lane" | "shadow">, detailsUrl: string, opts: { inline?: boolean } = {}) {
  const n = tour.stops.length;
  const comments: ReviewComment[] = [];
  const unanchored: string[] = [];
  tour.stops.forEach((stop, i) => {
    const a = opts.inline === false || comments.length >= MAX_INLINE_STOPS ? null : anchor(stop);
    if (a === null) unanchored.push(stopBody(stop, i, n));
    else comments.push({ ...a, body: stopBody(stop, i, n) });
  });
  const lines = [
    `### gittifacts tour · ${LANE_WORD[verdict.lane]}${verdict.shadow ? " (shadow)" : ""}`,
    "",
    `${n} stop${n === 1 ? "" : "s"} for \`${short(tour.headSha)}\`, riskiest first. [The tour with its evidence on gittifacts](${detailsUrl})`,
    "",
    "**Least confident**",
    ...tour.leastConfident.map((x) => `- ${x}`),
    "",
    "**Not done**",
    ...tour.notDone.map((x) => `- ${x}`),
  ];
  if (unanchored.length > 0) lines.push("", "**Stops without a line in the diff**", "", ...unanchored.map((b) => `> ${b.replace(/\n/g, "\n> ")}\n`));
  lines.push("", "_This review only comments. It never approves, requests changes or blocks a merge._");
  return {
    commit_id: tour.headSha,
    event: "COMMENT" as const,
    body: cut(lines.join("\n"), BODY_MAX),
    comments,
  };
}

/** A review whose head was replaced: its body says so (the stops say so too, one by one). */
export function staleReviewBody(oldHead: string, newHead: string, detailsUrl: string): string {
  return `### gittifacts tour · stale\n\nThis tour was for \`${short(oldHead)}\`. A newer head (\`${short(newHead)}\`) was pushed; its tour replaces this one. [Current tour on gittifacts](${detailsUrl})`;
}

export function staleStopBody(oldHead: string): string {
  return `**Stale.** This stop belonged to the tour of \`${short(oldHead)}\`; a newer head was pushed.`;
}

export interface SummaryState {
  headSha: string;
  verdict: Pick<LaneVerdict, "lane" | "shadow" | "blocked"> | null;
  tour: "posted" | "pending" | "not-needed" | "failed";
  stops: number;
  plan: { title: string; approved: boolean } | null;
  approvals: { by: string; via: string }[];
  changesRequested: { by: string; via: string }[];
  fullReview: { by: string }[];
  detailsUrl: string;
  shadow: boolean;
}

/** The one summary comment (`issues/{n}/comments`), edited in place only when this text changes. */
export function summaryBody(s: SummaryState): string {
  const head = s.verdict === null ? "grading" : s.verdict.blocked ? "Blocked: CI failed or the evidence did not verify" : LANE_WORD[s.verdict.lane];
  const tour = { posted: `${s.stops} stop${s.stops === 1 ? "" : "s"} in the review below`, pending: "being written", "not-needed": "not needed", failed: "could not be written (counted as Lane 2)" }[s.tour];
  const who = (xs: { by: string; via: string }[]) => xs.map((x) => `${x.by} (${x.via})`).join(", ");
  const rows = [
    `| Head | \`${short(s.headSha)}\` |`,
    `| Tour | ${tour} |`,
    `| Plan | ${s.plan === null ? "none linked" : `${cut(s.plan.title, 120)} (${s.plan.approved ? "approved" : "not approved yet"})`} |`,
    `| Approved by | ${s.approvals.length === 0 ? "nobody yet" : who(s.approvals)} |`,
  ];
  if (s.changesRequested.length > 0) rows.push(`| Changes requested by | ${who(s.changesRequested)} |`);
  if (s.fullReview.length > 0) rows.push(`| Full review requested by | ${s.fullReview.map((x) => x.by).join(", ")} |`);
  return [
    SUMMARY_MARKER,
    `### gittifacts · ${head}`,
    "",
    s.shadow ? "Shadow mode: graded here, merged on GitHub. Nothing here blocks a merge." : "",
    "",
    "| | |",
    "|---|---|",
    ...rows,
    "",
    `[Tour, evidence and attestation on gittifacts](${s.detailsUrl})`,
  ].join("\n");
}

/** SHA-256 hex of a body (what "changed" means for the summary comment). */
export async function bodyHash(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
