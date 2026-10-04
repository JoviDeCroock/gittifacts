/**
 * The `gittifacts/lane` check run (spec §3.4, research §1.1 and decision 5): one per head SHA,
 * opened when grading starts, updated once with the lane while the tour is written (still in
 * progress, never `success`), and completed once with the verdict.
 *
 * Conclusions: `success` = Lane 0 eligible, `neutral` = Lane 1, `action_required` = Lane 2 (and
 * blocked). In shadow mode the check is never required, so none of them blocks a merge.
 *
 * What a person sees (DECISIONS 2026-10-04 "A calm pull request"): the title is the lane and the
 * one reason (≤ 60 chars, it is the merge box's line), the summary a few lines and the link, and
 * the reasons and evidence fold under `text`. The verdict itself rides along as a hidden JSON
 * comment in `text` for machines (`readCheckRunVerdict`). Words come from `terms.ts`.
 */
import type { LaneVerdict } from "@app/host";
import { z } from "zod";
import { cut, laneLabel, laneWhy, plural, reasonPhrase, short, TERMS } from "./terms.js";

export const CHECK_NAME = "gittifacts/lane";
export const SUMMARY_MAX = 60_000;
export const TITLE_MAX = 60;

export type CheckConclusion = "success" | "neutral" | "action_required" | "cancelled";

export interface EvidenceLine {
  kind: string;
  status: string;
  note?: string | null;
}

export interface CheckRunContext {
  changeId: string;
  detailsUrl: string;
  evidence: readonly EvidenceLine[];
  /** True while the platform runs GitHub mode in shadow. */
  shadow: boolean;
}

/** The ids are machine names and stay; the labels are the product's words (terms.ts). */
export const CHECK_ACTIONS = {
  approve_tour: TERMS.approveButton,
  full_review: TERMS.fullReviewButton,
} as const;
export type CheckActionId = keyof typeof CHECK_ACTIONS;

/** `success` only when nothing needs a human: Lane 0 that still needs an approval is `neutral`. */
export function conclusionOf(v: Pick<LaneVerdict, "lane" | "blocked" | "action">): CheckConclusion {
  if (v.blocked) return "action_required";
  if (v.lane === 0) return v.action === "merge" || v.action === "label-ready" ? "success" : "neutral";
  return v.lane === 1 ? "neutral" : "action_required";
}

type TitleInput = Pick<LaneVerdict, "lane" | "computedLane" | "blocked" | "reasons">;

/** "Full review (Lane 2) · public API changed" (≤ 60 chars); "Blocked: CI failed". */
export function checkTitle(v: TitleInput): string {
  if (v.blocked) {
    const why = v.reasons.find((r) => r.code === "ci.failed" || r.code === "evidence.unverified");
    return `Blocked: ${why === undefined ? TERMS.blockedWhy : reasonPhrase(why)}`;
  }
  return cut(`${laneLabel(v.lane)} · ${laneWhy(v)}`, TITLE_MAX);
}

/** The headline sentence: "**Full review (Lane 2)** · possible hidden behavior change." */
export function headline(v: TitleInput): string {
  if (v.blocked) return `**${checkTitle(v)}.** Nothing can merge until it is fixed.`;
  return `**${laneLabel(v.lane)}** · ${laneWhy(v, { long: true })}.`;
}

/** A few lines: the lane and why, what a person does, the link. */
export function checkSummary(v: LaneVerdict, ctx: CheckRunContext): string {
  const lines = [headline(v)];
  if (!v.blocked) {
    lines.push(v.lane === 0 && v.requiresHumanApproval ? TERMS.policyAsk : TERMS.laneAsk[v.lane]);
  }
  lines.push("", `[${TERMS.openTour} on gittifacts](${ctx.detailsUrl})${ctx.shadow ? `\n\n${TERMS.reportOnlyNote}` : ""}`);
  return lines.join("\n");
}

const oneLine = (s: string) => s.replace(/\r?\n/g, " ");

