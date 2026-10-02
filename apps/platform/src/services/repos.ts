import { type ShadowSample, shadowAgreement } from "@app/classifier";
import type { Repo } from "@app/domain";
import type { z } from "zod";
import { assertRepoAccess, filterAccessible } from "../access/access.js";
import { isPlatformAuditor } from "../access/config.js";
import { auditorReadOnly } from "../access/route.js";
import type { CreateRepoBody, ShadowStatsSchema } from "../api/schemas.js";
import type { Caller, Services } from "../app-env.js";
import { badRequest } from "../errors.js";
import { assertClaimedFor } from "../limits/refusals.js";
import { EMPTY_LANE_COUNTS, type LaneCounts } from "../store/d1-store.js";

export type ShadowStats = z.infer<typeof ShadowStatsSchema>;
export type RepoSummary = Repo & { counts: LaneCounts; shadow: ShadowStats };

export function shadowStats(repo: Repo, samples: readonly ShadowSample[]): ShadowStats {
  const a = shadowAgreement(samples, repo.policy);
  return {
    samples: a.samples,
    agreed: a.agreed,
    ratio: a.samples === 0 ? null : a.ratio,
    needed: a.needed,
    threshold: repo.policy.shadow.agreementThreshold,
    eligibleToEnableLane0: a.eligibleToEnableLane0,
  };
}

/** The repos the caller can read (members; agents via their owner, within their grant). */
export async function listRepoSummaries(svc: Services, caller: Caller): Promise<RepoSummary[]> {
  const [repos, counts, drafts, samples] = await Promise.all([
    svc.store.listRepos().then((all) => filterAccessible(svc, caller.principal, all)),
    svc.store.laneCounts(),
    svc.store.countDraftPlans(),
    svc.store.listShadowSamplesByRepo(),
  ]);
  return repos.map((repo) => ({
    ...repo,
    counts: {
      ...(counts.get(repo.id) ?? EMPTY_LANE_COUNTS),
      plansAwaitingApproval: drafts.get(repo.id) ?? 0,
    },
    shadow: shadowStats(repo, samples.get(repo.id) ?? []),
  }));
}

export async function getRepoDetail(
  svc: Services,
  caller: Caller,
  repoId: string,
): Promise<{ repo: Repo; shadow: ShadowStats; counts: LaneCounts }> {
  const repo = await assertRepoAccess(svc, caller.principal, repoId, "read");
  const [counts, drafts, samples] = await Promise.all([
    svc.store.laneCounts(repoId),
    svc.store.countDraftPlans(repoId),
    svc.store.listShadowSamples(repoId),
  ]);
  return {
    repo,
    shadow: shadowStats(repo, samples),
    counts: {
      ...(counts.get(repoId) ?? EMPTY_LANE_COUNTS),
      plansAwaitingApproval: drafts.get(repoId) ?? 0,
    },
  };
}

export async function createRepo(
  svc: Services,
  caller: Caller,
  body: z.infer<typeof CreateRepoBody>,
): Promise<Repo> {
  if (isPlatformAuditor(caller.principal, svc.env)) throw auditorReadOnly();
  if (body.importFrom) {
    return svc.coordinator.importRepo(caller.principal, {
      name: body.name,
      url: body.importFrom,
      ...(body.defaultBranch ? { branch: body.defaultBranch } : {}),
    });
  }
  return svc.coordinator.createRepo(caller.principal, {
    name: body.name,
    ...(body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
    ...(body.template ? { template: body.template } : {}),
  });
}

export async function setLane0(
  svc: Services,
  caller: Caller,
  repoId: string,
  enabled: boolean,
): Promise<Repo> {
  // Owners only (Lane 0 lets the classifier merge without a human).
  await assertRepoAccess(svc, caller.principal, repoId, "admin");
  return svc.coordinator.setLane0(caller.principal, repoId, enabled);
}

/** Every Worker the platform deploys for a project is named `gf-<repoId>-<script>` (DECISIONS.md). */
export const DEPLOY_SCRIPT_PREFIX = "gf-";
const MAX_SCRIPT_NAME = 63;

/**
 * The Worker a repo deploys to. Projects deploy into the platform's own Cloudflare account, so the
 * name is namespaced by repo: no project can target the platform's Worker (`gittifacts`) or another
 * project's, and `gf-` is reserved for project Workers.
 */
export function deployScriptName(repoId: string, script: string): string {
  const slug = repoId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${DEPLOY_SCRIPT_PREFIX}${slug}-${script}`;
}

/**
 * Set (or clear, with `null`) the Worker a repo's merged Changes roll out to. Human repo admins
 * only (the route checks), claimed projects only: an unclaimed project never gets a production
 * deploy (onboarding §4).
 */
export async function setDeployTarget(
  svc: Services,
  caller: Caller,
  repoId: string,
  script: string | null,
): Promise<{ repo: Repo; script: string | null }> {
  // Owners only: where merged Changes run in production.
  const repo = await assertRepoAccess(svc, caller.principal, repoId, "admin");
  if (script !== null) assertClaimedFor(repo, "a deploy target");
  const target = script === null ? null : deployScriptName(repo.id, script);
  if (target !== null && target.length > MAX_SCRIPT_NAME) {
    throw badRequest(
      `the Worker name ${target} is longer than ${MAX_SCRIPT_NAME} characters; use a shorter script name`,
    );
  }
  if (target === repo.deployTarget) return { repo, script: target };
  const updated = await svc.store.updateRepo(repo.id, { deployTarget: target });
  await svc.audit.append({
    principalId: caller.principal.id,
    action: target === null ? "repo.deploy-target-cleared" : "repo.deploy-target-set",
    subject: `repo:${repo.id}`,
    payload: { script: target, previous: repo.deployTarget },
  });
  return { repo: updated, script: target };
}
