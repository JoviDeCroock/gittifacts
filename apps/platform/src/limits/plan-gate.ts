/**
 * The checks paid work passes before it starts (CI runs: ./ci-quota.ts; workspaces, previews, QA,
 * model calls): the spend breaker (src/spend/breaker.ts) and the project's plan (./plans.ts),
 * per project and per account. Refusals are `quota-exceeded` (429) naming the quota, its scope
 * and when it resets, for agents and humans alike.
 */
import { ApiError } from "../errors.js";
import { type BreakerEnv, spendPaused } from "../spend/breaker.js";
import { type LedgerNs, type PlanEnv, type PlanLimits, planLedgers, planLimits } from "./plans.js";
import { nextUtcMidnight } from "./quotas.js";

export interface PlanGateEnv extends BreakerEnv, PlanEnv {
  DB: D1Database;
  PROJECT_LEDGER: BreakerEnv["PROJECT_LEDGER"] & LedgerNs;
}

export type PlanScope = "project" | "account" | "platform";

export function planQuotaError(
  repoId: string,
  quota: string,
  scope: PlanScope,
  used: number,
  limit: number,
  atMs: number,
  detail?: string,
): ApiError {
  const resetsAt = nextUtcMidnight(atMs);
  const who =
    scope === "platform"
      ? "the platform"
      : scope === "account"
        ? `the account that owns project ${repoId}`
        : `project ${repoId}`;
  const status = `the ${quota} quota (${round(used)}/${limit})`;
  return new ApiError(
    429,
    "quota-exceeded",
    detail ?? `${who} used up today's free-plan ${quota} quota (${round(used)}/${limit})`,
    { quota, scope, used: round(used), limit, resetsAt, plan: "free" },
    scope === "platform"
      ? {
          explanation: `${detail ?? "New paid work is paused platform-wide"}. Nothing you did caused it and nothing you can do lifts it; try again after ${resetsAt}.`,
        }
      : {
          explanation: `You hit ${status} of the free plan${scope === "account" ? " across every project of this account" : ""}; it resets at ${resetsAt}. whoami shows your quotas. Paid plans will raise them.`,
          call: "whoami({})",
        },
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Throws when the spend breaker has paused new paid work. */
export async function assertSpendAllows(
  env: BreakerEnv,
  repoId: string,
  what: string,
  atMs = Date.now(),
): Promise<void> {
  const reason = await spendPaused(env, atMs);
  if (reason !== null) throw planQuotaError(repoId, what, "platform", 0, 0, atMs, reason);
}

/** Day counters of a project and its account (missing account: zeros). */
async function dayCounters(env: PlanGateEnv, repoId: string, metric: string, atMs: number) {
  const ledgers = await planLedgers(env, repoId);
  const read = async (l: typeof ledgers.project | null) =>
    l === null
      ? 0
      : ((await l.counters({ metrics: [{ metric, period: "day" }], atMs }))[metric] ?? 0);
  return { ledgers, project: await read(ledgers.project), account: await read(ledgers.account) };
}

/** Add to a project's and its account's day counter (never refuses). */
export async function addPlanUsage(
  env: PlanGateEnv,
  repoId: string,
  metric: string,
  amount: number,
  atMs = Date.now(),
): Promise<void> {
  if (!(amount > 0)) return;
  const ledgers = await planLedgers(env, repoId);
  for (const l of [ledgers.project, ledgers.account]) {
    if (l !== null) await l.add({ metric, amount, period: "day", atMs });
  }
}

/** Over a plan's daily cap (project, then account)? Throws `quota-exceeded`. */
export async function assertUnderDaily(
  env: PlanGateEnv,
  repoId: string,
  input: { metric: string; quota: string; perDay: number; unit?: number },
  atMs = Date.now(),
): Promise<void> {
  const l = planLimits(env);
  const unit = input.unit ?? 1;
  const c = await dayCounters(env, repoId, input.metric, atMs);
  const project = c.project / unit;
  if (project >= input.perDay)
    throw planQuotaError(repoId, input.quota, "project", project, input.perDay, atMs);
  const account = c.account / unit;
  const accountCap = input.perDay * l.accountMultiplier;
  if (c.ledgers.account !== null && account >= accountCap)
    throw planQuotaError(repoId, input.quota, "account", account, accountCap, atMs);
}

/**
 * Charge one unit to the account's day counter, refused past `perDay` × the account multiplier
 * (the project's own cap is the caller's). No account: nothing to charge.
 */
export async function chargeAccountDaily(
  env: PlanGateEnv,
  repoId: string,
  input: { metric: string; quota: string; perDay: number },
  atMs = Date.now(),
): Promise<void> {
  const { account } = await planLedgers(env, repoId);
  if (account === null) return;
  const limit = input.perDay * planLimits(env).accountMultiplier;
  const r = await account.charge({ metric: input.metric, amount: 1, limit, period: "day", atMs });
  if (!r.ok) throw planQuotaError(repoId, input.quota, "account", r.used, limit, atMs);
}

export const PREVIEW_MS = "preview-ms";
export const AI_USD_MICROS = "ai-usd-micros";
export const WORKSPACE_CPU_SECONDS = "workspace-cpu-seconds";
export const QA_RUNS = "qa-runs";

/** Why a preview may not boot now (the breaker, or the plan's preview minutes), or null. */
export async function previewRefusal(
  env: PlanGateEnv,
  repoId: string,
  atMs = Date.now(),
): Promise<string | null> {
  try {
    await assertSpendAllows(env, repoId, "preview", atMs);
    const p = planLimits(env).previews;
    await assertUnderDaily(
      env,
      repoId,
      { metric: PREVIEW_MS, quota: "preview-minutes", perDay: p.minutesPerDay, unit: 60_000 },
      atMs,
    );
    return null;
  } catch (e) {
    if (e instanceof ApiError) return `${e.message}. ${e.fix.explanation}`;
    throw e;
  }
}

/** What's left of today's AI budget for a project (USD), over the project and its account. */
export async function aiRemainingToday(
  env: PlanGateEnv,
  repoId: string,
  atMs = Date.now(),
): Promise<number> {
  if ((await spendPaused(env, atMs)) !== null) return 0;
  const l: PlanLimits = planLimits(env);
  const c = await dayCounters(env, repoId, AI_USD_MICROS, atMs);
  const project = l.ai.usdPerDay - c.project / 1e6;
  const account =
    c.ledgers.account === null
      ? Number.POSITIVE_INFINITY
      : l.ai.usdPerDay * l.accountMultiplier - c.account / 1e6;
  return Math.max(0, Math.min(project, account));
}
