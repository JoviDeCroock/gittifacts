/**
 * What gittifacts writes on a pull request besides the check run (spec §3.4, research §1.1 and
 * §9.7–9.8), kept quiet on purpose (DECISIONS 2026-10-04 "A calm pull request"):
 *
 * - the summary comment is the one place a person reads: a few lines up top (lane and why, what a
 *   person does, the tour link), everything else folded in `<details>`;
 * - by default that comment and the check run are all: the walkthrough lives on gittifacts;
 * - on request only (the `gittifacts:walkthrough` label, or Request full review), one COMMENT
 *   review per head with at most 3 inline stops where a person should look (risk, not covered by
 *   tests, not proven) and a one-line body; a newer head minimizes it (no text rewrites);
 * - an optional QA section in the summary (on-demand QA writes there, never a comment of its own).
 *
 * Nothing here approves or blocks. Words come from `terms.ts`.
 */

import type { LaneReason, Tour, TourStop } from "@app/domain";
import type { LaneVerdict } from "@app/host";
import { cut, laneLabel, laneWhy, plural, reasonPhrase, short, TERMS } from "./terms.js";

export const MAX_INLINE_STOPS = 3;
export const BODY_MAX = 60_000;
export const SUMMARY_MARKER = "<!-- gittifacts:summary -->";

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: "RIGHT" | "LEFT";
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
}

/** Why a stop earns a place on the diff (lower is more urgent), or null when it stays in the tour. */
function urgency(stop: TourStop): number | null {
  if (stop.kind === "intent" || stop.hunkRefs.length === 0) return null;
  if (stop.verdict === "risk" || stop.kind === "risk") return 0;
  if (stop.kind === "uncovered") return 1;
  if (stop.verdict === "unproven") return 2;
  return null;
}

/** The stops shown inline: risk first, then not covered, then not proven; tour order within; ≤ 3. */
export function flaggedStops(tour: Pick<Tour, "stops">): { stop: TourStop; index: number }[] {
  return tour.stops
    .map((stop, index) => ({ stop, index, u: urgency(stop) }))
    .filter((x): x is { stop: TourStop; index: number; u: number } => x.u !== null)
    .sort((a, b) => a.u - b.u || a.index - b.index)
    .slice(0, MAX_INLINE_STOPS)
    .map(({ stop, index }) => ({ stop, index }));
}

function label(stop: TourStop): string {
  if (stop.verdict === "risk" || stop.kind === "risk") return TERMS.verdict.risk;
  if (stop.kind === "uncovered") return TERMS.uncovered;
  return TERMS.verdict[stop.verdict];
}

function stopBody(stop: TourStop, i: number, n: number, url: string): string {
  return `**${label(stop)}** · ${stop.title}\n\n${cut(stop.why, 600)}\n\n<sub>Stop ${i + 1} of ${n} in the [${TERMS.tour}](${url}#stop-${i + 1})</sub>`;
}

function anchor(stop: TourStop): Omit<ReviewComment, "body"> | null {
  const h = stop.hunkRefs[0];
  if (h === undefined) return null;
  const side = h.side === "base" ? "LEFT" : "RIGHT";
  const base = { path: h.file, line: h.endLine, side } as const;
  return h.startLine < h.endLine ? { ...base, start_line: h.startLine, start_side: side } : base;
}

/**
 * The review for one head (`POST /pulls/{n}/reviews`, event COMMENT, pinned to the graded commit),
 * or null when no stop needs a person's eye on the diff (the summary links the tour). With
 * `inline: false` (GitHub refused an anchor) the same stops go in the body instead.
 */
export function tourReview(tour: Tour, detailsUrl: string, opts: { inline?: boolean } = {}) {
  const flagged = flaggedStops(tour);
  if (flagged.length === 0) return null;
  const n = tour.stops.length;
  const lead = `${plural(flagged.length, "spot")} worth a look, from the ${TERMS.tour} of \`${short(tour.headSha)}\`. [All ${plural(n, TERMS.stop)} on gittifacts](${detailsUrl})`;
  if (opts.inline === false) {
    const quoted = flagged.map(({ stop, index }) => {
      const h = stop.hunkRefs[0];
      const where = h === undefined ? "" : `\`${h.file}:${h.endLine}\` · `;
      return `> ${where}${stopBody(stop, index, n, detailsUrl).replace(/\n/g, "\n> ")}`;
    });
    return {
      commit_id: tour.headSha,
      event: "COMMENT" as const,
      body: cut([lead, "", ...quoted].join("\n\n"), BODY_MAX),
      comments: [] as ReviewComment[],
    };
  }
  const comments: ReviewComment[] = [];
  for (const { stop, index } of flagged) {
    const a = anchor(stop);
    if (a !== null) comments.push({ ...a, body: stopBody(stop, index, n, detailsUrl) });
  }
  return { commit_id: tour.headSha, event: "COMMENT" as const, body: lead, comments };
}

/** The QA section: one status line up top, the rest (screenshots, steps) folded. */
export interface SummaryQa {
  status: string;
  details?: string | null;
}

