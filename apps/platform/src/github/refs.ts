/**
 * `owner/repo#123` → the Change that grades that pull request (GitHub mode). The repository must
 * be graded here (a platform repo row with a GitHub host); access is checked by the caller's
 * next step (the change's repo), and an unknown repository is plain not-found.
 */
import { parseChangeRef } from "@app/host";
import { changeIdFor } from "@app/host-github";
import { and, isNotNull, sql } from "drizzle-orm";
import { repos } from "../db/app-schema.js";
import { notFound } from "../errors.js";
import type { Db } from "../store/d1-store.js";

export async function resolveGithubChangeId(
  db: Db,
  ref: string,
): Promise<{ changeId: string; repoId: string }> {
  const parsed = parseChangeRef(ref);
  if (parsed === null || parsed.host !== "github") {
    throw notFound(`pull request ${ref}`, { explanation: "Name it as owner/repo#123." });
  }
  const fullName = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  const row = await db
    .select({ id: repos.id, host: repos.host })
    .from(repos)
    .where(and(sql`lower(${repos.name}) = ${fullName}`, isNotNull(repos.host)))
    .get();
  const githubRepoId = (row?.host as { githubRepoId?: unknown } | null | undefined)?.githubRepoId;
  if (row === undefined || typeof githubRepoId !== "number") {
    throw notFound(`pull request ${ref}`, {
      explanation: `gittifacts doesn't grade ${parsed.owner}/${parsed.repo}: install the GitHub App on it (Settings → GitHub), then open or update a pull request.`,
    });
  }
  return { changeId: changeIdFor(githubRepoId, parsed.number), repoId: row.id };
}
