/** GET /api/v1/github: our Apps (public facts only) and the installations this human linked. */
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { isPlatformAdmin } from "../access/config.js";
import { GITHUB_WEB } from "./api.js";
import type { GithubFlowEnv } from "./setup.js";
import { linkedInstallations, listApps, reposOf } from "./store.js";

export const GithubAppView = z
  .object({
    id: z.number().int(),
    kind: z.enum(["reader", "actor"]),
    slug: z.string(),
    name: z.string(),
    owner: z.object({ login: z.string(), type: z.string() }),
    htmlUrl: z.string(),
    installUrl: z.string(),
    permissions: z.record(z.string(), z.string()),
    events: z.array(z.string()),
    createdAt: z.string(),
  })
  .meta({ id: "GithubApp" });

export const GithubInstallationView = z
  .object({
    id: z.number().int(),
    appId: z.number().int(),
    account: z.object({ login: z.string(), type: z.string() }),
    repositorySelection: z.string(),
    suspended: z.boolean(),
    repos: z.array(z.object({ id: z.number().int(), fullName: z.string(), private: z.boolean() })),
    linkedAs: z.string().describe("The GitHub login that proved access"),
    linkedAt: z.string(),
    manageUrl: z.string(),
  })
  .meta({ id: "GithubInstallation" });

export const GithubOverview = z
  .object({
    apps: z.array(GithubAppView),
    installations: z.array(GithubInstallationView),
    canCreateApps: z.boolean(),
    actorAppsEnabled: z.boolean(),
    webhookUrl: z.string(),
  })
  .meta({ id: "GithubOverview" });
export type GithubOverview = z.infer<typeof GithubOverview>;

export async function githubOverview(svc: Services, caller: Caller): Promise<GithubOverview> {
  const env = svc.env as GithubFlowEnv;
  const apps = await listApps(svc.store.db);
  const rows = await linkedInstallations(svc.store.db, caller.principal.id);
  const installations = await Promise.all(
    rows.map(async ({ inst, link }) => ({
      id: inst.id,
      appId: inst.appId,
      account: { login: inst.accountLogin, type: inst.accountType },
      repositorySelection: inst.repositorySelection,
      suspended: inst.suspendedAt !== null,
      repos: (await reposOf(svc.store.db, inst.id)).map((r) => ({
        id: r.repoId,
        fullName: r.fullName,
        private: r.private,
      })),
      linkedAs: link.githubLogin,
      linkedAt: link.linkedAt,
      manageUrl:
        inst.accountType === "Organization"
          ? `${GITHUB_WEB}/organizations/${inst.accountLogin}/settings/installations/${inst.id}`
          : `${GITHUB_WEB}/settings/installations/${inst.id}`,
    })),
  );
  return {
    apps: apps.map((a) => ({
      id: a.id,
      kind: a.kind,
      slug: a.slug,
      name: a.name,
      owner: { login: a.ownerLogin, type: a.ownerType },
      htmlUrl: a.htmlUrl,
      installUrl: `${GITHUB_WEB}/apps/${a.slug}/installations/new`,
      permissions: a.permissions,
      events: a.events,
      createdAt: a.createdAt,
    })),
    installations,
    canCreateApps: isPlatformAdmin(caller.principal, env),
    actorAppsEnabled: env.GITHUB_ACTOR_APPS === "on",
    webhookUrl: `${svc.origin}/github/webhooks`,
  };
}
