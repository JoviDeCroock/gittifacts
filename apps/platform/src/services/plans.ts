/**
 * Plans are handled by the platform directly (no coordinator): create, approve (signed), reject.
 *
 * Approval signature: Ed25519 (platform key, purpose "gittifacts/plan-approval") over the
 * canonical approval document `{ planId, contentHash, approvedBy, approvedAt }`, where
 * `contentHash` = b64url(SHA-256(canonical(planContent(plan)))). Anyone holding the published
 * key set can re-derive both and verify.
 */
import { type Change, type Plan, PlanDraftInput, type Principal } from "@app/domain";
import { canonicalBytes, sha256Base64url } from "@app/evidence";
import type { Caller, Services } from "../app-env.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import { type PlatformSigner, Purpose, type VerifyOutcome } from "../signing.js";

/** The fields an approval vouches for (everything a reviewer read). */
export function planContent(plan: Plan) {
  return {
    id: plan.id,
    repoId: plan.repoId,
    title: plan.title,
    intent: plan.intent,
    acceptanceCriteria: plan.acceptanceCriteria,
    outOfScope: plan.outOfScope,
    riskDeclarations: plan.riskDeclarations,
    scopePaths: plan.scopePaths,
    affectedRoutes: plan.affectedRoutes,
    authorId: plan.authorId,
    supersedes: plan.supersedes,
  };
}

export async function planContentHash(plan: Plan): Promise<string> {
  return sha256Base64url(canonicalBytes(planContent(plan)));
}

export interface PlanApprovalDocument {
  planId: string;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
}

export async function planApprovalDocument(plan: Plan): Promise<PlanApprovalDocument> {
  if (!plan.approvedBy || !plan.approvedAt) throw new Error(`plan ${plan.id} is not approved`);
  return {
    planId: plan.id,
    contentHash: await planContentHash(plan),
    approvedBy: plan.approvedBy,
    approvedAt: plan.approvedAt,
  };
}

export async function verifyPlanApproval(
  signer: PlatformSigner,
  plan: Plan,
  keyId: string,
): Promise<VerifyOutcome> {
  if (plan.status !== "approved" && plan.status !== "superseded")
    return { ok: false, reason: "not approved" };
  if (!plan.approvalSignature || !plan.approvedAt)
    return { ok: false, reason: "no approval signature" };
  const doc = await planApprovalDocument(plan);
  return signer.verifyDetached(doc, plan.approvalSignature, {
    purpose: Purpose.planApproval,
    keyId,
    signedAt: plan.approvedAt,
  });
}

// ---------------------------------------------------------------- reads

function noSuchPlan(planId: string, repoId = "<repoId>") {
  return notFound(`plan ${planId}`, {
    explanation:
      "No plan with that id. Draft a plan; a human other than you approves it before work starts.",
    call: `create_plan({ repoId: "${repoId}", title: "<title>", intent: "<why>", acceptanceCriteria: ["<observable result>"] })`,
  });
}

function noSuchRepo(repoId: string) {
  return notFound(`repo ${repoId}`, {
    explanation: "No repo with that id. List the repos you can act on.",
    call: "list_repos({})",
  });
}

export async function listPlans(svc: Services, repoId: string): Promise<Plan[]> {
  if (!(await svc.store.getRepo(repoId))) throw noSuchRepo(repoId);
  return svc.store.listPlans(repoId);
}

export async function getPlanDetail(
  svc: Services,
  planId: string,
): Promise<{ plan: Plan; changes: Change[] }> {
  const plan = await svc.store.getPlan(planId);
  if (!plan) throw noSuchPlan(planId);
  return { plan, changes: await svc.store.listChangesForPlan(planId) };
}

// ---------------------------------------------------------------- writes

export async function createPlan(svc: Services, caller: Caller, input: unknown): Promise<Plan> {
  const draft = PlanDraftInput.parse(input);
  const repo = await svc.store.getRepo(draft.repoId);
  if (!repo) throw noSuchRepo(draft.repoId);
  if (draft.supersedes) {
    const prev = await svc.store.getPlan(draft.supersedes);
    if (!prev) throw noSuchPlan(draft.supersedes, draft.repoId);
    if (prev.repoId !== draft.repoId)
      throw conflict("a plan can only supersede a plan of the same repo");
    if (prev.status === "rejected" || prev.status === "superseded") {
      throw conflict(`plan ${prev.id} is ${prev.status} and cannot be superseded`, "invalid-state");
    }
  }
  const now = svc.clock.now().toISOString();
  const plan: Plan = {
    id: `plan_${crypto.randomUUID().replaceAll("-", "")}`,
    repoId: draft.repoId,
    title: draft.title,
    intent: draft.intent,
    acceptanceCriteria: draft.acceptanceCriteria,
    outOfScope: draft.outOfScope,
    riskDeclarations: draft.riskDeclarations,
    scopePaths: draft.scopePaths,
    affectedRoutes: draft.affectedRoutes,
    status: "draft",
    authorId: caller.principal.id,
    approvedBy: null,
    approvedAt: null,
    approvalSignature: null,
    supersedes: draft.supersedes ?? null,
    createdAt: now,
  };
  await svc.store.insertPlan(plan);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "plan.created",
    subject: `plan:${plan.id}`,
    payload: {
      repoId: plan.repoId,
      title: plan.title,
      contentHash: await planContentHash(plan),
      supersedes: plan.supersedes,
    },
  });
  return plan;
}

