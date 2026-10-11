/**
 * Plans on GitHub (spec §3.5): a PR links a Plan by
 *   (a) an issue it closes (`Closes #N`) labelled `gittifacts:plan` by someone with write access
 *       who wrote neither the issue nor the PR (that label is the approval);
 *   (b) a plan file `.platform/plans/<id>.md` on the default branch, referenced in the PR body
 *       (`gittifacts-plan: <id>`), imported as a draft a human approves on gittifacts;
 *   (c) a Plan created on gittifacts, referenced the same way.
 * Plan content is never read from the PR's head: files come from the base, issues from GitHub.
 */
import type { Plan } from "@app/domain";

export const PLAN_LABEL = "gittifacts:plan";

/** `#N` from closing keywords in a PR body (GitHub's own list), same repo only. */
export function closingIssues(body: string | null): number[] {
  const out = new Set<number>();
  for (const m of (body ?? "").matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})\b/gi,
  )) {
    out.add(Number(m[1]));
  }
  return [...out];
}

export const issuePlanId = (githubRepoId: number, issue: number) => `ghi-${githubRepoId}-${issue}`;
export const filePlanId = (githubRepoId: number, fileId: string) => `ghp-${githubRepoId}-${fileId}`;
export const PLAN_FILE_ID = /^[A-Za-z0-9_-]{1,40}$/;

const section = (md: string, heading: RegExp): string | null => {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s/.test(l) && heading.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
};

const bullets = (text: string | null): string[] =>
  (text ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, "").trim())
    .filter((l, i, all) => l.length > 0 && all.indexOf(l) === i)
    .map((l) => l.slice(0, 1000))
    .slice(0, 50);

export interface PlanText {
  title: string;
  intent: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  scopePaths: string[];
}

/**
 * Markdown → plan fields. Title: the first `#` heading (or `fallbackTitle`). Intent: the text
 * before the first `##` (or an `## Intent` section). Lists: `## Acceptance criteria`,
 * `## Out of scope`, `## Scope` (paths/globs). Task-list items count as acceptance criteria.
 */
export function parsePlanMarkdown(md: string, fallbackTitle: string): PlanText {
  const title = (/^#\s+(.+)$/m.exec(md)?.[1] ?? fallbackTitle).trim().slice(0, 200);
  const intentSection = section(md, /intent|why/i);
  const lead =
    md
      .replace(/^#\s+.+$/m, "")
      .split(/^##\s/m)[0]
      ?.trim() ?? "";
  const intent = (intentSection ?? lead).trim();
  const criteria = bullets(section(md, /acceptance|done when|criteria/i));
  const tasks = [...md.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)].map((m) => (m[1] ?? "").trim());
  return {
    title: title.length >= 3 ? title : `${title} plan`,
    intent: (intent.length >= 10
      ? intent
      : `${title}: ${intent || "see the linked description"}`
    ).slice(0, 10_000),
    acceptanceCriteria: (criteria.length > 0
      ? criteria
      : tasks.length > 0
        ? tasks
        : [`Done as described: ${title}`]
    ).slice(0, 50),
    outOfScope: bullets(section(md, /out of scope|non-goals/i)),
    scopePaths: bullets(section(md, /^#{2,3}\s+scope\b/i))
      .filter((p) => !/\s/.test(p))
      .slice(0, 100),
  };
}

/** A Plan row from parsed text (approval fields set by the caller). */
export function planFrom(
  text: PlanText,
  input: { id: string; repoId: string; authorId: string; createdAt: string },
): Plan {
  return {
    id: input.id,
    repoId: input.repoId,
    title: text.title,
    intent: text.intent,
    acceptanceCriteria: text.acceptanceCriteria,
    outOfScope: text.outOfScope,
    riskDeclarations: [],
    scopePaths: text.scopePaths,
    affectedRoutes: [],
    status: "draft",
    authorId: input.authorId,
    approvedBy: null,
    approvedAt: null,
    approvalSignature: null,
    supersedes: null,
    createdAt: input.createdAt,
  };
}
