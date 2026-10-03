/**
 * Coordinator hooks for GitHub Changes reviewed on gittifacts (M3): the PR's summary comment is
 * refreshed (an approval here shows on GitHub), and the PR's author can't review it here either
 * (their linked GitHub login is the author's).
 */
import type { CoordinatorOptions } from "@app/coordinator";
import { and, eq } from "drizzle-orm";
import type { Bindings } from "../app-env.js";
import { githubInstallationLinks } from "../db/github-schema.js";
import { buildPorts } from "../runtime/ports.js";
import { D1Store } from "../store/d1-store.js";
import { githubHostFor } from "./runtime.js";

export function githubReviewOptions(env: Bindings): Pick<CoordinatorOptions, "onHostReview" | "isHostAuthor"> {
  return {
    async onHostReview(change) {
      if (change.host == null) return;
      const ports = buildPorts(env, "default");
      const repo = await ports.store.getRepo(change.repoId);
      if (repo?.host == null) return;
      const { host, release } = githubHostFor(env, ports, repo.host);
      try {
        await host.publishSummary({ host: "github", owner: repo.host.owner, repo: repo.host.repo, number: change.host.number });
      } finally {
        await release();
      }
    },
    async isHostAuthor(change, principalId) {
      if (change.host == null) return false;
      const db = new D1Store(env.DB, env.BLOBS).db;
      const link = await db
        .select({ login: githubInstallationLinks.githubLogin })
        .from(githubInstallationLinks)
        .where(and(eq(githubInstallationLinks.principalId, principalId), eq(githubInstallationLinks.githubLogin, change.host.author.login)))
        .get();
      return link !== undefined;
    },
  };
}
