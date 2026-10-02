/**
 * Quotas for unclaimed projects (onboarding §4), kept in the `ProjectLedger` Durable Object:
 * one per project (named by repo id) and one per creating IP (`ip:<hash>`), so a single source
 * can't multiply its allowance by creating more projects.
 *
 * - CI minutes per UTC day: reserved when a run starts (`reserveCi`, clamped per run), settled
 *   to what the run used when it finishes (src/limits/coordinator-do.ts).
 * - Storage: bytes the platform keeps for the project (CI logs and build artifacts), all time.
 * - Artifacts operations per UTC day: every platform-mediated operation on the project's repos
 *   (forks, push and clone tokens, CI checkouts).
 *
 * Claimed projects are never metered here. Every refusal is `quota-exceeded` (429) with a fix
 * that names the claim link.
 */
import { fixFor } from "@app/conventions";
import type { Repo } from "@app/domain";
import { eq } from "drizzle-orm";
import { projectClaims } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { D1Store } from "../store/d1-store.js";
import type { ProjectLedger } from "../workspace/ledger-do.js";
import type { UnclaimedLimits } from "./config.js";

export interface QuotaEnv {
  PROJECT_LEDGER: DurableObjectNamespace<ProjectLedger>;
}

export type QuotaName = "ci-minutes" | "storage-bytes" | "artifacts-ops";

export const isUnclaimed = (repo: Pick<Repo, "claim">) => repo.claim.status !== "claimed";

/** The ledgers a project's usage counts against: its own, plus its creator IP's aggregate. */
export async function ledgersFor(
  env: QuotaEnv,
  store: D1Store,
  repoId: string,
): Promise<{
  project: DurableObjectStub<ProjectLedger>;
  ip: DurableObjectStub<ProjectLedger> | null;
}> {
  const row = await store.db
    .select({ ipHash: projectClaims.creatorIpHash })
    .from(projectClaims)
    .where(eq(projectClaims.repoId, repoId))
    .get();
  return {
    project: env.PROJECT_LEDGER.getByName(repoId),
    ip: row ? env.PROJECT_LEDGER.getByName(`ip:${row.ipHash}`) : null,
  };
}

export function quotaExceeded(
  repo: Pick<Repo, "id">,
  quota: QuotaName,
  scope: "project" | "ip",
  used: number,
  limit: number,
  claimUrl: string | null,
  resetsAt: string | null,
): ApiError {
  const words = {
    "ci-minutes": "CI minutes today",
    "storage-bytes": "storage",
    "artifacts-ops": "Artifacts operations today",
  }[quota];
  const who =
    scope === "ip" ? "unclaimed projects created from your address" : `project ${repo.id}`;
  const base = fixFor("quota-exceeded", {
    quota: { name: quota, limit, used, ...(resetsAt === null ? {} : { resetsAt }) },
    ...(claimUrl === null ? {} : { claimUrl }),
  });
  return new ApiError(
    429,
    "quota-exceeded",
    `${who} used up the unclaimed ${words} quota (${Math.round(used)}/${limit})`,
    { quota, scope, used, limit, resetsAt, claimUrl },
    {
      ...base,
      explanation: `${base.explanation} ${claimUrl === null ? "Give the claimUrl from create_project to a human" : `Give this link to a human: ${claimUrl}`}; claiming lifts the unclaimed limits.`,
    },
  );
}

