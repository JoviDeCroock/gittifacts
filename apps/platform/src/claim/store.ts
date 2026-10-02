/** `project_claims` rows: the lifecycle record of an unclaimed project (see ../db/claim-schema.ts). */
import { eq } from "drizzle-orm";
import { projectClaims } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";
import { claimUrlFor, deriveClaimToken, hashClaimToken } from "./tokens.js";

export type ClaimRow = typeof projectClaims.$inferSelect;

export async function claimRowByRepo(store: D1Store, repoId: string): Promise<ClaimRow | null> {
  return (
    (await store.db.select().from(projectClaims).where(eq(projectClaims.repoId, repoId)).get()) ??
    null
  );
}

export async function claimRowByToken(store: D1Store, token: string): Promise<ClaimRow | null> {
  const hash = await hashClaimToken(token);
  return (
    (await store.db
      .select()
      .from(projectClaims)
      .where(eq(projectClaims.claimTokenHash, hash))
      .get()) ?? null
  );
}

/** The project's claim link, for its own agent (fixes, whoami); null when it has no claim row. */
export async function claimUrlForRepo(
  env: { BETTER_AUTH_SECRET?: string },
  store: D1Store,
  origin: string,
  repoId: string,
): Promise<string | null> {
  const row = await claimRowByRepo(store, repoId);
  if (row === null || row.status !== "unclaimed") return null;
  const token = await deriveClaimToken(env, {
    repoId: row.repoId,
    agentPrincipalId: row.agentPrincipalId,
    createdAt: row.createdAt,
  });
  return claimUrlFor(origin, token);
}
