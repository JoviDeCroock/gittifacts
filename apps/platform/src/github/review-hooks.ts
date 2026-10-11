/**
 * Coordinator hooks for GitHub Changes reviewed on gittifacts (M3): the PR's summary comment is
 * refreshed (an approval here shows on GitHub), and the PR's author can't review it here either
 * (a GitHub account they linked is the PR author's, by numeric id).
 */
import type { CoordinatorOptions } from "@app/coordinator";
import { eq } from "drizzle-orm";
import type { Bindings } from "../app-env.js";
import { githubInstallationLinks } from "../db/github-schema.js";
import { buildPorts } from "../runtime/ports.js";
import { D1Store } from "../store/d1-store.js";
import { githubHostFor } from "./runtime.js";

export function githubReviewOptions(
  env: Bindings,
): Pick<CoordinatorOptions, "onHostReview" | "isHostAuthor"> {
  return {
    async onHostReview(change) {
      if (change.host == null) return;
      const ports = buildPorts(env, "default");
      const repo = await ports.store.getRepo(change.repoId);
      if (repo?.host == null) return;
      const { host, release } = githubHostFor(env, ports, repo.host);
      try {
        await host.publishSummary({
          host: "github",
          owner: repo.host.owner,
          repo: repo.host.repo,
          number: change.host.number,
        });
      } finally {
        await release();
      }
    },
    // Ids, never logins (security audit 2026-10-11, M4): a login can be renamed or re-registered.
    // A link from before github_user_id was recorded can't tell, so it counts as the author.
    async isHostAuthor(change, principalId) {
      if (change.host == null) return false;
      if (change.authorId === principalId) return true;
      const db = new D1Store(env.DB, env.BLOBS).db;
      const links = await db
        .select({ githubUserId: githubInstallationLinks.githubUserId })
        .from(githubInstallationLinks)
        .where(eq(githubInstallationLinks.principalId, principalId))
        .all();
      const author = change.host.author.id;
      return links.some((l) => l.githubUserId === null || l.githubUserId === author);
    },
  };
}
