/**
 * Installed integrations, from both sides:
 * - the human (Settings → Integrations): list, change repos, one-click uninstall;
 * - the developer: deleting an integration uninstalls it everywhere;
 * - the integration itself: `GET /api/v1/installation` (who installed it, on which repos, with
 *   their clone URLs).
 */
import { IntegrationScope } from "@app/domain";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import {
  agentTokens,
  installations,
  integrations,
  principals,
  webhookDeliveries,
} from "../db/schema.js";
import { ApiError, forbidden, notFound } from "../errors.js";
import { canInstallOn, installableRepos, installationRepoIds } from "./access.js";
import { emitInstallationEvent } from "./events.js";
import { handleFor, repoNames } from "./handles.js";
import type { InstallDecisionBody } from "./install.js";
import {
  activeInstallationsOf,
  getInstallation,
  type InstallationRow,
  uninstall,
  upsertInstallation,
} from "./installations.js";
import { getIntegration, ownIntegration } from "./registry.js";
import { eventDepsFor } from "./runtime.js";
import { explainScopes, integrationScopesOf, ScopeExplainedSchema } from "./scopes.js";

const RepoRef = z.object({ id: z.string(), name: z.string(), fullName: z.string() });

export const InstallationViewSchema = z
  .object({
    id: z.string(),
    integration: z.object({
      id: z.string(),
      name: z.string(),
      logoUrl: z.string().nullable(),
      homepageUrl: z.string(),
      developer: z.object({ name: z.string() }),
    }),
    account: z.object({ id: z.string(), kind: z.enum(["human", "org"]), handle: z.string() }),
    scopes: z.array(ScopeExplainedSchema),
    repoSelection: z.enum(["all", "selected"]),
    repos: z.array(RepoRef),
    /** Repos you may put this installation on (claimed, you own or maintain): for "Change repositories". */
    eligibleRepos: z.array(RepoRef),
    status: z.enum(["active", "deleted"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastUsedAt: z.string().nullable(),
    installedBy: z.object({ id: z.string(), name: z.string() }),
  })
  .meta({ id: "Installation" });
export type InstallationView = z.infer<typeof InstallationViewSchema>;

export const RepositoryRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    fullName: z.string(),
    defaultBranch: z.string(),
    cloneUrl: z.string(),
  })
  .meta({ id: "InstallationRepository" });

async function nameOf(svc: Services, principalId: string): Promise<string> {
  const p = await svc.store.db
    .select({ name: principals.name })
    .from(principals)
    .where(eq(principals.id, principalId))
    .get();
  return p?.name ?? principalId;
}

async function repoRefs(svc: Services, ids: readonly string[]) {
  const out: z.infer<typeof RepositoryRefSchema>[] = [];
  for (const id of ids) {
    const repo = await svc.store.getRepo(id);
    const names = repo ? await repoNames(svc, repo) : null;
    if (repo && names) {
      out.push({
        id: repo.id,
        name: repo.name,
        fullName: names.fullName,
        defaultBranch: repo.defaultBranch,
        cloneUrl: names.cloneUrl,
      });
    }
  }
  return out;
}

export async function installationView(
  svc: Services,
  inst: InstallationRow,
): Promise<InstallationView> {
  const integration = await svc.store.db
    .select()
    .from(integrations)
    .where(eq(integrations.id, inst.integrationId))
    .get();
  const repos = await repoRefs(svc, await installationRepoIds(svc, inst));
  return {
    id: inst.id,
    integration: {
      id: inst.integrationId,
      name: integration?.name ?? inst.integrationId,
      logoUrl: integration?.logoUrl ?? null,
      homepageUrl: integration?.homepageUrl ?? "",
      developer: { name: integration ? await nameOf(svc, integration.ownerId) : "unknown" },
    },
    account: {
      id: inst.accountId,
      kind: inst.accountKind,
      handle: await handleFor(svc, inst.accountId),
    },
    scopes: explainScopes(integrationScopesOf(inst.scopes)),
    repoSelection: inst.repoSelection,
    repos: repos.map(({ id, name, fullName }) => ({ id, name, fullName })),
    eligibleRepos: (
      await repoRefs(
        svc,
        (await installableRepos(svc, { id: inst.accountId, kind: "human" })).map((r) => r.id),
      )
    ).map(({ id, name, fullName }) => ({ id, name, fullName })),
    status: inst.status,
    createdAt: inst.createdAt,
    updatedAt: inst.updatedAt,
    lastUsedAt: await lastUsedAt(svc, inst.principalId),
    installedBy: { id: inst.installedBy, name: await nameOf(svc, inst.installedBy) },
  };
}

async function lastUsedAt(svc: Services, principalId: string): Promise<string | null> {
  const row = await svc.store.db
    .select({ at: sql<string | null>`max(${agentTokens.lastUsedAt})` })
    .from(agentTokens)
    .where(eq(agentTokens.principalId, principalId))
    .get();
  return row?.at ?? null;
}

export async function listInstallations(
  svc: Services,
  caller: Caller,
): Promise<InstallationView[]> {
  if (caller.principal.kind !== "human")
    throw forbidden("only a signed-in human has installed integrations");
  const rows = await activeInstallationsOf(svc, { accountId: caller.principal.id });
  return Promise.all(rows.map((r) => installationView(svc, r)));
}