/** The detail, folded: why this lane (raised, then passed), the evidence, and the verdict for machines. */
export function checkText(v: LaneVerdict, ctx: CheckRunContext): string {
  const raised = v.reasons.filter((r) => r.lane > 0).sort((a, b) => b.lane - a.lane);
  const passed = v.reasons.filter((r) => r.lane === 0);
  const out: string[] = [];
  out.push(`<details><summary>Why this lane: ${raised.length} raised, ${passed.length} passed</summary>`, "");
  for (const r of raised.slice(0, 40)) out.push(`- **${TERMS.laneBadge(r.lane)}** · ${reasonPhrase(r)}: ${cut(oneLine(r.message), 400)}`);
  if (raised.length > 0 && passed.length > 0) out.push("");
  for (const r of passed.slice(0, 40)) out.push(`- ${cut(oneLine(r.message), 200)}`);
  for (const d of v.degradations) out.push(`- Note: ${cut(oneLine(d.message), 300)}`);
  out.push("", "</details>", "");
  if (ctx.evidence.length > 0) {
    const sig = v.evidence === null ? "" : v.evidence.verified ? ", signed and verified" : ", **signature did not verify**";
    out.push(`<details><summary>Evidence: ${plural(ctx.evidence.length, "item")}${sig}</summary>`, "");
    for (const e of ctx.evidence.slice(0, 60)) out.push(`- ${e.kind}: ${e.status}${e.note ? ` (${cut(oneLine(e.note), 240)})` : ""}`);
    out.push("", "</details>", "");
  }
  out.push(`Graded commit \`${short(v.headSha)}\`.`, "", verdictComment(v, ctx));
  const text = out.join("\n");
  if (text.length <= SUMMARY_MAX) return text;
  // Keep the machine line whole; cut the folded detail instead.
  const tail = `\n\n… cut. [Everything on gittifacts](${ctx.detailsUrl})\n\n${verdictComment(v, ctx)}`;
  return text.slice(0, SUMMARY_MAX - tail.length) + tail;
}

const VERDICT_MARK = "gittifacts:verdict";

/** The verdict as a hidden Markdown comment (`readCheckRunVerdict` reads it back). */
function verdictComment(v: LaneVerdict, ctx: CheckRunContext): string {
  const data = {
    lane: v.lane,
    computedLane: v.computedLane,
    shadow: v.shadow,
    blocked: v.blocked,
    requiresHumanApproval: v.requiresHumanApproval,
    reasons: v.reasons.map((r) => r.code),
    kinds: [...new Set(ctx.evidence.map((e) => e.kind))].sort(),
  };
  // `--` can't appear inside an HTML comment; reason codes and kinds never contain it, but be sure.
  return `<!-- ${VERDICT_MARK} ${JSON.stringify(data).replace(/--/g, "-\\u002d")} -->`;
}

/** The PATCH body that completes the run with the verdict. */
export function completedCheckRun(v: LaneVerdict, ctx: CheckRunContext, completedAt: string) {
  const actions: CheckActionId[] = v.blocked ? [] : v.lane === 0 ? ["full_review"] : ["approve_tour", "full_review"];
  return {
    name: CHECK_NAME,
    status: "completed",
    conclusion: conclusionOf(v),
    completed_at: completedAt,
    details_url: ctx.detailsUrl,
    external_id: ctx.changeId,
    output: { title: checkTitle(v), summary: checkSummary(v, ctx), text: checkText(v, ctx) },
    actions: actions.map((identifier) => ({ identifier, ...CHECK_ACTIONS[identifier] })),
  };
}

/**
 * The lane as soon as the classifier has it, while the reviewer agent writes the tour: the run
 * stays `in_progress` (no conclusion, no buttons). The walkthrough can only raise the lane, so Lane 1
 * says "so far"; a Lane 0 (or blocked) classification is never shown early: null, no write.
 */
export function laneRun(v: TitleInput & Pick<LaneVerdict, "requiresHumanApproval">, ctx: Pick<CheckRunContext, "detailsUrl" | "shadow">) {
  if (v.blocked || v.lane === 0) return null;
  return {
    status: "in_progress" as const,
    output: {
      title: `${laneLabel(v.lane)}${v.lane < 2 ? " so far" : ""} · ${TERMS.tour} coming`,
      summary: [
        headline(v),
        `The checks are done. The reviewer agent is writing the ${TERMS.tour}, usually in about a minute; it can only raise the lane.`,
        "",
        `[Follow it on gittifacts](${ctx.detailsUrl})${ctx.shadow ? `\n\n${TERMS.reportOnlyNote}` : ""}`,
      ].join("\n"),
    },
  };
}

