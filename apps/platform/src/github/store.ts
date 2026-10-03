/** D1 rows for GitHub mode (src/db/github-schema.ts). */
import { and, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  githubApps,
  githubDeliveries,
  githubInstallationLinks,
  githubInstallationRepos,
  githubInstallations,
  githubStates,
} from "../db/github-schema.js";
import type { Db } from "../store/d1-store.js";

export type GithubAppRow = typeof githubApps.$inferSelect;
export type GithubStateRow = typeof githubStates.$inferSelect;
export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type GithubRepoRow = typeof githubInstallationRepos.$inferSelect;

/** States are valid for one hour (the manifest flow must finish within an hour anyway). */
export const STATE_TTL_MS = 60 * 60 * 1000;
/** Delivery GUIDs are kept 8 days (≥ 7 days, research decision 7). */
export const DELIVERY_TTL_MS = 8 * 24 * 60 * 60 * 1000;

/** Insert, or refresh the credentials of an App we already know (same GitHub App id). */
export async function insertApp(db: Db, row: GithubAppRow): Promise<void> {
  const { id: _id, createdAt: _at, createdBy: _by, ...set } = row;
  await db.insert(githubApps).values(row).onConflictDoUpdate({ target: githubApps.id, set });
}

export async function getApp(db: Db, id: number): Promise<GithubAppRow | null> {
  return (await db.select().from(githubApps).where(eq(githubApps.id, id)).get()) ?? null;
}

export async function listApps(db: Db): Promise<GithubAppRow[]> {
  return db.select().from(githubApps).orderBy(desc(githubApps.createdAt)).all();
}

export async function createState(db: Db, row: Omit<GithubStateRow, "consumedAt">) {
  await db.insert(githubStates).values({ ...row, consumedAt: null });
}

/**
 * Consume a state exactly once: unexpired, unconsumed, the right purpose. Null otherwise
 * (replayed, expired, unknown). One UPDATE, so two concurrent callbacks can't both win.
 */
export async function consumeState(
  db: Db,
  id: string,
  purpose: GithubStateRow["purpose"],
  now: Date,
): Promise<GithubStateRow | null> {
  const iso = now.toISOString();
  const out = await db
    .update(githubStates)
    .set({ consumedAt: iso })
    .where(
      and(
        eq(githubStates.id, id),
        eq(githubStates.purpose, purpose),
        isNull(githubStates.consumedAt),
        gt(githubStates.expiresAt, iso),
      ),
    )
    .returning();
  return out[0] ?? null;
}

/** True when this delivery GUID is new (and is now recorded). */
export async function recordDelivery(
  db: Db,
  row: typeof githubDeliveries.$inferInsert,
): Promise<boolean> {
  const out = await db
    .insert(githubDeliveries)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: githubDeliveries.id });
  return out.length > 0;
}

export async function forgetDelivery(db: Db, id: string): Promise<void> {
  await db.delete(githubDeliveries).where(eq(githubDeliveries.id, id));
}

/** Cron: drop delivery GUIDs past their TTL and states that expired a day ago. */
export async function sweepGithub(db: Db, now: Date): Promise<void> {
  await db
    .delete(githubDeliveries)
    .where(lt(githubDeliveries.receivedAt, new Date(now.getTime() - DELIVERY_TTL_MS).toISOString()));
  await db
    .delete(githubStates)
    .where(lt(githubStates.expiresAt, new Date(now.getTime() - 86_400_000).toISOString()));
}

export interface InstallationInput {
  id: number;
  appId: number;
  account: { login: string; id: number; type: string };
  repositorySelection: string;
  permissions: Record<string, string>;
  events: string[];
  suspendedAt: string | null;
}

export async function upsertInstallation(db: Db, i: InstallationInput, now: Date): Promise<void> {
  const iso = now.toISOString();
  const fields = {
    appId: i.appId,
    accountLogin: i.account.login,
    accountId: i.account.id,
    accountType: i.account.type,
    repositorySelection: i.repositorySelection,
    permissions: i.permissions,
    events: i.events,
    suspendedAt: i.suspendedAt,
    deletedAt: null,
    updatedAt: iso,
  };
  await db
    .insert(githubInstallations)
    .values({ id: i.id, ...fields, createdAt: iso })
    .onConflictDoUpdate({ target: githubInstallations.id, set: fields });
}

export async function getInstallation(db: Db, id: number) {
  return (
    (await db.select().from(githubInstallations).where(eq(githubInstallations.id, id)).get()) ??
    null
  );
}

export async function patchInstallation(
  db: Db,
  id: number,
  set: Partial<Pick<GithubInstallationRow, "suspendedAt" | "deletedAt" | "repositorySelection" | "permissions" | "events">>,
  now: Date,
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ ...set, updatedAt: now.toISOString() })
    .where(eq(githubInstallations.id, id));
}

export interface RepoInput {
  id: number;
  fullName: string;
  private: boolean;
}

export async function addRepos(db: Db, installationId: number, repos: RepoInput[], now: Date) {
  if (repos.length === 0) return;
  const iso = now.toISOString();
  for (let i = 0; i < repos.length; i += 20) {
    const rows = repos.slice(i, i + 20).map((r) => ({
      installationId,
      repoId: r.id,
      fullName: r.fullName,
      private: r.private,
      addedAt: iso,
    }));
    await db
      .insert(githubInstallationRepos)
      .values(rows)
      .onConflictDoNothing();
  }
}

export async function removeRepos(db: Db, installationId: number, repoIds: number[]) {
  for (let i = 0; i < repoIds.length; i += 50) {
    await db
      .delete(githubInstallationRepos)
      .where(
        and(
          eq(githubInstallationRepos.installationId, installationId),
          inArray(githubInstallationRepos.repoId, repoIds.slice(i, i + 50)),
        ),
      );
  }
}

/** Make the stored repo list exactly `repos`. */
export async function replaceRepos(db: Db, installationId: number, repos: RepoInput[], now: Date) {
  const have = await reposOf(db, installationId);
  const want = new Set(repos.map((r) => r.id));
  await removeRepos(
    db,
    installationId,
    have.filter((r) => !want.has(r.repoId)).map((r) => r.repoId),
  );
  const known = new Set(have.map((r) => r.repoId));
  await addRepos(db, installationId, repos.filter((r) => !known.has(r.id)), now);
}

export async function reposOf(db: Db, installationId: number): Promise<GithubRepoRow[]> {
  return db
    .select()
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.installationId, installationId))
    .orderBy(githubInstallationRepos.fullName)
    .all();
}

export async function linkInstallation(
  db: Db,
  row: typeof githubInstallationLinks.$inferInsert,
): Promise<void> {
  await db
    .insert(githubInstallationLinks)
    .values(row)
    .onConflictDoUpdate({
      target: [githubInstallationLinks.installationId, githubInstallationLinks.principalId],
      set: { githubLogin: row.githubLogin, linkedAt: row.linkedAt },
    });
}

/** Installations this human linked (not deleted), newest link first. */
export async function linkedInstallations(db: Db, principalId: string) {
  return db
    .select({ inst: githubInstallations, link: githubInstallationLinks })
    .from(githubInstallationLinks)
    .innerJoin(githubInstallations, eq(githubInstallations.id, githubInstallationLinks.installationId))
    .where(and(eq(githubInstallationLinks.principalId, principalId), isNull(githubInstallations.deletedAt)))
    .orderBy(desc(githubInstallationLinks.linkedAt))
    .all();
}
