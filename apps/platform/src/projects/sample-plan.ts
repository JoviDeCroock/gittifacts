/**
 * The sample Plan of a template repo (onboarding's golden path, DECISIONS 2026-10-11):
 * create_project drafts the template's `samplePlan` (@app/conventions) as a Plan authored by the
 * platform (`system`). A human approves it like any Plan: the platform never approves anything,
 * and no principal approves its own Plan, so the human (or, in an unclaimed repo, its claimer)
 * may. An agent then builds it with `start_change({ planId })` and the merge queue lands it.
 *
 * The id is derived from the repo id, so a retried create_project finds the same Plan.
 */
import { isTemplateId, pageUrl, TEMPLATES } from "@app/conventions";
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import type { Plan, Repo } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import type { Services } from "../app-env.js";
import { planContentHash } from "../services/plans.js";

export interface SamplePlanRef {
  planId: string;
  title: string;
  /** The page a human opens to approve it. */
  url: string;
}

export async function samplePlanIdFor(repoId: string): Promise<string> {
  return `plan_sample_${(await sha256Hex(`sample-plan\u0000${repoId}`)).slice(0, 24)}`;
}

/** Drafts the template's sample Plan in `repo` (null: not a template repo). Idempotent. */
export async function draftSamplePlan(svc: Services, repo: Repo): Promise<SamplePlanRef | null> {
  if (repo.template === null || !isTemplateId(repo.template)) return null;
  const sample = TEMPLATES[repo.template].samplePlan;
  const id = await samplePlanIdFor(repo.id);
  const ref = { planId: id, title: sample.title, url: pageUrl(svc.origin, { planId: id }) };
  if ((await svc.store.getPlan(id)) !== null) return ref;
  const plan: Plan = {
    id,
    repoId: repo.id,
    title: sample.title,
    intent: sample.intent,
    acceptanceCriteria: [...sample.acceptanceCriteria],
    outOfScope: [...sample.outOfScope],
    riskDeclarations: [],
    scopePaths: [...sample.scopePaths],
    affectedRoutes: [...sample.affectedRoutes],
    status: "draft",
    authorId: SYSTEM_PRINCIPAL_ID,
    approvedBy: null,
    approvedAt: null,
    approvalSignature: null,
    supersedes: null,
    createdAt: svc.clock.now().toISOString(),
  };
  try {
    await svc.store.insertPlan(plan);
  } catch (e) {
    // A concurrent retry of the same create_project inserted it first.
    if ((await svc.store.getPlan(id)) !== null) return ref;
    throw e;
  }
  await svc.audit.append({
    principalId: SYSTEM_PRINCIPAL_ID,
    action: "plan.created",
    subject: `plan:${id}`,
    payload: {
      repoId: repo.id,
      title: plan.title,
      contentHash: await planContentHash(plan),
      supersedes: null,
      sample: repo.template,
    },
  });
  return ref;
}
