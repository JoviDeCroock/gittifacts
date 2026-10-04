/**
 * QA in a browser on a pull request (docs/research/agentic-qa.md §5): no comment of its own. The
 * one summary comment gets an optional QA line and fold (`SummaryState.qa`), and the check run a
 * QA fold in its text. This module owns those words; the comment and check-run layouts call it.
 *
 * Images: thumbnails only, through signed platform URLs that expire (GitHub's Camo proxy must fetch
 * them publicly; an App can't upload attachments). Each links to the full report on gittifacts.
 */
import type { SummaryQa } from "./pr-writes.js";
import { plural } from "./terms.js";

export type QaVerdictWord = "pass" | "fail" | "couldnt-test";

export interface QaView {
  runId: string;
  headSha: string;
  /** "done": verdicts exist; "failed": the run could not test (error says why). */
  status: "queued" | "running" | "done" | "failed";
  passed: number;
  failed: number;
  couldntTest: number;
  criteria: Array<{ text: string; verdict: QaVerdictWord; reason: string; notes?: string[] }>;
  /** ≤ 4 signed thumbnail URLs (expire), each with its alt text. */
  thumbs: Array<{ url: string; alt: string }>;
  /** The full report on gittifacts (sign-in required). */
  reportUrl: string;
  error: string | null;
  /** Who asked, as GitHub shows them ("@octocat") or the platform's name. */
  requestedBy: string | null;
  /** Approvals this run withdrew (a failed criterion after approval): who had approved. */
  withdrawn?: string[];
}

export const QA_TERMS = {
  name: "QA",
  button: { label: "Run QA", description: "Test the app in a browser" },
  verdict: { pass: "Pass", fail: "Fail", "couldnt-test": "Couldn't test" } as Record<
    QaVerdictWord,
    string
  >,
  commentCommand: "/gittifacts qa",
} as const;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function counts(qa: QaView): string {
  const parts = [`${qa.passed} passed`];
  if (qa.failed > 0) parts.push(`${qa.failed} failed`);
  if (qa.couldntTest > 0) parts.push(`${qa.couldntTest} couldn't test`);
  return parts.join(", ");
}

/** The status line (the summary adds "**QA** · " in front of it). */
export function qaStatusLine(qa: QaView): string {
  const report = `[QA report](${qa.reportUrl})`;
  if (qa.status === "queued" || qa.status === "running")
    return `testing \`${qa.headSha.slice(0, 7)}\` in a browser. ${report}`;
  if (qa.status === "failed")
    return `could not test this head${qa.error ? `: ${cut(oneLine(qa.error), 140)}` : ""}. ${report}`;
  const withdrawn = (qa.withdrawn ?? []).length > 0 ? ` · approval by ${(qa.withdrawn ?? []).join(", ")} withdrawn: QA failed` : "";
  return `${counts(qa)} of ${plural(qa.criteria.length, "criterion", "criteria")}${withdrawn} · ${report}`;
}

/** Thumbnails in one row, each a link to the report (GitHub renders HTML <img> through Camo). */
export function qaThumbs(qa: QaView): string {
  return qa.thumbs
    .slice(0, 4)
    .map(
      (t) =>
        `<a href="${qa.reportUrl}"><img src="${t.url}" width="200" alt="${cut(oneLine(t.alt), 100).replace(/"/g, "&quot;")}"></a>`,
    )
    .join(" ");
}

/** The folded detail: each criterion with its verdict, the thumbnails, the link. */
export function qaDetailsText(qa: QaView): string | null {
  if (qa.status !== "done") return null;
  const out: string[] = [];
  for (const c of qa.criteria.slice(0, 12)) {
    out.push(
      `- **${QA_TERMS.verdict[c.verdict]}** · ${cut(oneLine(c.text), 160)}${c.verdict === "pass" ? "" : ` (${cut(oneLine(c.reason), 200)})`}`,
    );
  }
  if (qa.criteria.length > 12) out.push(`- and ${qa.criteria.length - 12} more in the report`);
  // Untraced expectations that didn't hold: shown, never counted (they don't decide a verdict).
  const notes = qa.criteria.slice(0, 12).flatMap((c) => (c.notes ?? []).slice(0, 2));
  if (notes.length > 0) out.push("", "Also observed (not counted; it isn't what a criterion says):", ...notes.slice(0, 6).map((n) => `- ${cut(oneLine(n.replace(/^also observed: /, "")), 240)}`));
  if (qa.thumbs.length > 0) out.push("", qaThumbs(qa));
  out.push(
    "",
    `Screenshots of every step and a replay: [QA report on gittifacts](${qa.reportUrl}). Thumbnail links expire after 72 hours.`,
  );
  if (qa.requestedBy !== null) out.push("", `Requested by ${qa.requestedBy}.`);
  return out.join("\n");
}

/** The summary comment's QA section (`SummaryQa`, pr-writes.ts) for a run. */
export function qaSummary(qa: QaView): SummaryQa {
  return { status: qaStatusLine(qa), details: qaDetailsText(qa) };
}

/** The QA fold in the check run's text: the same section as the summary comment's. */
export function qaCheckText(qa: SummaryQa): string {
  const lines = [`**${QA_TERMS.name}** · ${qa.status}`, ""];
  if (qa.details != null && qa.details !== "")
    lines.push(
      `<details><summary>${QA_TERMS.name} details</summary>`,
      "",
      qa.details,
      "",
      "</details>",
      "",
    );
  return lines.join("\n");
}
