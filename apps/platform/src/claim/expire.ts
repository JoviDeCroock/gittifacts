/**
 * Expiry of unclaimed projects (onboarding §4: "expire after a configurable TTL unless claimed").
 * A cron trigger (wrangler.jsonc `triggers.crons`, src/index.ts `scheduled`) runs this every few
 * minutes. For each unclaimed project past its `expiresAt`:
 *
 * 1. `project_claims.status` unclaimed → expiring, in one conditional update (a racing claim
 *    either won before, and the project is kept, or loses);
 * 2. its agent's tokens are revoked and the agent is disabled (every request fails at once);
 * 3. every Change's workflow and CI run is stopped, its workspace closed, its previews destroyed;
 * 4. the Artifacts repos are deleted: the change forks and the project repo (deleting a repo
 *    also revokes its Artifacts tokens); then the project's Worker (if it ever had a deploy
 *    target) and its own Flagship app, in that order (Flagship refuses to delete an app a Worker
 *    still binds);
 * 5. R2 objects (CI runs, logs, evidence, artifacts, screenshots, spilled diffs/evidence) and the
 *    D1 rows (repo and everything that cascades from it, previews, onboarding, notifications)
 *    are deleted; audit events are kept, and so is the claim row as a tombstone (`expired`);
 * 6. `project.expired` is audit-logged.
 *
 * A step that fails leaves the project `expiring`; the next run picks it up again.
 */
import type { Audit, GitHost } from "@app/coordinator";
import { SYSTEM_PRINCIPAL_ID } from "@app/coordinator";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { revokeAgentTokens } from "../auth/agent-tokens.js";
import { disablePrincipal } from "../auth/principals.js";
import {
  changes,
  diffs,
  evidence,
  idempotencyKeys,
  notifications,
  previews,
  projectClaims,
  projectOnboarding,
  repos,
  unclaimedCreations,
} from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export interface ExpiryDeps {
  store: D1Store;
  blobs: R2Bucket;
  audit: Audit;
  /** A GitHost allowed to delete exactly `names` (the project repo and its forks). */
  git(names: ReadonlySet<string>): Pick<GitHost, "deleteRepo">;
  abandonChange(changeId: string): Promise<void>;
  closeWorkspace(changeId: string): Promise<void>;
  destroyPreview(previewId: string): Promise<void>;
  /** Delete a project Worker (`gf-…`); a missing one is fine. */
  deleteWorker(script: string): Promise<void>;
  /** Delete a project's own Flagship app; a missing one is fine. */
  deleteFlagApp(appId: string): Promise<void>;
  now(): Date;
}

export interface ExpiredProject {
  repoId: string;
  name: string;
  ok: boolean;
  reposDeleted: string[];
  /** The project's Worker and Flagship app, when it had them. */
  workerDeleted?: string;
  flagAppDeleted?: string;
  objectsDeleted: number;
  error: string | null;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Projects due now: their claim row says so, or (no claim row) the repo row does. */
async function due(store: D1Store, nowIso: string, limit: number): Promise<string[]> {
  const fromClaims = await store.db
    .select({ repoId: projectClaims.repoId })
    .from(projectClaims)
    .where(
      or(
        and(eq(projectClaims.status, "unclaimed"), lte(projectClaims.expiresAt, nowIso)),
        eq(projectClaims.status, "expiring"),
      ),
    )
    .limit(limit)
    .all();
  const fromRepos = await store.db
    .select({ repoId: repos.id })
    .from(repos)
    .where(and(eq(repos.claimStatus, "unclaimed"), lte(repos.claimExpiresAt, nowIso)))
    .limit(limit)
    .all();
  return [...new Set([...fromClaims, ...fromRepos].map((r) => r.repoId))].slice(0, limit);
}

/** unclaimed → expiring, unless a claim got there first. True when this run may delete it. */
async function begin(store: D1Store, repoId: string, nowIso: string): Promise<boolean> {
  const row = await store.db
    .select({ status: projectClaims.status })
    .from(projectClaims)
    .where(eq(projectClaims.repoId, repoId))
    .get();
  const repo = await store.getRepo(repoId);
  if (row === undefined) {
    return (
      repo !== null && repo.claim.status === "unclaimed" && (repo.claim.expiresAt ?? "") <= nowIso
    );
  }
  if (row.status === "expiring") return true;
  if (row.status !== "unclaimed") return false;
  const moved = await store.db
    .update(projectClaims)
    .set({ status: "expiring" })
    .where(
      and(
        eq(projectClaims.repoId, repoId),
        eq(projectClaims.status, "unclaimed"),
        lte(projectClaims.expiresAt, nowIso),
      ),
    )
    .returning({ repoId: projectClaims.repoId });
  return moved.length > 0;
}

async function deletePrefix(blobs: R2Bucket, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await blobs.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) await blobs.delete(keys);
    n += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return n;
}

const CI_PREFIXES = ["ci-runs", "ci-logs", "ci-evidence", "ci-artifacts"] as const;

