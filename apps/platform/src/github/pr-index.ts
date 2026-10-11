/**
 * M3 in D1: what gittifacts wrote on each pull request (`PrIndex`, packages/host-github), and
 * the per-repo switch for those writes.
 *
 * PR writes beyond the check run (the tour review, the summary comment) are on once someone on
 * the platform has linked the repo's installation (a human answers for them), unless a repo owner
 * turned them off (DECISIONS 2026-10-03, M3). An unlinked installation gets the check run only.
 */
import type { PrIndex, StoredReview } from "@app/host-github";
import { and, eq, isNull } from "drizzle-orm";
import {
  githubFullReviews,
  githubInstallationLinks,
  githubPrReviews,
  githubPrSummaries,
  githubRepoSettings,
} from "../db/github-schema.js";
import type { Db } from "../store/d1-store.js";

const row = (r: typeof githubPrReviews.$inferSelect): StoredReview => ({
  changeId: r.changeId,
  headSha: r.headSha,
  reviewId: r.reviewId,
  nodeId: r.nodeId,
  commentIds: r.commentIds,
  staleAt: r.staleAt,
});

export function d1PrIndex(db: Db, now: () => Date = () => new Date()): PrIndex {
  return {
    async review(changeId, headSha) {
      const r = await db
        .select()
        .from(githubPrReviews)
        .where(and(eq(githubPrReviews.changeId, changeId), eq(githubPrReviews.headSha, headSha)))
        .get();
      return r === undefined ? null : row(r);
    },
    async reviews(changeId) {
      return (
        await db.select().from(githubPrReviews).where(eq(githubPrReviews.changeId, changeId)).all()
      ).map(row);
    },
    async putReview(r) {
      const values = { ...r, createdAt: now().toISOString() };
      await db
        .insert(githubPrReviews)
        .values(values)
        .onConflictDoUpdate({
          target: [githubPrReviews.changeId, githubPrReviews.headSha],
          set: {
            reviewId: r.reviewId,
            nodeId: r.nodeId,
            commentIds: r.commentIds,
            staleAt: r.staleAt,
          },
        });
    },
    async markStale(changeId, headSha, at) {
      await db
        .update(githubPrReviews)
        .set({ staleAt: at })
        .where(
          and(
            eq(githubPrReviews.changeId, changeId),
            eq(githubPrReviews.headSha, headSha),
            isNull(githubPrReviews.staleAt),
          ),
        );
    },
    async summary(changeId) {
      const r = await db
        .select()
        .from(githubPrSummaries)
        .where(eq(githubPrSummaries.changeId, changeId))
        .get();
      return r === undefined ? null : { commentId: r.commentId, hash: r.bodyHash };
    },
    async putSummary(changeId, commentId, hash) {
      const at = now().toISOString();
      await db
        .insert(githubPrSummaries)
        .values({ changeId, commentId, bodyHash: hash, updatedAt: at })
        .onConflictDoUpdate({
          target: githubPrSummaries.changeId,
          set: { commentId, bodyHash: hash, updatedAt: at },
        });
    },
    async fullReviews(changeId, headSha) {
      const rows = await db
        .select({ login: githubFullReviews.login })
        .from(githubFullReviews)
        .where(
          and(eq(githubFullReviews.changeId, changeId), eq(githubFullReviews.headSha, headSha)),
        )
        .all();
      return rows.map((r) => ({ by: r.login }));
    },
    async addFullReview(changeId, headSha, login) {
      await db
        .insert(githubFullReviews)
        .values({ changeId, headSha, login, createdAt: now().toISOString() })
        .onConflictDoNothing();
    },
  };
}

/** The repo's PR-writes setting as stored ("on" unless set off). */
export async function prWritesSetting(db: Db, repoId: string): Promise<"on" | "off"> {
  const r = await db
    .select({ v: githubRepoSettings.prWrites })
    .from(githubRepoSettings)
    .where(eq(githubRepoSettings.repoId, repoId))
    .get();
  return r?.v ?? "on";
}

/** PR writes happen: the installation is linked by someone, and the repo didn't turn them off. */
export async function prWritesEnabled(
  db: Db,
  repoId: string,
  installationId: number,
): Promise<boolean> {
  const linked = await db
    .select({ id: githubInstallationLinks.installationId })
    .from(githubInstallationLinks)
    .where(eq(githubInstallationLinks.installationId, installationId))
    .get();
  return linked !== undefined && (await prWritesSetting(db, repoId)) === "on";
}

export async function setPrWrites(
  db: Db,
  input: { repoId: string; value: "on" | "off"; by: string; at: string },
): Promise<void> {
  await db
    .insert(githubRepoSettings)
    .values({
      repoId: input.repoId,
      prWrites: input.value,
      updatedBy: input.by,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      target: githubRepoSettings.repoId,
      set: { prWrites: input.value, updatedBy: input.by, updatedAt: input.at },
    });
}
