/**
 * The spend breaker: the platform's metered spend today (./meter.ts) against two daily budgets.
 *
 *   soft (SPEND_SOFT_USD_PER_DAY, default $5): a `spend.soft` log line and a
 *     `platform.spend-soft` audit event, once per UTC day. Nothing stops.
 *   hard (SPEND_HARD_USD_PER_DAY, default $20): the same at `hard`, and new paid work is refused
 *     until the next UTC day: CI runs (but not the merge queue's, so approved Changes still
 *     land), workspaces, preview boots, QA runs, model calls (which then route to a human) and
 *     unclaimed project creation. Running work is not killed.
 *
 * A platform admin can resume for the rest of the day (`PUT /api/v1/admin/spend-breaker`); the
 * override is stored in D1 `platform_settings` and expires with the day.
 *
 * Cloudflare's own budget alerts (Billing → Billable Usage) are the backstop: they arrive by
 * e-mail the day after and never pause anything (docs/deploy.md).
 *
 * Reading the breaker fails open (logged): a transient Durable Object or D1 error must not stop
 * the platform, and the cron re-checks every 10 minutes.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { DoAudit } from "../audit/audit.js";
import { platformSettings } from "../db/schema.js";
import { type DaySpend, type SpendEnv, spendOn } from "./meter.js";

export const BREAKER_SETTING = "spend-breaker";
const ALERTED_SETTING = "spend-alerted";

export interface BreakerEnv extends SpendEnv {
  DB: D1Database;
  SPEND_SOFT_USD_PER_DAY?: string;
  SPEND_HARD_USD_PER_DAY?: string;
}

export type SpendLevel = "ok" | "soft" | "hard";

export interface BreakerState {
  day: string;
  spend: DaySpend;
  softUsd: number;
  hardUsd: number;
  level: SpendLevel;
  /** Over the hard budget and not resumed: new paid work is refused. */
  paused: boolean;
  /** Who resumed the platform for today, if anyone did. */
  resumedBy: string | null;
}

const usd = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function budgets(
  env: Pick<BreakerEnv, "SPEND_SOFT_USD_PER_DAY" | "SPEND_HARD_USD_PER_DAY">,
) {
  const softUsd = usd(env.SPEND_SOFT_USD_PER_DAY, 5);
  return { softUsd, hardUsd: Math.max(softUsd, usd(env.SPEND_HARD_USD_PER_DAY, 20)) };
}

const dayOf = (atMs: number) => new Date(atMs).toISOString().slice(0, 10);

async function setting(env: Pick<BreakerEnv, "DB">, key: string) {
  return drizzle(env.DB).select().from(platformSettings).where(eq(platformSettings.key, key)).get();
}

async function putSetting(env: Pick<BreakerEnv, "DB">, key: string, value: string, by: string) {
  const updatedAt = new Date().toISOString();
  await drizzle(env.DB)
    .insert(platformSettings)
    .values({ key, value, updatedAt, updatedBy: by })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt, updatedBy: by } });
}

export async function breakerState(env: BreakerEnv, atMs: number): Promise<BreakerState> {
  const day = dayOf(atMs);
  const spend = await spendOn(env, atMs);
  const { softUsd, hardUsd } = budgets(env);
  const level: SpendLevel =
    spend.totalUsd >= hardUsd ? "hard" : spend.totalUsd >= softUsd ? "soft" : "ok";
  const override = await setting(env, BREAKER_SETTING);
  const resumedBy = override?.value === `resume:${day}` ? override.updatedBy : null;
  return {
    day,
    spend,
    softUsd,
    hardUsd,
    level,
    paused: level === "hard" && resumedBy === null,
    resumedBy,
  };
}

/** Why new paid work is refused right now, or null. Fails open. */
export async function spendPaused(env: BreakerEnv, atMs = Date.now()): Promise<string | null> {
  try {
    const s = await breakerState(env, atMs);
    if (!s.paused) return null;
    return `the platform paused new paid work: today's spend ($${s.spend.totalUsd.toFixed(2)}) passed its daily budget ($${s.hardUsd.toFixed(2)}); it resumes at 00:00 UTC or when a platform admin resumes it`;
  } catch (e) {
    console.error(JSON.stringify({ event: "spend.breaker-unreadable", error: String(e) }));
    return null;
  }
}

/** Resume for the rest of the UTC day (`true`), or hand control back to the budgets. */
export async function setResume(env: BreakerEnv, resume: boolean, by: string, atMs: number) {
  await putSetting(env, BREAKER_SETTING, resume ? `resume:${dayOf(atMs)}` : "auto", by);
}

/**
 * Cron (every 10 minutes): log the day's spend, and on the first crossing of each budget per day
 * log `spend.soft` / `spend.hard` (warn / error) and append the audit event. Never throws.
 */
export async function runSpendWatch(
  env: BreakerEnv & Pick<Env, "AUDIT_LOG">,
  now = new Date(),
): Promise<BreakerState | null> {
  try {
    const s = await breakerState(env, now.getTime());
    const line = { day: s.day, totalUsd: round(s.spend.totalUsd), bySource: s.spend.bySource };
    console.log(JSON.stringify({ event: "spend.day", ...line, level: s.level }));
    if (s.level === "ok") return s;
    const alerted = await setting(env, ALERTED_SETTING);
    const already = alerted?.value === `${s.day}:hard` || alerted?.value === `${s.day}:${s.level}`;
    if (already) return s;
    const budgetUsd = s.level === "hard" ? s.hardUsd : s.softUsd;
    const event = { event: `spend.${s.level}`, ...line, budgetUsd, paused: s.paused };
    if (s.level === "hard") console.error(JSON.stringify(event));
    else console.warn(JSON.stringify(event));
    await new DoAudit(env).append({
      principalId: "system",
      action: `platform.spend-${s.level}`,
      subject: "platform:spend",
      payload: { ...line, budgetUsd, paused: s.paused },
    });
    await putSetting(env, ALERTED_SETTING, `${s.day}:${s.level}`, "system");
    return s;
  } catch (e) {
    console.error(JSON.stringify({ event: "spend.watch-failed", error: String(e) }));
    return null;
  }
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
