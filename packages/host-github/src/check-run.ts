/**
 * The `gittifacts/lane` check run (spec §3.4, research §1.1 and decision 5): one per head SHA,
 * created when grading starts and completed once with the verdict.
 *
 * Conclusions: `success` = Lane 0 eligible, `neutral` = Lane 1, `action_required` = Lane 2 (and
 * blocked). In shadow mode the check is never required, so none of them blocks a merge; the title
 * says "shadow" plainly. Summary ≤ 60 KB, details on the platform's change page (`details_url`).
 * Buttons appear on the completed run; they record intent until M3.
 */
import type { LaneVerdict } from "@app/host";

export const CHECK_NAME = "gittifacts/lane";
export const SUMMARY_MAX = 60_000;

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
  /** True while the platform runs GitHub mode in shadow (always in M2). */
  shadow: boolean;
}

export const CHECK_ACTIONS = {
  approve_tour: { label: "Approve tour", description: "Approve the guided tour on gittifacts" },
  full_review: { label: "Request full review", description: "Ask for a full human review" },
} as const;
export type CheckActionId = keyof typeof CHECK_ACTIONS;

/** `success` only when nothing needs a human: Lane 0 that still needs an approval is `neutral`. */
export function conclusionOf(v: Pick<LaneVerdict, "lane" | "blocked" | "action">): CheckConclusion {
  if (v.blocked) return "action_required";
  if (v.lane === 0) return v.action === "merge" || v.action === "label-ready" ? "success" : "neutral";
  return v.lane === 1 ? "neutral" : "action_required";
}

const LANE_WORDS = {
  0: "Lane 0: eligible to merge without a human",
  1: "Lane 1: a quick look with a guided tour",
  2: "Lane 2: full review",
} as const;

export function checkTitle(v: Pick<LaneVerdict, "lane" | "blocked">, shadow: boolean): string {
  const what = v.blocked ? "Blocked: CI failed or the evidence did not verify" : LANE_WORDS[v.lane];
  return shadow ? `Shadow · ${what}` : what;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function checkSummary(v: LaneVerdict, ctx: CheckRunContext): string {
  const lines: string[] = [];
  if (ctx.shadow) {
    lines.push(
      "**Shadow mode.** gittifacts graded this head. It changes nothing here, never blocks a merge, and posts no comments or reviews.",
      "",
    );
  }
  lines.push("| | |", "|---|---|", `| Lane | **${v.lane}** |`);
  if (v.computedLane !== v.lane) lines.push(`| Computed lane | ${v.computedLane} (raised by policy) |`);
  lines.push(`| Head | \`${v.headSha.slice(0, 12)}\` |`);
  lines.push(
    `| Evidence | ${v.evidence === null ? "none" : `${v.evidence.verified ? "signed and verified" : "**did not verify**"} (\`${v.evidence.id}\`)`} |`,
  );
  lines.push(`| Tour | ${v.tourStatus} |`);
  if (v.requiresHumanApproval) lines.push("| Human approval | required |");
  for (const d of v.degradations) lines.push(`| Note | ${cell(d.message)} |`);
  const reasons = [...v.reasons].sort((a, b) => b.lane - a.lane);
  if (reasons.length > 0) {
    lines.push("", "### Why", "");
    for (const r of reasons.slice(0, 40)) lines.push(`- \`${r.code}\` (lane ${r.lane}): ${cell(r.message)}`);
    if (reasons.length > 40) lines.push(`- … and ${reasons.length - 40} more on gittifacts`);
  }
  if (ctx.evidence.length > 0) {
    lines.push("", "### Evidence", "", "| Kind | Status | Note |", "|---|---|---|");
    for (const e of ctx.evidence.slice(0, 60)) {
      lines.push(`| ${cell(e.kind)} | ${cell(e.status)} | ${cell((e.note ?? "").slice(0, 300))} |`);
    }
  }
  lines.push("", `[The tour, evidence and attestation on gittifacts](${ctx.detailsUrl})`);
  const out = lines.join("\n");
  if (out.length <= SUMMARY_MAX) return out;
  const tail = `\n\n… cut at 60 KB. [Everything on gittifacts](${ctx.detailsUrl})`;
  return out.slice(0, SUMMARY_MAX - tail.length) + tail;
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
    output: { title: checkTitle(v, ctx.shadow), summary: checkSummary(v, ctx) },
    actions: actions.map((identifier) => ({ identifier, ...CHECK_ACTIONS[identifier] })),
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
      title: input.shadow ? "Shadow · grading" : "Grading",
      summary: "gittifacts is running the evidence for this head (tests at base and head, API and dependency diffs, policy). The lane follows in a minute or two.",
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
      title: "Superseded",
      summary: `A newer head (\`${newHead.slice(0, 12)}\`) was pushed; it is graded instead.`,
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

/**
 * The verdict as the completed check run states it (packages/host-github/src/check-run.ts): the
 * title says shadow and blocked, the table the lane, a raised lane and a required approval, "Why"
 * the reason codes (≤ 40) and "Evidence" the kinds. The inverse of `completedCheckRun`, used by the
 * live contract run (scripts/github-live-contract.ts, GITTIFACTS_READ=check-run).
 */
export function readCheckRunVerdict(output: { title: string | null; summary: string | null }): { verdict: CheckRunVerdict | undefined; kinds: string[] } {
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
      shadow: title.startsWith("Shadow · "),
      blocked: title.includes("Blocked:"),
      requiresHumanApproval: /^\| Human approval \| required \|$/m.test(summary),
      reasons,
    },
    kinds: [...new Set(kinds)].sort(),
  };
}
