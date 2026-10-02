/**
 * Installations: integration × account × repos, each with its own `integration` principal.
 *
 * - Installing (or re-installing) is idempotent per (integration, account): a second approval
 *   updates the repos and scopes of the active installation instead of creating another one.
 * - Uninstalling revokes every access and refresh token at once, disables the principal (so the
 *   next request fails), cancels pending webhook deliveries and sends `installation.deleted` last.
 * Every install, update and uninstall is audit-logged under `installation:<id>`.
 */
import type { IntegrationScope, Principal } from "@app/domain";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Caller, Services } from "../app-env.js";
import { revokeAgentTokens } from "../auth/agent-tokens.js";
import { disablePrincipal } from "../auth/principals.js";
import {
  agentSessions,
  installationRepos,
  installations,
  integrations,
  principals,
  webhookDeliveries,
} from "../db/schema.js";
import { installableRepos } from "./access.js";
import type { IntegrationRow } from "./registry.js";

export type InstallationRow = typeof installations.$inferSelect;

/** Installations don't expire on their own; their session row needs an end, so: far away. */
const INSTALLATION_SESSION_YEARS = 20;

/** The active installation of `integrationId` on `accountId`, if any. */
export async function activeInstallation(
  svc: Services,
  integrationId: string,
  accountId: string,
): Promise<InstallationRow | null> {
  return (
    (await svc.store.db
      .select()
      .from(installations)
      .where(
        and(
          eq(installations.integrationId, integrationId),
          eq(installations.accountId, accountId),
          eq(installations.status, "active"),
        ),
      )
      .get()) ?? null
  );
}

export async function getInstallation(svc: Services, id: string): Promise<InstallationRow | null> {
  return (await svc.store.db.select().from(installations).where(eq(installations.id, id)).get()) ?? null;
}

async function setRepos(svc: Services, installationId: string, repoIds: readonly string[]): Promise<void> {
  await svc.store.db.delete(installationRepos).where(eq(installationRepos.installationId, installationId));
  for (const repoId of new Set(repoIds)) {
    await svc.store.db.insert(installationRepos).values({ installationId, repoId });
  }
}

/** Snapshot of the grant on the principal (display/audit); access is re-resolved per request. */
async function snapshotGrant(
  svc: Services,
  principalId: string,
  scopes: readonly IntegrationScope[],
  repoIds: readonly string[],
): Promise<void> {
  await svc.store.db
    .update(principals)
    .set({ scopes: [...scopes], repoIds: [...repoIds] })
    .where(eq(principals.id, principalId));
}

export interface UpsertedInstallation {
  installation: InstallationRow;
  created: boolean;
}

/**
 * Create the installation (principal + session + repos), or update the active one. The caller has
 * already checked that `human` may install on every repo in `repoIds`.
 */
