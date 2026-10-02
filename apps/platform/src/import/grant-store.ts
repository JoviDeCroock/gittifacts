/** D1 rows of import-by-push grants (`import_grants`, src/db/import-schema.ts). */
import { and, eq, lte, ne, or } from "drizzle-orm";
import { type IMPORT_CLOSE_REASONS, importGrants } from "../db/import-schema.js";
import type { Db } from "../store/d1-store.js";

export type ImportGrantRow = typeof importGrants.$inferSelect;
export type ImportCloseReason = (typeof IMPORT_CLOSE_REASONS)[number];

export async function getGrant(db: Db, repoId: string): Promise<ImportGrantRow | null> {
  return (
    (await db.select().from(importGrants).where(eq(importGrants.repoId, repoId)).get()) ?? null
  );
}

/**
 * A new open grant for `repoId`. Replaces a closed one only: a grant that is still open or
 * closing must be closed (its token revoked) first, so no repo ever has two live tokens.
 */
export async function putOpenGrant(
  db: Db,
  row: Pick<ImportGrantRow, "repoId" | "openedBy" | "tokenId" | "openedAt" | "openUntil">,
): Promise<boolean> {
  const fresh = {
    ...row,
    status: "open" as const,
    closeReason: null,
    closedAt: null,
    mainSha: null,
  };
  const out = await db
    .insert(importGrants)
    .values(fresh)
    .onConflictDoUpdate({
      target: importGrants.repoId,
      set: fresh,
      setWhere: eq(importGrants.status, "closed"),
    })
    .returning({ repoId: importGrants.repoId });
  return out.length > 0;
}

/** open → closing, keeping the first reason. False when it was already closing or closed. */
export async function markClosing(
  db: Db,
  repoId: string,
  reason: ImportCloseReason,
): Promise<boolean> {
  const out = await db
    .update(importGrants)
    .set({ status: "closing", closeReason: reason })
    .where(and(eq(importGrants.repoId, repoId), eq(importGrants.status, "open")))
    .returning({ repoId: importGrants.repoId });
  return out.length > 0;
}

/** closing → closed. Exactly one caller wins (it audits and starts what follows the import). */
export async function markClosed(
  db: Db,
  repoId: string,
  input: { closedAt: string; mainSha: string | null },
): Promise<boolean> {
  const out = await db
    .update(importGrants)
    .set({ status: "closed", closedAt: input.closedAt, mainSha: input.mainSha })
    .where(and(eq(importGrants.repoId, repoId), ne(importGrants.status, "closed")))
    .returning({ repoId: importGrants.repoId });
  return out.length > 0;
}

/** Grants the cron must finish: past their TTL, or closing (revocation not confirmed yet). */
export async function grantsToSweep(db: Db, nowIso: string): Promise<ImportGrantRow[]> {
  return db
    .select()
    .from(importGrants)
    .where(
      or(
        eq(importGrants.status, "closing"),
        and(eq(importGrants.status, "open"), lte(importGrants.openUntil, nowIso)),
      ),
    )
    .limit(50)
    .all();
}
