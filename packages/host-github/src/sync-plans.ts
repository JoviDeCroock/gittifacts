/**
 * Which Plan a pull request grades against (spec §3.5; plans.ts says what each source means).
 * Order: an explicit `gittifacts-plan: <id>` (a platform Plan, else a plan file on the default
 * branch), then the first closing issue that carries the plan label. An issue's label counts as
 * approval only from someone with write access who wrote neither the issue nor the PR; otherwise
 * the Plan exists as a draft, which grades as "not approved" (never lowers the lane).
 */
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import type { Plan } from "@app/domain";
import type { Identity } from "@app/host";
import { planRefOf, type GitHubHost } from "./adapter.js";
import { classifyAuthor } from "./identity.js";
import type { PullRequest } from "./payloads.js";
import { closingIssues, filePlanId, issuePlanId, PLAN_FILE_ID, PLAN_LABEL, parsePlanMarkdown, planFrom } from "./plans.js";
import type { GithubSyncDeps } from "./sync.js";

export interface PlanLink {
  planId: string | null;
  issueRefs: number[];
  /** Where it came from (audit). */
  source: "platform" | "file" | "issue" | null;
}

const sameContent = (a: Plan, b: Plan) =>
  JSON.stringify([a.title, a.intent, a.acceptanceCriteria, a.outOfScope, a.scopePaths]) ===
  JSON.stringify([b.title, b.intent, b.acceptanceCriteria, b.outOfScope, b.scopePaths]);

export async function resolvePlan(
  deps: GithubSyncDeps,
  host: GitHubHost,
  input: { pr: PullRequest; githubRepoId: number; repoId: string; mirror: string; baseSha: string },
): Promise<PlanLink> {
  const { store, git, clock } = deps.ports;
  const { pr, repoId } = input;
  const issueRefs = closingIssues(pr.body);
  const ref = planRefOf(pr.body);
  if (ref !== null) {
    const platform = await store.getPlan(ref);
    if (platform !== null && platform.repoId === repoId) return { planId: platform.id, issueRefs, source: "platform" };
    if (PLAN_FILE_ID.test(ref) && deps.plans !== undefined) {
      const id = filePlanId(input.githubRepoId, ref);
      if ((await store.getPlan(id)) !== null) return { planId: id, issueRefs, source: "file" };
      // Read from the base (default branch), never from the PR's head.
      const bytes = await git.readFile(input.mirror, input.baseSha, `.platform/plans/${ref}.md`);
      if (bytes !== null) {
        const text = parsePlanMarkdown(new TextDecoder().decode(bytes), ref);
        await deps.plans.upsert(planFrom(text, { id, repoId, authorId: SYSTEM_PRINCIPAL_ID, createdAt: clock.now().toISOString() }));
        return { planId: id, issueRefs, source: "file" };
      }
    }
  }
  if (deps.plans !== undefined) {
    for (const n of issueRefs.slice(0, 5)) {
      const id = await issuePlan(deps, host, { n, pr, githubRepoId: input.githubRepoId, repoId });
      if (id !== null) return { planId: id, issueRefs, source: "issue" };
    }
  }
  return { planId: null, issueRefs, source: null };
}

async function issuePlan(
  deps: GithubSyncDeps,
  host: GitHubHost,
  input: { n: number; pr: PullRequest; githubRepoId: number; repoId: string },
): Promise<string | null> {
  const plans = deps.plans;
  if (plans === undefined) return null;
  const issue = await host.issue(input.n);
  if (issue === null || !issue.labels.some((l) => l.name === PLAN_LABEL)) return null;
  const labeler = await host.labeledBy(input.n, PLAN_LABEL);
  const who = (a: { login: string; id: number; type: string }): Identity & { login: string } => ({
    kind: classifyAuthor({ login: a.login, type: a.type }),
    id: String(a.id),
    login: a.login,
  });
  const approves =
    labeler !== null &&
    who(labeler).kind === "human" &&
    labeler.id !== issue.user.id &&
    labeler.id !== input.pr.user.id &&
    (await host.publisher?.canWrite(labeler.login)) === true;
  const now = deps.ports.clock.now().toISOString();
  const id = issuePlanId(input.githubRepoId, input.n);
  const authorId = await deps.authorPrincipal(who(issue.user));
  const text = parsePlanMarkdown(`# ${issue.title}\n\n${issue.body ?? ""}`, issue.title);
  const fresh = planFrom(text, { id, repoId: input.repoId, authorId, createdAt: now });
  const existing = await deps.ports.store.getPlan(id);
  if (existing !== null && sameContent(existing, fresh) && (existing.status === "approved") === approves) return id;
  const approver = approves && labeler !== null ? await (deps.reviewerPrincipal ?? deps.authorPrincipal)(who(labeler)) : null;
  await plans.upsert(
    approver === null
      ? fresh
      : { ...fresh, status: "approved", approvedBy: approver, approvedAt: labeler?.at || now },
  );
  return id;
}