export interface SummaryState {
  headSha: string;
  verdict:
    | (Pick<
        LaneVerdict,
        "lane" | "computedLane" | "shadow" | "blocked" | "requiresHumanApproval"
      > & { reasons: LaneReason[] })
    | null;
  tour: "ready" | "pending" | "not-needed" | "failed";
  stops: number;
  /** Stops worth a look (what the review would show on the diff). */
  flagged: number;
  /** The flagged stops are on the diff for this head (asked for, posted or about to be). */
  inline: boolean;
  qa: SummaryQa | null;
  plan: { title: string; approved: boolean } | null;
  approvals: { by: string; via: string }[];
  changesRequested: { by: string; via: string }[];
  fullReview: { by: string }[];
  detailsUrl: string;
  shadow: boolean;
}

const oneLine = (x: string) => x.replace(/\r?\n/g, " ");
/** Text from elsewhere can't fake our markers or mention anyone (a mention notifies). */
const quiet = (x: string) =>
  x.replace(/<!--/g, "&lt;!--").replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@\u200b");

const who = (xs: { by: string; via?: string }[]) =>
  xs.map((x) => (x.via === undefined ? x.by : `${x.by} (${x.via})`)).join(", ");

/** The 3–5 lines a reader sees without opening anything. */
function headlineLines(s: SummaryState): string[] {
  const url = s.detailsUrl;
  const v = s.verdict;
  if (v === null)
    return [
      `**${TERMS.product}** is grading \`${short(s.headSha)}\`. The lane follows in about two minutes. [Follow it on gittifacts](${url})`,
    ];
  const out: string[] = [];
  if (v.blocked) {
    const why = v.reasons.find((r) => r.code === "ci.failed" || r.code === "evidence.unverified");
    out.push(
      `**Blocked: ${why === undefined ? TERMS.blockedWhy : reasonPhrase(why)}.** Nothing can merge until it is fixed.`,
    );
  } else {
    out.push(`**${laneLabel(v.lane)}** · ${laneWhy(v, { long: true })}.`);
    out.push(v.lane === 0 && v.requiresHumanApproval ? TERMS.policyAsk : TERMS.laneAsk[v.lane]);
  }
  const status: string[] = [];
  if (s.approvals.length > 0) status.push(`Approved by ${who(s.approvals)}.`);
  if (s.changesRequested.length > 0)
    status.push(`Changes requested by ${who(s.changesRequested)}.`);
  if (s.fullReview.length > 0) status.push(`Full review requested by ${who(s.fullReview)}.`);
  if (status.length > 0) out.push(status.join(" "));
  const tour = {
    ready: `[${TERMS.openTour} on gittifacts](${url}): ${plural(s.stops, TERMS.stop)}${s.flagged > 0 ? `, ${s.flagged} worth a look${s.inline ? " (marked on the diff)" : ""}` : ""}.`,
    pending: `The ${TERMS.tour} is being written. [Follow it on gittifacts](${url})`,
    "not-needed": `[Details on gittifacts](${url})`,
    failed: `No ${TERMS.tour} could be written, so this needs a full review. [Details on gittifacts](${url})`,
  }[s.tour];
  out.push(tour);
  if (s.qa !== null) out.push(`**${TERMS.qa}** · ${quiet(cut(oneLine(s.qa.status), 300))}`);
  return out;
}

/** The one summary comment (`issues/{n}/comments`), edited in place only when this text changes. */
export function summaryBody(s: SummaryState): string {
  const lines = [
    SUMMARY_MARKER,
    ...headlineLines(s).map((l, i, a) => (i < a.length - 1 ? `${l}  ` : l)),
  ];
  const details: string[] = [];
  const raised =
    s.verdict?.reasons.filter((r) => r.lane > 0 && !r.code.startsWith("shadow.")) ?? [];
  if (raised.length > 0) {
    details.push(
      "**Why this lane**",
      ...raised.slice(0, 12).map((r) => `- ${TERMS.laneBadge(r.lane)} · ${reasonPhrase(r)}`),
    );
    if (raised.length > 12) details.push(`- and ${raised.length - 12} more on gittifacts`);
    details.push("");
  }
  details.push(
    `**${TERMS.plan}**: ${s.plan === null ? "none linked" : `${cut(s.plan.title, 120)} (${s.plan.approved ? "approved" : "not approved yet"})`}  `,
  );
  details.push(`**Approved by**: ${s.approvals.length === 0 ? "nobody yet" : who(s.approvals)}  `);
  details.push(`**Graded commit**: \`${short(s.headSha)}\``);
  if (s.tour === "ready" && s.flagged > 0 && !s.inline) details.push("", TERMS.inlineHow);
  if (s.shadow) details.push("", TERMS.reportOnlyNote);
  lines.push(
    "",
    "<details><summary>Why, Plan and approvals</summary>",
    "",
    ...details,
    "",
    "</details>",
  );
  if (s.qa?.details != null && s.qa.details !== "") {
    lines.push(
      "",
      `<details><summary>${TERMS.qa} details</summary>`,
      "",
      quiet(cut(s.qa.details, 20_000)),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

/** SHA-256 hex of a body (what "changed" means for the summary comment). */
export async function bodyHash(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
