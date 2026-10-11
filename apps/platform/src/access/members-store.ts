/**
 * `repo_members` queries. Everything that reads or writes memberships goes through here.
 */
import { and, eq, sql } from "drizzle-orm";
import { principals, repoMembers, repos } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";
import { isRepoRole, type RepoRole } from "./roles.js";

export interface MemberRow {
  repoId: string;
  principalId: string;
  role: RepoRole;
  addedBy: string;
  addedAt: string;
}

function toRow(r: typeof repoMembers.$inferSelect): MemberRow | null {
  return isRepoRole(r.role) ? { ...r, role: r.role } : null;
}

export async function memberRole(
  store: D1Store,
  repoId: string,
  principalId: string,
): Promise<RepoRole | null> {
  const r = await store.db
    .select({ role: repoMembers.role })
    .from(repoMembers)
    .where(and(eq(repoMembers.repoId, repoId), eq(repoMembers.principalId, principalId)))
    .get();
  return r && isRepoRole(r.role) ? r.role : null;
}

/** Every repo a principal is a member of, with its role. */
export async function membershipsOf(
  store: D1Store,
  principalId: string,
): Promise<Map<string, RepoRole>> {
  const rows = await store.db
    .select({ repoId: repoMembers.repoId, role: repoMembers.role })
    .from(repoMembers)
    .where(eq(repoMembers.principalId, principalId))
    .all();
  const out = new Map<string, RepoRole>();
  for (const r of rows) if (isRepoRole(r.role)) out.set(r.repoId, r.role);
  return out;
}

export async function listMemberRows(store: D1Store, repoId: string): Promise<MemberRow[]> {
  const rows = await store.db
    .select()
    .from(repoMembers)
    .where(eq(repoMembers.repoId, repoId))
    .orderBy(repoMembers.addedAt)
    .all();
  return rows.map(toRow).filter((r): r is MemberRow => r !== null);
}

export async function countOwners(store: D1Store, repoId: string): Promise<number> {
  const r = await store.db
    .select({ n: sql<number>`count(*)` })
    .from(repoMembers)
    .where(and(eq(repoMembers.repoId, repoId), eq(repoMembers.role, "owner")))
    .get();
  return r?.n ?? 0;
}

/**
 * How many distinct humans belong to a repo: its human `repo_members` rows (any role) plus the
 * claim owner (normally an owner row already; counted once either way). Pending invites are not
 * members. Separation of duties on `.platform/**` reads this (the coordinator's solo exception).
 */
export async function countHumanMembers(store: D1Store, repoId: string): Promise<number> {
  const r = await store.db
    .select({ n: sql<number>`count(DISTINCT ${principals.id})` })
    .from(principals)
    .where(
      and(
        eq(principals.kind, "human"),
        sql`(${principals.id} IN (SELECT m.principal_id FROM ${repoMembers} m WHERE m.repo_id = ${repoId})
          OR ${principals.id} = (SELECT ${repos.claimOwnerId} FROM ${repos} WHERE ${repos.id} = ${repoId} AND ${repos.claimStatus} = 'claimed'))`,
      ),
    )
    .get();
  if (typeof r?.n !== "number") throw new Error(`could not count the members of repo ${repoId}`);
  return r.n;
}

/** Insert or change a membership (the caller checked who may). */
export async function putMember(store: D1Store, row: MemberRow): Promise<void> {
  await store.db
    .insert(repoMembers)
    .values(row)
    .onConflictDoUpdate({
      target: [repoMembers.repoId, repoMembers.principalId],
      set: { role: row.role, addedBy: row.addedBy, addedAt: row.addedAt },
    });
}

/**
 * Remove a membership unless it is the repo's last owner, in one statement (so two owners
 * removing each other at once cannot leave the repo without one). True when a row went.
 */
export async function removeMemberRow(
  store: D1Store,
  repoId: string,
  principalId: string,
): Promise<boolean> {
  const rows = await store.db
    .delete(repoMembers)
    .where(
      and(
        eq(repoMembers.repoId, repoId),
        eq(repoMembers.principalId, principalId),
        sql`(${repoMembers.role} <> 'owner' OR (SELECT count(*) FROM ${repoMembers} m WHERE m.repo_id = ${repoId} AND m.role = 'owner') > 1)`,
      ),
    )
    .returning({ principalId: repoMembers.principalId });
  return rows.length > 0;
}

/**
 * Demote an owner unless they are the last one (same single-statement guard as removal).
 * True when the row changed.
 */
export async function changeRoleRow(store: D1Store, row: MemberRow): Promise<boolean> {
  const rows = await store.db
    .update(repoMembers)
    .set({ role: row.role, addedBy: row.addedBy, addedAt: row.addedAt })
    .where(
      and(
        eq(repoMembers.repoId, row.repoId),
        eq(repoMembers.principalId, row.principalId),
        sql`(${repoMembers.role} <> 'owner' OR ${row.role} = 'owner' OR (SELECT count(*) FROM ${repoMembers} m WHERE m.repo_id = ${row.repoId} AND m.role = 'owner') > 1)`,
      ),
    )
    .returning({ principalId: repoMembers.principalId });
  return rows.length > 0;
}

/** True when `id` is a human principal (only humans are members). */
export async function isHumanPrincipal(store: D1Store, id: string): Promise<boolean> {
  const p = await store.db
    .select({ kind: principals.kind })
    .from(principals)
    .where(eq(principals.id, id))
    .get();
  return p?.kind === "human";
}

/**
 * The (unexecuted) statement that makes `ownerId` an `owner` member of a claimed repo; D1Store
 * batches it with the repo write after `isHumanPrincipal` (so it can never fail on the FK and sink
 * the repo write). Not async on purpose: drizzle builders are thenables.
 */
export function ownerMembershipInsert(store: D1Store, repoId: string, ownerId: string, at: string) {
  return store.db
    .insert(repoMembers)
    .values({ repoId, principalId: ownerId, role: "owner", addedBy: "system", addedAt: at })
    .onConflictDoUpdate({
      target: [repoMembers.repoId, repoMembers.principalId],
      set: { role: "owner" },
    });
}