/** The POST body that opens the run when grading starts. */
export function startedCheckRun(input: { headSha: string; changeId: string; detailsUrl: string; shadow: boolean; startedAt: string }) {
  return {
    name: CHECK_NAME,
    head_sha: input.headSha,
    status: "in_progress",
    started_at: input.startedAt,
    details_url: input.detailsUrl,
    external_id: input.changeId,
    output: {
      title: "Grading: running the tests and checks",
      summary: `gittifacts is running the tests and checks for this commit. The lane follows in about two minutes, then the ${TERMS.tour}.${input.shadow ? `\n\n${TERMS.reportOnlyNote}` : ""}`,
    },
  };
}

/** Closing a run whose head was replaced before it was graded. */
export function supersededCheckRun(newHead: string, completedAt: string) {
  return {
    status: "completed",
    conclusion: "cancelled" as const,
    completed_at: completedAt,
    output: {
      title: "Replaced by a newer push",
      summary: `\`${short(newHead)}\` was pushed after this commit; that one is graded instead.`,
    },
  };
}

export interface CheckRunVerdict {
  lane: number;
  computedLane: number;
  shadow: boolean;
  blocked: boolean;
  requiresHumanApproval: boolean;
  reasons: { code: string }[];
}

const Hidden = z.object({
  lane: z.number().int().min(0).max(2),
  computedLane: z.number().int().min(0).max(2),
  shadow: z.boolean(),
  blocked: z.boolean(),
  requiresHumanApproval: z.boolean(),
  reasons: z.array(z.string()),
  kinds: z.array(z.string()),
});

/**
 * The verdict a completed run states: the hidden `gittifacts:verdict` comment in `text`, or, for
 * runs written before 2026-10-04, the old summary table. The live contract run uses it
 * (scripts/github-live-contract.ts, GITTIFACTS_READ=check-run).
 */
export function readCheckRunVerdict(output: { title: string | null; summary: string | null; text?: string | null }): { verdict: CheckRunVerdict | undefined; kinds: string[] } {
  const m = new RegExp(`<!-- ${VERDICT_MARK} (\\{.*?\\}) -->`).exec(output.text ?? "");
  if (m !== null) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(m[1] ?? "");
    } catch {
      raw = null;
    }
    const p = Hidden.safeParse(raw);
    if (!p.success) return { verdict: undefined, kinds: [] };
    const { kinds, reasons, ...rest } = p.data;
    return { verdict: { ...rest, reasons: reasons.map((code) => ({ code })) }, kinds };
  }
  return readLegacy(output);
}

/** The pre-2026-10-04 summary table: the title says shadow ("Shadow · ", or "Report-only · ") and blocked; the `| Lane | **N** |` row the lane; Why and Evidence the codes and kinds. */
function readLegacy(output: { title: string | null; summary: string | null }): { verdict: CheckRunVerdict | undefined; kinds: string[] } {
  const title = output.title ?? "";
  const summary = output.summary ?? "";
  const lane = /^\| Lane \| \*\*(\d)\*\* \|$/m.exec(summary);
  if (lane === null) return { verdict: undefined, kinds: [] };
  const raised = /^\| Computed lane \| (\d) /m.exec(summary);
  const section = (name: string) => summary.split(`\n### ${name}\n`)[1]?.split("\n### ")[0] ?? "";
  const reasons = [...section("Why").matchAll(/^- `([^`]+)` \(lane \d\)/gm)].map((m) => ({ code: m[1] ?? "" }));
  const kinds = [...section("Evidence").matchAll(/^\| ([^|]+?) \| [^|]* \|/gm)]
    .map((m) => m[1] ?? "")
    .filter((k) => k !== "Kind" && !/^-+$/.test(k));
  return {
    verdict: {
      lane: Number(lane[1]),
      computedLane: raised === null ? Number(lane[1]) : Number(raised[1]),
      shadow: title.startsWith("Shadow · ") || title.startsWith("Report-only · "),
      blocked: title.includes("Blocked:"),
      requiresHumanApproval: /^\| Human approval \| required \|$/m.test(summary),
      reasons,
    },
    kinds: [...new Set(kinds)].sort(),
  };
}
