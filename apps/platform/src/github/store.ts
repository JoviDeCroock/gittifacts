/** D1 rows for GitHub mode (src/db/github-schema.ts). */
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  githubDeliveries,
  githubInstallationLinks,
  githubInstallationRepos,
  githubInstallations,
  githubLinkRepos,
} from "../db/github-schema.js";
import type { Db } from "../store/d1-store.js";

export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type GithubRepoRow = typeof githubInstallationRepos.$inferSelect;

/** Delivery GUIDs are kept 8 days (≥ 7 days, research decision 7). */
export const DELIVERY_TTL_MS = 8 * 24 * 60 * 60 * 1000;

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

/** Cron: drop delivery GUIDs past their TTL. */
export async function sweepGithub(db: Db, now: Date): Promise<void> {
  await db
    .delete(githubDeliveries)
    .where(
      lt(githubDeliveries.receivedAt, new Date(now.getTime() - DELIVERY_TTL_MS).toISOString()),
    );
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
  set: Partial<
    Pick<
      GithubInstallationRow,
      "suspendedAt" | "deletedAt" | "repositorySelection" | "permissions" | "events"
    >
  >,
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
    await db.insert(githubInstallationRepos).values(rows).onConflictDoNothing();
  }
}

/** Repos left the installation: their rows go, and so does every link's access to them. */
export async function removeRepos(db: Db, installationId: number, repoIds: number[]) {
  for (let i = 0; i < repoIds.length; i += 50) {
    const ids = repoIds.slice(i, i + 50);
    await db.batch([
      db
        .delete(githubInstallationRepos)
        .where(
          and(
            eq(githubInstallationRepos.installationId, installationId),
            inArray(githubInstallationRepos.repoId, ids),
          ),
        ),
      db
        .delete(githubLinkRepos)
        .where(
          and(
            eq(githubLinkRepos.installationId, installationId),
            inArray(githubLinkRepos.repoId, ids),
          ),
        ),
    ]);
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
  await addRepos(
    db,
    installationId,
    repos.filter((r) => !known.has(r.id)),
    now,
  );
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
      set: { githubLogin: row.githubLogin, githubUserId: row.githubUserId, linkedAt: row.linkedAt },
    });
}

export type GithubAccess = (typeof githubLinkRepos.$inferSelect)["access"];

/** Make a link's visible repos exactly `repos` (what its user token listed just now). */
export async function setLinkRepos(
  db: Db,
  installationId: number,
  principalId: string,
  repos: { repoId: number; access: GithubAccess }[],
  now: Date,
): Promise<void> {
  const mine = and(
    eq(githubLinkRepos.installationId, installationId),
    eq(githubLinkRepos.principalId, principalId),
  );
  const at = now.toISOString();
  const inserts = [];
  for (let i = 0; i < repos.length; i += 20) {
    const rows = repos
      .slice(i, i + 20)
      .map((r) => ({
        installationId,
        principalId,
        repoId: r.repoId,
        access: r.access,
        recordedAt: at,
      }));
    inserts.push(db.insert(githubLinkRepos).values(rows));
  }
  await db.batch([db.delete(githubLinkRepos).where(mine), ...inserts]);
}

/** The links that saw one repo of an installation, oldest link first. */
export async function linksSeeingRepo(db: Db, installationId: number, repoId: number) {
  return db
    .select({
      principalId: githubLinkRepos.principalId,
      access: githubLinkRepos.access,
      linkedAt: githubInstallationLinks.linkedAt,
    })
    .from(githubLinkRepos)
    .innerJoin(
      githubInstallationLinks,
      and(
        eq(githubInstallationLinks.installationId, githubLinkRepos.installationId),
        eq(githubInstallationLinks.principalId, githubLinkRepos.principalId),
      ),
    )
    .where(
      and(eq(githubLinkRepos.installationId, installationId), eq(githubLinkRepos.repoId, repoId)),
    )
    .orderBy(githubInstallationLinks.linkedAt)
    .all();
}

/** The repos one link saw, with its access to each. */
export async function linkRepos(db: Db, installationId: number, principalId: string) {
  return db
    .select({ repoId: githubLinkRepos.repoId, access: githubLinkRepos.access })
    .from(githubLinkRepos)
    .where(
      and(
        eq(githubLinkRepos.installationId, installationId),
        eq(githubLinkRepos.principalId, principalId),
      ),
    )
    .all();
}

/** Installations this human linked (not deleted), newest link first. */
export async function linkedInstallations(db: Db, principalId: string) {
  return db
    .select({ inst: githubInstallations, link: githubInstallationLinks })
    .from(githubInstallationLinks)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubInstallationLinks.installationId),
    )
    .where(
      and(
        eq(githubInstallationLinks.principalId, principalId),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .orderBy(desc(githubInstallationLinks.linkedAt))
    .all();
}
