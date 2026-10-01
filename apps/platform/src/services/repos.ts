import { type ShadowSample, shadowAgreement } from "@app/classifier";
import type { Repo } from "@app/domain";
import type { z } from "zod";
import type { CreateRepoBody, ShadowStatsSchema } from "../api/schemas.js";
import type { Caller, Services } from "../app-env.js";
import { notFound } from "../errors.js";
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

export async function listRepoSummaries(svc: Services): Promise<RepoSummary[]> {
  const [repos, counts, drafts, samples] = await Promise.all([
    svc.store.listRepos(),
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
  repoId: string,
): Promise<{ repo: Repo; shadow: ShadowStats; counts: LaneCounts }> {
  const repo = await svc.store.getRepo(repoId);
  if (!repo)
    throw notFound(`repo ${repoId}`, {
      explanation: "No repo with that id.",
      call: "list_repos({})",
    });
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
  if (!(await svc.store.getRepo(repoId))) throw notFound(`repo ${repoId}`);
  return svc.coordinator.setLane0(caller.principal, repoId, enabled);
}