async function ownInstallation(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<InstallationRow> {
  const inst = await getInstallation(svc, id);
  if (!inst || caller.principal.kind !== "human" || inst.accountId !== caller.principal.id) {
    throw notFound(`installation ${id}`, {
      explanation: "List your installed integrations with GET /api/v1/installations.",
    });
  }
  return inst;
}

export async function updateInstallationRepos(
  svc: Services,
  caller: Caller,
  id: string,
  body: InstallDecisionBody,
): Promise<InstallationView> {
  const inst = await ownInstallation(svc, caller, id);
  if (inst.status !== "active")
    throw new ApiError(409, "invalid-state", "this installation was removed");
  const integration = await getIntegration(svc, inst.integrationId);
  if (!integration) throw notFound("integration", { explanation: "Its developer deleted it." });
  const repoIds = [...new Set(body.repoIds)];
  if (body.repoSelection === "selected") {
    if (repoIds.length === 0)
      throw new ApiError(400, "invalid-request", "pick at least one repository");
    for (const repoId of repoIds) {
      const repo = await svc.store.getRepo(repoId);
      if (!repo || !(await canInstallOn(svc.store, caller.principal, repo))) {
        throw new ApiError(
          403,
          "repo-not-installable",
          `you cannot connect integrations to repo ${repoId}`,
          { repoId },
          {
            explanation:
              "Only claimed repositories you own or maintain can be connected to integrations.",
          },
        );
      }
    }
  }
  const { installation } = await upsertInstallation(
    svc,
    caller.principal,
    integration,
    IntegrationScope.array().catch([]).parse(inst.scopes),
    body.repoSelection,
    body.repoSelection === "selected" ? repoIds : [],
  );
  return installationView(svc, installation);
}

async function uninstallAndNotify(
  svc: Services,
  inst: InstallationRow,
  by: string,
  reason: string,
): Promise<void> {
  const repos = await repoRefs(svc, await installationRepoIds(svc, inst));
  if (!(await uninstall(svc, inst, by, reason))) return;
  await emitInstallationEvent(eventDepsFor(svc), "deleted", inst.id, {
    account: { id: inst.accountId, handle: await handleFor(svc, inst.accountId) },
    repoSelection: inst.repoSelection,
    repositories: repos,
    scopes: integrationScopesOf(inst.scopes),
  });
}

/** One click: tokens stop working now, no more events (except the final installation.deleted). */
export async function uninstallInstallation(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<InstallationView> {
  const inst = await ownInstallation(svc, caller, id);
  await uninstallAndNotify(svc, inst, caller.principal.id, "uninstalled by the account");
  const after = await getInstallation(svc, id);
  if (!after) throw new Error(`installation ${id} vanished`);
  return installationView(svc, after);
}

/** The developer deletes an integration: uninstalled everywhere, pending deliveries cancelled. */
export async function deleteIntegration(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<{ deleted: true; uninstalled: number }> {
  const row = await ownIntegration(svc, caller, id);
  const active = await activeInstallationsOf(svc, { integrationIds: [id] });
  let n = 0;
  for (const inst of active) {
    if (await uninstall(svc, inst, caller.principal.id, "integration deleted by its developer"))
      n++;
  }
  const now = svc.clock.now().toISOString();
  await svc.store.db
    .update(integrations)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(integrations.id, id));
  await svc.store.db
    .update(webhookDeliveries)
    .set({ status: "cancelled", nextAttemptAt: null, error: "integration deleted" })
    .where(and(eq(webhookDeliveries.integrationId, id), eq(webhookDeliveries.status, "pending")));
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.deleted",
    subject: `integration:${id}`,
    payload: { summary: `Deleted integration ${row.name}`, uninstalled: n },
  });
  return { deleted: true, uninstalled: n };
}

export const CurrentInstallationSchema = z
  .object({
    installation: z.object({
      id: z.string(),
      integration: z.object({ id: z.string(), clientId: z.string(), name: z.string() }),
      account: z.object({ id: z.string(), kind: z.enum(["human", "org"]), handle: z.string() }),
      repoSelection: z.enum(["all", "selected"]),
      scopes: z.array(IntegrationScope),
      createdAt: z.string(),
    }),
    repositories: z.array(RepositoryRefSchema),
  })
  .meta({ id: "CurrentInstallation" });

/** What an integration token sees about itself. */
export async function currentInstallation(
  svc: Services,
  caller: Caller,
): Promise<z.infer<typeof CurrentInstallationSchema>> {
  if (caller.principal.kind !== "integration") {
    throw forbidden(
      "only an integration token has an installation",
      { kind: caller.principal.kind },
      {
        explanation: "Call this with the access token from the integration install flow.",
      },
    );
  }
  const inst = await svc.store.db
    .select()
    .from(installations)
    .where(eq(installations.principalId, caller.principal.id))
    .get();
  if (!inst) throw notFound("installation");
  const integration = await getIntegration(svc, inst.integrationId);
  return {
    installation: {
      id: inst.id,
      integration: {
        id: inst.integrationId,
        clientId: integration?.clientId ?? "",
        name: integration?.name ?? "",
      },
      account: {
        id: inst.accountId,
        kind: inst.accountKind,
        handle: await handleFor(svc, inst.accountId),
      },
      repoSelection: inst.repoSelection,
      scopes: integrationScopesOf(inst.scopes),
      createdAt: inst.createdAt,
    },
    repositories: await repoRefs(svc, caller.principal.repoIds ?? []),
  };
}
