/**
 * Plans GitHub mode imports (packages/host-github/src/plans.ts): drafts from plan files, and
 * issue plans whose `gittifacts:plan` label was applied by a writer who is neither author. An
 * approved import is signed with the platform key exactly like an approval on gittifacts (the
 * signature attests that the platform saw that approval), so it verifies the same way.
 */
import type { Plan } from "@app/domain";
import type { Identity } from "@app/host";
import { principalIdFor } from "@app/host-github";
import { eq } from "drizzle-orm";
import type { Bindings } from "../app-env.js";
import { githubInstallationLinks } from "../db/github-schema.js";
import { planApprovalDocument } from "../services/plans.js";
import { Purpose, platformSigner } from "../signing.js";
import type { D1Store } from "../store/d1-store.js";
import { ensureGithubPrincipal } from "./grading.js";

export async function upsertGithubPlan(env: Bindings, store: D1Store, plan: Plan): Promise<Plan> {
  let out = plan;
  let keyId: string | null = null;
  if (plan.status === "approved" && plan.approvedAt !== null) {
    const signer = await platformSigner(env);
    const at = new Date(plan.approvedAt);
    const sig = await signer.signDetached(
      await planApprovalDocument(plan),
      Purpose.planApproval,
      Number.isNaN(at.getTime()) ? new Date() : at,
    );
    out = { ...plan, approvalSignature: sig.signature };
    keyId = sig.keyId;
  }
  const existing = await store.getPlan(plan.id);
  if (existing === null) {
    await store.insertPlan(out);
    if (keyId !== null)
      await store.db.batch([store.updatePlanStatement(out, { approvalKeyId: keyId })]);
  } else {
    await store.db.batch([
      store.updatePlanStatement(
        { ...out, createdAt: existing.createdAt },
        { approvalKeyId: keyId },
      ),
    ]);
  }
  return out;
}

/**
 * Who a GitHub reviewer or labeller acts as on the platform: the human who linked an installation
 * as that GitHub account (proved with a GitHub user token), else the account's own principal.
 * Matched by GitHub's numeric user id, never the login (renamable, re-registrable): a link from
 * before the id was recorded attributes nobody to its human until it is linked again.
 */
export async function githubActorPrincipal(
  store: D1Store,
  who: Identity & { login: string },
): Promise<string> {
  const userId = Number(who.id);
  if (who.kind === "human" && Number.isSafeInteger(userId)) {
    const link = await store.db
      .select({ principalId: githubInstallationLinks.principalId })
      .from(githubInstallationLinks)
      .where(eq(githubInstallationLinks.githubUserId, userId))
      .orderBy(githubInstallationLinks.linkedAt)
      .get();
    if (link !== undefined) return link.principalId;
  }
  return (await ensureGithubPrincipal(store, who)) ?? principalIdFor(Number(who.id));
}