function assertHumanApprover(caller: Caller): void {
  if (caller.principal.kind !== "human") {
    throw forbidden("only a human may approve or reject a plan", undefined, {
      explanation:
        "Humans approve intent: agents can draft plans but never approve or reject them. Share the plan id with the human who owns you.",
    });
  }
  if (!caller.principal.scopes.includes("plan:approve")) {
    throw new ApiError(403, "insufficient-scope", "missing scope: plan:approve", {
      required: ["plan:approve"],
      missing: ["plan:approve"],
    });
  }
}

async function authorOf(svc: Services, plan: Plan): Promise<Principal | null> {
  return svc.store.getPrincipal(plan.authorId);
}

export async function approvePlan(
  svc: Services,
  caller: Caller,
  planId: string,
  input: { comment?: string | undefined },
): Promise<Plan> {
  assertHumanApprover(caller);
  const plan = await svc.store.getPlan(planId);
  if (!plan) throw noSuchPlan(planId);
  if (plan.authorId === caller.principal.id) {
    throw new ApiError(403, "self-approval", "a principal cannot approve its own plan", undefined, {
      explanation: `You wrote plan ${plan.id}, so someone else must approve it. Ask another human with plan:approve to review it.`,
    });
  }
  if (plan.status !== "draft") {
    throw conflict(`plan is ${plan.status}, only a draft can be approved`, "invalid-state", {
      explanation: `Plan ${plan.id} is already ${plan.status}. To change an approved plan, draft a new one that supersedes it.`,
      call: `create_plan({ repoId: "${plan.repoId}", supersedes: "${plan.id}", title: "<title>", intent: "<why>", acceptanceCriteria: ["<result>"] })`,
    });
  }

  const signer = await svc.signer();
  const approvedAt = svc.clock.now();
  const approved: Plan = {
    ...plan,
    status: "approved",
    approvedBy: caller.principal.id,
    approvedAt: approvedAt.toISOString(),
  };
  const doc = await planApprovalDocument(approved);
  const sig = await signer.signDetached(doc, Purpose.planApproval, approvedAt);
  approved.approvalSignature = sig.signature;

  const statements = [
    svc.store.updatePlanStatement(approved, {
      approvalKeyId: sig.keyId,
      decisionComment: input.comment ?? null,
      decidedBy: caller.principal.id,
    }),
  ];
  let superseded: Plan | null = null;
  if (approved.supersedes) {
    const prev = await svc.store.getPlan(approved.supersedes);
    if (prev && (prev.status === "approved" || prev.status === "draft")) {
      superseded = { ...prev, status: "superseded" };
      statements.push(
        svc.store.updatePlanStatement(superseded, {
          approvalKeyId: await svc.store.getPlanApprovalKeyId(prev.id),
        }),
      );
    }
  }
  const [first, ...rest] = statements;
  if (!first) throw new Error("unreachable");
  await svc.store.db.batch([first, ...rest]);

  const author = await authorOf(svc, plan);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "plan.approved",
    subject: `plan:${plan.id}`,
    payload: {
      ...doc,
      keyId: sig.keyId,
      signature: sig.signature,
      comment: input.comment ?? null,
      // Recorded, not blocked: owners may approve their agents' plans unless policy says otherwise.
      approverOwnsAuthor: author?.ownerId === caller.principal.id,
      supersedes: superseded?.id ?? null,
    },
  });
  if (superseded) {
    await svc.audit.append({
      principalId: caller.principal.id,
      action: "plan.superseded",
      subject: `plan:${superseded.id}`,
      payload: { by: plan.id },
    });
  }
  return approved;
}

export async function rejectPlan(
  svc: Services,
  caller: Caller,
  planId: string,
  input: { comment: string },
): Promise<Plan> {
  assertHumanApprover(caller);
  const plan = await svc.store.getPlan(planId);
  if (!plan) throw noSuchPlan(planId);
  if (plan.status !== "draft") {
    throw conflict(`plan is ${plan.status}, only a draft can be rejected`, "invalid-state", {
      explanation: `Plan ${plan.id} is already ${plan.status}; only drafts can be rejected.`,
    });
  }
  const rejected: Plan = { ...plan, status: "rejected" };
  await svc.store.updatePlanStatement(rejected, {
    decisionComment: input.comment,
    decidedBy: caller.principal.id,
  });
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "plan.rejected",
    subject: `plan:${plan.id}`,
    payload: { comment: input.comment, withdrawnByAuthor: plan.authorId === caller.principal.id },
  });
  return rejected;
}
