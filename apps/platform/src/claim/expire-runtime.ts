/**
 * The cron side of unclaimed-project expiry: builds `ExpiryDeps` from the Worker's bindings.
 * Deleting Artifacts repos is a write, so it goes through an `ArtifactsGitHost` whose write guard
 * admits exactly the expiring project's repo and forks, nothing else (the merge queue stays the
 * only writer of any other main repo).
 */
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import { ArtifactsGitHost, FlagshipFlags, WorkersDeployer } from "@app/coordinator/adapters";
import * as gitwire from "@app/gitwire";
import type { Bindings } from "../app-env.js";
import { DoAudit } from "../audit/audit.js";
import { DEPLOY_SCRIPT_PREFIX } from "../services/repos.js";
import { D1Store } from "../store/d1-store.js";
import { workspaceIdFor } from "../workspace/model.js";
import { type ExpiredProject, type ExpiryDeps, expireUnclaimedProjects } from "./expire.js";

export function expiryDeps(env: Bindings, now: () => Date = () => new Date()): ExpiryDeps {
  const api = { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN };
  const workers = new WorkersDeployer({
    ...api,
    loadBundle: async () => {
      throw new Error("expiry never deploys");
    },
  });
  const flags = new FlagshipFlags(api);
  return {
    store: new D1Store(env.DB, env.BLOBS, now),
    blobs: env.BLOBS,
    audit: new DoAudit(env),
    git: (names) =>
      new ArtifactsGitHost({
        binding: env.ARTIFACTS,
        wire: gitwire,
        namespace: env.ARTIFACTS_NAMESPACE,
        accountId: env.CF_ACCOUNT_ID,
        canWrite: (repo) => names.has(repo),
      }),
    abandonChange: async (changeId) => {
      await env.COORDINATOR.getByName(changeId).abandon(changeId);
    },
    closeWorkspace: async (changeId) => {
      await env.WORKSPACE.getByName(workspaceIdFor(changeId)).close(
        SYSTEM_PRINCIPAL_ID,
        "project expired",
      );
    },
    destroyPreview: async (previewId) => {
      await env.PREVIEW_HOST.getByName(previewId).destroy();
    },
    deleteWorker: async (script) => {
      // Only ever a project Worker: never the platform's own or anything outside `gf-`.
      if (!script.startsWith(DEPLOY_SCRIPT_PREFIX))
        throw new Error(`not a project Worker: ${script}`);
      await workers.deleteScript(script);
    },
    deleteFlagApp: (appId) => flags.deleteApp(appId),
    now,
  };
}

export async function runExpiry(env: Bindings): Promise<ExpiredProject[]> {
  const results = await expireUnclaimedProjects(expiryDeps(env));
  if (results.length > 0) {
    console.log(
      JSON.stringify({
        event: "unclaimed-expiry",
        expired: results.filter((r) => r.ok).length,
        results,
      }),
    );
  }
  return results;
}