export async function upsertInstallation(
  svc: Services,
  human: Principal,
  integration: IntegrationRow,
  scopes: readonly IntegrationScope[],
  repoSelection: "all" | "selected",
  repoIds: readonly string[],
): Promise<UpsertedInstallation> {
  const now = svc.clock.now();
  const nowIso = now.toISOString();
  const grantRepos =
    repoSelection === "all" ? (await installableRepos(svc, human)).map((r) => r.id) : [...repoIds];
  const existing = await activeInstallation(svc, integration.id, human.id);
  if (existing) {
    await svc.store.db
      .update(installations)
      .set({ repoSelection, scopes: [...scopes], updatedAt: nowIso })
      .where(eq(installations.id, existing.id));
    await setRepos(svc, existing.id, repoSelection === "selected" ? repoIds : []);
    await snapshotGrant(svc, existing.principalId, scopes, grantRepos);
    await svc.audit.append({
      principalId: human.id,
      action: "integration.installation-updated",
      subject: `installation:${existing.id}`,
      payload: {
        summary: `Updated ${integration.name}: ${repoSelection === "all" ? "all repositories" : `${repoIds.length} repositories`}`,
        integrationId: integration.id,
        scopes,
        repoSelection,
        repoIds: grantRepos,
      },
    });
    const after = await getInstallation(svc, existing.id);
    if (!after) throw new Error(`installation ${existing.id} vanished`);
    return { installation: after, created: false };
  }

  const principalId = `in_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  await svc.store.db.insert(principals).values({
    id: principalId,
    kind: "integration",
    name: integration.name.slice(0, 120),
    ownerId: human.id,
    userId: null,
    scopes: [...scopes],
    repoIds: [...grantRepos],
    createdAt: nowIso,
  });
  const sessionId = `ses_${crypto.randomUUID().replaceAll("-", "")}`;
  await svc.store.db.insert(agentSessions).values({
    id: sessionId,
    principalId,
    ownerId: human.id,
    flow: "authorization_code",
    clientId: integration.clientId,
    clientName: integration.name,
    clientUri: integration.homepageUrl,
    audience: [`${svc.origin}/api`],
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + INSTALLATION_SESSION_YEARS * 365 * 86_400_000).toISOString(),
    revokedAt: null,
    revokedBy: null,
  });
  const row: InstallationRow = {
    id: `ins_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    integrationId: integration.id,
    accountId: human.id,
    accountKind: "human",
    principalId,
    sessionId,
    installedBy: human.id,
    repoSelection,
    scopes: [...scopes],
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
    deletedAt: null,
    deletedBy: null,
  };
  await svc.store.db.insert(installations).values(row);
  if (repoSelection === "selected") await setRepos(svc, row.id, repoIds);
  await svc.audit.append({
    principalId: human.id,
    action: "integration.installed",
    subject: `installation:${row.id}`,
    payload: {
      summary: `Installed ${integration.name} on ${repoSelection === "all" ? "all repositories" : `${repoIds.length} repositories`}`,
      integrationId: integration.id,
      clientId: integration.clientId,
      principalId,
      scopes,
      repoSelection,
      repoIds: grantRepos,
    },
  });
  return { installation: row, created: true };
}

/**
 * Uninstall: tokens and refresh tokens revoked, principal disabled, pending deliveries cancelled.
 * Idempotent. Returns false when it was not active.
 */
export async function uninstall(
  svc: Services,
  inst: InstallationRow,
  by: string,
  reason: string,
): Promise<boolean> {
  const now = svc.clock.now();
  const flipped = await svc.store.db
    .update(installations)
    .set({ status: "deleted", deletedAt: now.toISOString(), deletedBy: by, updatedAt: now.toISOString() })
    .where(and(eq(installations.id, inst.id), eq(installations.status, "active")))
    .returning({ id: installations.id });
  if (flipped.length === 0) return false;
  const revoked = await revokeAgentTokens(svc.store, inst.principalId, now);
  await disablePrincipal(svc.store, inst.principalId, now);
  await svc.store.db
    .update(agentSessions)
    .set({ revokedAt: now.toISOString(), revokedBy: by })
    .where(eq(agentSessions.id, inst.sessionId));
  await svc.store.db
    .update(webhookDeliveries)
    .set({ status: "cancelled", nextAttemptAt: null, error: "installation deleted" })
    .where(
      and(
        eq(webhookDeliveries.installationId, inst.id),
        eq(webhookDeliveries.status, "pending"),
        ne(webhookDeliveries.event, "installation.deleted"),
      ),
    );
  const integration = await svc.store.db
    .select({ name: integrations.name })
    .from(integrations)
    .where(eq(integrations.id, inst.integrationId))
    .get();
  await svc.audit.append({
    principalId: by,
    action: "integration.uninstalled",
    subject: `installation:${inst.id}`,
    payload: {
      summary: `Uninstalled ${integration?.name ?? inst.integrationId}`,
      integrationId: inst.integrationId,
      principalId: inst.principalId,
      revokedTokens: revoked,
      reason,
    },
  });
  return true;
}

export async function activeInstallationsOf(
  svc: Services,
  where: { integrationIds?: string[]; accountId?: string },
): Promise<InstallationRow[]> {
  const conds = [eq(installations.status, "active")];
  if (where.integrationIds) conds.push(inArray(installations.integrationId, where.integrationIds));
  if (where.accountId) conds.push(eq(installations.accountId, where.accountId));
  return svc.store.db.select().from(installations).where(and(...conds)).all();
}

export function callerIsAccount(caller: Caller, inst: InstallationRow): boolean {
  return caller.principal.kind === "human" && caller.principal.id === inst.accountId;
}