async function expireOne(deps: ExpiryDeps, repoId: string): Promise<ExpiredProject> {
  const { store, blobs } = deps;
  const repo = await store.getRepo(repoId);
  const claim = await store.db
    .select()
    .from(projectClaims)
    .where(eq(projectClaims.repoId, repoId))
    .get();
  const name = repo?.name ?? claim?.projectName ?? repoId;
  const out: ExpiredProject = {
    repoId,
    name,
    ok: false,
    reposDeleted: [],
    objectsDeleted: 0,
    error: null,
  };
  const now = deps.now();

  // 2. The project's agent can do nothing from here on.
  if (claim !== undefined) {
    await revokeAgentTokens(store, claim.agentPrincipalId, now);
    await disablePrincipal(store, claim.agentPrincipalId, now);
  }

  // 3. Stop everything that runs for it.
  const rows = await store.db
    .select({ id: changes.id, forkName: changes.forkName })
    .from(changes)
    .where(eq(changes.repoId, repoId))
    .all();
  const changeIds = rows.map((r) => r.id);
  const previewRows =
    changeIds.length === 0
      ? []
      : await store.db
          .select({ id: previews.id })
          .from(previews)
          .where(eq(previews.repoId, repoId))
          .all();
  for (const c of rows) {
    await deps.abandonChange(c.id).catch((e: unknown) => console.warn("expire: abandon", c.id, e));
    await deps
      .closeWorkspace(c.id)
      .catch((e: unknown) => console.warn("expire: workspace", c.id, e));
  }
  for (const p of previewRows) {
    await deps.destroyPreview(p.id).catch((e: unknown) => console.warn("expire: preview", p.id, e));
  }

  // 4. Artifacts: the forks, then the project repo.
  const names = new Set<string>(rows.map((r) => r.forkName));
  if (repo !== null) names.add(repo.artifactsName);
  const git = deps.git(names);
  for (const n of names) {
    try {
      await git.deleteRepo(n);
      out.reposDeleted.push(n);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/NOT_FOUND|not found/i.test(msg)) {
        out.error = `could not delete ${n}: ${msg}`;
        return out;
      }
    }
  }

  // 4b. The project's Worker, then its Flagship app (an app a Worker binds cannot be deleted).
  if (repo?.deployTarget) {
    try {
      await deps.deleteWorker(repo.deployTarget);
      out.workerDeleted = repo.deployTarget;
    } catch (e) {
      out.error = `could not delete the Worker ${repo.deployTarget}: ${errorText(e)}`;
      return out;
    }
  }
  if (repo?.flagshipAppId) {
    try {
      await deps.deleteFlagApp(repo.flagshipAppId);
      out.flagAppDeleted = repo.flagshipAppId;
    } catch (e) {
      out.error = `could not delete the Flagship app ${repo.flagshipAppId}: ${errorText(e)}`;
      return out;
    }
  }

  // 5. R2, then D1 (audit events stay).
  const spilled =
    changeIds.length === 0
      ? []
      : [
          ...(await store.db
            .select({ k: diffs.r2Key })
            .from(diffs)
            .where(inArray(diffs.changeId, changeIds))
            .all()),
          ...(await store.db
            .select({ k: evidence.r2Key })
            .from(evidence)
            .where(inArray(evidence.changeId, changeIds))
            .all()),
        ].flatMap((r) => (r.k === null ? [] : [r.k]));
  if (spilled.length > 0) await blobs.delete(spilled);
  out.objectsDeleted += spilled.length;
  for (const id of changeIds) {
    for (const p of CI_PREFIXES) {
      out.objectsDeleted += await deletePrefix(blobs, `${p}/run-${id}-`);
      out.objectsDeleted += await deletePrefix(blobs, `${p}/mq-${id}-`);
    }
    out.objectsDeleted += await deletePrefix(blobs, `screenshots/${id}/`);
  }
  await store.db.delete(previews).where(eq(previews.repoId, repoId));
  await store.db.delete(projectOnboarding).where(eq(projectOnboarding.projectId, repoId));
  await store.db
    .delete(notifications)
    .where(
      changeIds.length === 0
        ? eq(notifications.repoId, repoId)
        : or(eq(notifications.repoId, repoId), inArray(notifications.changeId, changeIds)),
    );
  if (claim !== undefined) {
    await store.db
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.principalId, claim.agentPrincipalId));
    await store.db
      .delete(unclaimedCreations)
      .where(eq(unclaimedCreations.principalId, claim.agentPrincipalId));
  }
  // Plans, changes, runs, diffs, evidence, classifications, tours, reviews and cached policies
  // cascade from the repo row.
  await store.db.delete(repos).where(eq(repos.id, repoId));
  if (claim !== undefined) {
    await store.db
      .update(projectClaims)
      .set({ status: "expired", expiredAt: now.toISOString() })
      .where(and(eq(projectClaims.repoId, repoId), isNull(projectClaims.claimedAt)));
  }

  // 6. On the record.
  await deps.audit.append({
    principalId: SYSTEM_PRINCIPAL_ID,
    action: "project.expired",
    subject: `repo:${repoId}`,
    payload: {
      name,
      expiresAt: claim?.expiresAt ?? repo?.claim.expiresAt ?? null,
      changes: changeIds.length,
      previews: previewRows.length,
      reposDeleted: out.reposDeleted,
      workerDeleted: out.workerDeleted ?? null,
      flagAppDeleted: out.flagAppDeleted ?? null,
      objectsDeleted: out.objectsDeleted,
    },
  });
  out.ok = true;
  return out;
}

/** Expire every unclaimed project that is due (at most `limit` per run). */
export async function expireUnclaimedProjects(
  deps: ExpiryDeps,
  opts: { limit?: number } = {},
): Promise<ExpiredProject[]> {
  const nowIso = deps.now().toISOString();
  const results: ExpiredProject[] = [];
  for (const repoId of await due(deps.store, nowIso, opts.limit ?? 10)) {
    if (!(await begin(deps.store, repoId, nowIso))) continue;
    try {
      results.push(await expireOne(deps, repoId));
    } catch (e) {
      console.error("expire: project", repoId, e);
      results.push({
        repoId,
        name: repoId,
        ok: false,
        reposDeleted: [],
        objectsDeleted: 0,
        error: String(e),
      });
    }
  }
  return results;
}