export function nextUtcMidnight(atMs: number): string {
  const d = new Date(atMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * Charge `ops` Artifacts operations to an unclaimed project (and its IP aggregate) or throw
 * `quota-exceeded`. A no-op for claimed projects.
 */
export async function chargeArtifactsOps(
  env: QuotaEnv,
  store: D1Store,
  repo: Pick<Repo, "id" | "claim">,
  ops: number,
  limits: UnclaimedLimits,
  atMs: number,
  claimUrl: string | null,
): Promise<void> {
  if (!isUnclaimed(repo)) return;
  const { project, ip } = await ledgersFor(env, store, repo.id);
  const metric = "artifacts-ops";
  const p = await project.charge({
    metric,
    amount: ops,
    limit: limits.artifactsOpsPerDay,
    period: "day",
    atMs,
  });
  if (!p.ok)
    throw quotaExceeded(
      repo,
      metric,
      "project",
      p.used,
      limits.artifactsOpsPerDay,
      claimUrl,
      nextUtcMidnight(atMs),
    );
  if (ip !== null) {
    const i = await ip.charge({
      metric,
      amount: ops,
      limit: limits.perIp.artifactsOpsPerDay,
      period: "day",
      atMs,
    });
    if (!i.ok) {
      await project.add({ metric, amount: -ops, period: "day", atMs });
      throw quotaExceeded(
        repo,
        metric,
        "ip",
        i.used,
        limits.perIp.artifactsOpsPerDay,
        claimUrl,
        nextUtcMidnight(atMs),
      );
    }
  }
}

export interface UnclaimedUsage {
  ciMinutesUsedToday: number;
  storageBytes: number;
  artifactsOpsToday: number;
}

export async function usageOf(
  env: QuotaEnv,
  store: D1Store,
  repoId: string,
  atMs: number,
): Promise<{ project: UnclaimedUsage; ip: UnclaimedUsage | null }> {
  const { project, ip } = await ledgersFor(env, store, repoId);
  const read = async (l: DurableObjectStub<ProjectLedger>): Promise<UnclaimedUsage> => {
    const c = await l.counters({
      metrics: [
        { metric: "ci-minutes", period: "day" },
        { metric: "storage-bytes", period: "total" },
        { metric: "artifacts-ops", period: "day" },
      ],
      atMs,
    });
    return {
      ciMinutesUsedToday: c["ci-minutes"] ?? 0,
      storageBytes: c["storage-bytes"] ?? 0,
      artifactsOpsToday: c["artifacts-ops"] ?? 0,
    };
  };
  return { project: await read(project), ip: ip === null ? null : await read(ip) };
}

/**
 * Before granting more work (a Change, a push token, a workspace): refuse when the project (or
 * its IP aggregate) has no CI minutes left today or is over its storage quota. A no-op for
 * claimed projects.
 */
export async function assertCanStartWork(
  env: QuotaEnv,
  store: D1Store,
  repo: Pick<Repo, "id" | "claim">,
  limits: UnclaimedLimits,
  atMs: number,
  claimUrl: string | null,
): Promise<void> {
  if (!isUnclaimed(repo)) return;
  const u = await usageOf(env, store, repo.id, atMs);
  const reset = nextUtcMidnight(atMs);
  if (u.project.storageBytes >= limits.storageBytes)
    throw quotaExceeded(
      repo,
      "storage-bytes",
      "project",
      u.project.storageBytes,
      limits.storageBytes,
      claimUrl,
      null,
    );
  if (u.ip !== null && u.ip.storageBytes >= limits.perIp.storageBytes)
    throw quotaExceeded(
      repo,
      "storage-bytes",
      "ip",
      u.ip.storageBytes,
      limits.perIp.storageBytes,
      claimUrl,
      null,
    );
  if (u.project.ciMinutesUsedToday > limits.ci.minutesPerDay - 1)
    throw quotaExceeded(
      repo,
      "ci-minutes",
      "project",
      u.project.ciMinutesUsedToday,
      limits.ci.minutesPerDay,
      claimUrl,
      reset,
    );
  if (u.ip !== null && u.ip.ciMinutesUsedToday > limits.perIp.ciMinutesPerDay - 1)
    throw quotaExceeded(
      repo,
      "ci-minutes",
      "ip",
      u.ip.ciMinutesUsedToday,
      limits.perIp.ciMinutesPerDay,
      claimUrl,
      reset,
    );
}
