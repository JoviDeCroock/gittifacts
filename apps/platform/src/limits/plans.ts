/**
 * Plans: what a project may use per UTC day. Every project is on the free plan for now (paid plans
 * come later: `planOf` is where a project's plan will be read). The free plan is strict on
 * purpose: a free project costs the platform at most about $1 a day, and an account (its owner,
 * or for unclaimed projects the creating IP) at most `accountMultiplier` times that, however many
 * projects it has.
 *
 * Unclaimed projects keep their own, tighter CI, storage and Artifacts quotas (./config.ts); the
 * plan adds what those don't cover (previews, QA, AI per day) and is the only quota for claimed
 * ones. The `FREE_LIMITS` var (JSON, merged per section) overrides the defaults without a deploy
 * of new code.
 *
 * Usage is counted in `ProjectLedger`s: the project's own (named by repo id) and its account's
 * (`account:<ownerId>`, or `ip:<hash>` while unclaimed).
 */
import type { Repo } from "@app/domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { projectClaims, repos } from "../db/schema.js";
import type { ProjectLedger } from "../workspace/ledger-do.js";

export const PlanLimits = z.object({
  ci: z.object({
    /** Container-minutes of CI per day (every container of every run, settled when it ends). */
    minutesPerDay: z.number().int().min(1),
    minutesPerRun: z.number().int().min(1),
    instance: z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]),
  }),
  workspace: z.object({
    cpuMinutesPerDay: z.number().min(1),
    maxOpen: z.number().int().min(1),
    ttlMinutes: z.number().min(5),
  }),
  previews: z.object({
    /** Previews kept per project (older ones are destroyed). */
    live: z.number().int().min(1),
    /** A preview container is stopped this long after it booted (the next visit boots it again). */
    minutesPerBoot: z.number().min(5),
    /** Preview container-minutes per day; past it previews answer "paused until tomorrow". */
    minutesPerDay: z.number().min(5),
  }),
  qa: z.object({ perHour: z.number().int().min(1), perDay: z.number().int().min(1) }),
  ai: z.object({ usdPerDay: z.number().min(0) }),
  /** Account-wide caps are this many times a project's (CI, workspaces, previews, QA, AI). */
  accountMultiplier: z.number().min(1),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

export const FREE_PLAN: PlanLimits = {
  ci: { minutesPerDay: 120, minutesPerRun: 30, instance: "standard-2" },
  workspace: { cpuMinutesPerDay: 60, maxOpen: 1, ttlMinutes: 60 },
  previews: { live: 3, minutesPerBoot: 60, minutesPerDay: 180 },
  qa: { perHour: 3, perDay: 10 },
  ai: { usdPerDay: 0.5 },
  accountMultiplier: 2,
};

export type PlanId = "free";

/** The plan a project is on. Paid plans don't exist yet. */
export function planOf(_repo: Pick<Repo, "claim">): PlanId {
  return "free";
}

export interface PlanEnv {
  FREE_LIMITS?: string;
}

export function planLimits(env: PlanEnv, _plan: PlanId = "free"): PlanLimits {
  if (!env.FREE_LIMITS) return FREE_PLAN;
  try {
    const raw: unknown = JSON.parse(env.FREE_LIMITS);
    if (typeof raw !== "object" || raw === null) throw new Error("not an object");
    const o = raw as Record<string, unknown>;
    const section = <T extends object>(b: T, v: unknown): T =>
      typeof v === "object" && v !== null ? { ...b, ...(v as Partial<T>) } : b;
    const parsed = PlanLimits.safeParse({
      ci: section(FREE_PLAN.ci, o.ci),
      workspace: section(FREE_PLAN.workspace, o.workspace),
      previews: section(FREE_PLAN.previews, o.previews),
      qa: section(FREE_PLAN.qa, o.qa),
      ai: section(FREE_PLAN.ai, o.ai),
      accountMultiplier: o.accountMultiplier ?? FREE_PLAN.accountMultiplier,
    });
    if (parsed.success) return parsed.data;
    console.warn("FREE_LIMITS is invalid; using the defaults", parsed.error.issues[0]);
  } catch (e) {
    console.warn("FREE_LIMITS is not JSON; using the defaults", e);
  }
  return FREE_PLAN;
}

export type LedgerNs = Pick<DurableObjectNamespace<ProjectLedger>, "getByName">;

export interface PlanLedgers {
  project: DurableObjectStub<ProjectLedger>;
  /** The account's aggregate: null when the project has neither an owner nor a creator IP. */
  account: DurableObjectStub<ProjectLedger> | null;
  accountName: string | null;
}

/** The ledgers a project's plan usage counts against. */
export async function planLedgers(
  env: { DB: D1Database; PROJECT_LEDGER: LedgerNs },
  repoId: string,
): Promise<PlanLedgers> {
  const db = drizzle(env.DB);
  const repo = await db
    .select({ owner: repos.claimOwnerId, status: repos.claimStatus })
    .from(repos)
    .where(eq(repos.id, repoId))
    .get();
  let accountName: string | null = null;
  if (repo?.status === "claimed" && repo.owner) accountName = `account:${repo.owner}`;
  else {
    const claim = await db
      .select({ ipHash: projectClaims.creatorIpHash })
      .from(projectClaims)
      .where(eq(projectClaims.repoId, repoId))
      .get();
    if (claim) accountName = `ip:${claim.ipHash}`;
  }
  return {
    project: env.PROJECT_LEDGER.getByName(repoId) as DurableObjectStub<ProjectLedger>,
    account:
      accountName === null
        ? null
        : (env.PROJECT_LEDGER.getByName(accountName) as DurableObjectStub<ProjectLedger>),
    accountName,
  };
}
