/**
 * The one call service functions make before granting an unclaimed project more work (a new
 * Change and its fork, a push token, a workspace, a workspace push): the project must not have
 * expired, must have CI minutes left today and be under its storage quota, and the Artifacts
 * operations the call performs are charged. Claimed projects pass straight through.
 * Refusals carry the project's claim link in their fix.
 */
import type { Repo } from "@app/domain";
import type { Services } from "../app-env.js";
import { claimUrlForRepo } from "../claim/store.js";
import { ApiError } from "../errors.js";
import { unclaimedLimits } from "./config.js";
import { assertCanStartWork, assertOpenChangesBelow, chargeArtifactsOps } from "./quotas.js";

export async function admitUnclaimedWork(
  svc: Services,
  repo: Repo,
  input: { ops: number; what: string },
): Promise<void> {
  if (repo.claim.status === "claimed") return;
  const now = svc.clock.now().getTime();
  if (repo.claim.expiresAt !== null && Date.parse(repo.claim.expiresAt) <= now) {
    throw new ApiError(
      410,
      "invalid-state",
      `project ${repo.id} expired unclaimed`,
      { expiresAt: repo.claim.expiresAt },
      {
        explanation:
          "Unclaimed projects are deleted when their TTL runs out. Create a new project (and give its claimUrl to a human to keep it).",
        call: "create_project({})",
      },
    );
  }
  const limits = unclaimedLimits(svc.env);
  const claimUrl = await claimUrlForRepo(svc.env, svc.store, svc.origin, repo.id);
  try {
    await assertCanStartWork(svc.env, svc.store, repo, limits, now, claimUrl);
    if (input.what === "start_change") {
      await assertOpenChangesBelow(svc.store, repo, limits, claimUrl);
    }
    await chargeArtifactsOps(svc.env, svc.store, repo, input.ops, limits, now, claimUrl);
  } catch (e) {
    if (e instanceof ApiError && e.code === "quota-exceeded") {
      await svc.audit
        .append({
          principalId: "system",
          action: "limit.hit",
          subject: `repo:${repo.id}`,
          payload: {
            limit: (e.details as { quota?: string } | undefined)?.quota,
            what: input.what,
          },
        })
        .catch(() => undefined);
    }
    throw e;
  }
}
