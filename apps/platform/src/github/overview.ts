/** GET /api/v1/github: our GitHub App (from config) and the installations this human linked. */
import { repoIdFor } from "@app/host-github";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { GITHUB_WEB } from "./api.js";
import { appUrl, githubApp, installUrl, missingConfig } from "./app-config.js";
import { prWritesSetting } from "./pr-index.js";
import { linkedInstallations, linkRepos, reposOf } from "./store.js";

export const GithubAppView = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    htmlUrl: z.string(),
    installUrl: z.string(),
  })
  .meta({ id: "GithubApp" });

export const GithubInstallationView = z
  .object({
    id: z.number().int(),
    appId: z.number().int(),
    account: z.object({ login: z.string(), type: z.string() }),
    repositorySelection: z.string(),
    suspended: z.boolean(),
    repos: z.array(
      z.object({
        id: z.number().int(),
        fullName: z.string(),
        private: z.boolean(),
        /** The platform repo once a PR was graded (null before). */
        repoId: z.string().nullable(),
        /** Tour reviews and the summary comment on its PRs (M3); "on" unless an owner turned them off. */
        prWrites: z.enum(["on", "off"]),
      }),
    ),
    linkedAs: z.string().describe("The GitHub login that proved access"),
    linkedAt: z.string(),
    manageUrl: z.string(),
  })
  .meta({ id: "GithubInstallation" });

export const GithubOverview = z
  .object({
    /** The Reader App, or null when GitHub mode isn't configured. */
    app: GithubAppView.nullable(),
    /** Config names still missing (never values); empty when configured. */
    missing: z.array(z.string()),
    installations: z.array(GithubInstallationView),
    webhookUrl: z.string(),
  })
  .meta({ id: "GithubOverview" });
export type GithubOverview = z.infer<typeof GithubOverview>;

/** The installation's repos this human's link saw on GitHub (never the whole installation). */
async function visibleRepos(svc: Services, installationId: number, principalId: string) {
  const seen = new Set(
    (await linkRepos(svc.store.db, installationId, principalId)).map((r) => r.repoId),
  );
  return (await reposOf(svc.store.db, installationId)).filter((r) => seen.has(r.repoId));
}

export async function githubOverview(svc: Services, caller: Caller): Promise<GithubOverview> {
  const env = svc.env as unknown as Record<string, unknown>;
  const app = githubApp(env);
  const rows = await linkedInstallations(svc.store.db, caller.principal.id);
  const installations = await Promise.all(
    rows.map(async ({ inst, link }) => ({
      id: inst.id,
      appId: inst.appId,
      account: { login: inst.accountLogin, type: inst.accountType },
      repositorySelection: inst.repositorySelection,
      suspended: inst.suspendedAt !== null,
      repos: await Promise.all(
        (await visibleRepos(svc, inst.id, caller.principal.id)).map(async (r) => {
          const graded = await svc.store.getRepo(repoIdFor(r.repoId));
          return {
            id: r.repoId,
            fullName: r.fullName,
            private: r.private,
            repoId: graded?.id ?? null,
            prWrites:
              graded === null ? ("on" as const) : await prWritesSetting(svc.store.db, graded.id),
          };
        }),
      ),
      linkedAs: link.githubLogin,
      linkedAt: link.linkedAt,
      manageUrl:
        inst.accountType === "Organization"
          ? `${GITHUB_WEB}/organizations/${inst.accountLogin}/settings/installations/${inst.id}`
          : `${GITHUB_WEB}/settings/installations/${inst.id}`,
    })),
  );
  return {
    app:
      app === null
        ? null
        : {
            id: app.appId,
            slug: app.slug,
            htmlUrl: appUrl(app.slug),
            installUrl: installUrl(app.slug),
          },
    missing: missingConfig(env),
    installations,
    webhookUrl: `${svc.origin}/github/webhooks`,
  };
}
