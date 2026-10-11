/**
 * The platform's `ChangeCoordinator` Durable Object: the coordinator's class plus one hook. The
 * CI engine reports every finished run here (`onRunFinished`, the run sink); before the summary
 * goes on to the ChangeWorkflow, an unclaimed project's CI-minute reservation is settled to what
 * the run actually used and the bytes it stored (logs, build artifacts) are added to its storage
 * quota (src/limits/quotas.ts). Runs that were never metered (claimed projects) are untouched.
 */
import { ChangeCoordinator as CoordinatorChangeCoordinator } from "@app/coordinator/workers";
import { z } from "zod";
import { recordSpend } from "../spend/meter.js";
import { D1Store } from "../store/d1-store.js";
import { AI_USD_MICROS, addPlanUsage, aiRemainingToday, type PlanGateEnv } from "./plan-gate.js";
import { planLedgers } from "./plans.js";
import { GLOBAL_LEDGER, ledgersFor, type QuotaEnv } from "./quotas.js";

const Usage = z.object({
  id: z.string().min(1),
  changeId: z.string().min(1),
  usage: z
    .object({
      ciMinutes: z.number().nonnegative().catch(0),
      logBytes: z.number().nonnegative().catch(0),
      artifactBytes: z.number().nonnegative().catch(0),
    })
    .partial()
    .optional(),
});

type SettleEnv = QuotaEnv & { DB: D1Database; BLOBS: R2Bucket };

/** Settle a finished run against the ledgers of its (unclaimed) project. Never throws. */
export async function settleRunUsage(env: SettleEnv, summary: unknown, atMs = Date.now()) {
  const parsed = Usage.safeParse(summary);
  if (!parsed.success) return;
  const { id, changeId, usage } = parsed.data;
  try {
    const store = new D1Store(env.DB, env.BLOBS);
    const change = await store.getChange(changeId);
    if (change === null) return;
    const { project, ip } = await ledgersFor(env, store, change.repoId);
    const actualMinutes = usage?.ciMinutes ?? 0;
    // Only runs that were reserved are settled, at the container-minutes they used (a run's
    // parallel steps can use more than its grant; the next run is refused once the day is over).
    const settle = { runId: id, actualMinutes, capped: false };
    const metered = await project.settleCi(settle);
    if (!metered) return;
    // The account: the owner's (claimed) or the creating IP's (unclaimed) aggregate.
    const { account } = await planLedgers(env, change.repoId);
    if (account !== null) await account.settleCi(settle);
    if (ip !== null && ip.id.toString() !== account?.id.toString()) await ip.settleCi(settle);
    await env.PROJECT_LEDGER.getByName(GLOBAL_LEDGER).settleCi(settle);
    const bytes = (usage?.logBytes ?? 0) + (usage?.artifactBytes ?? 0);
    if (bytes > 0) {
      await project.add({ metric: "storage-bytes", amount: bytes, period: "total", atMs });
      if (ip !== null)
        await ip.add({ metric: "storage-bytes", amount: bytes, period: "total", atMs });
    }
  } catch (e) {
    console.error("could not settle CI usage for run", id, e);
  }
}

export class ChangeCoordinator extends CoordinatorChangeCoordinator {
  override async onRunFinished(summary: unknown) {
    await settleRunUsage(this.env as SettleEnv, summary);
    return super.onRunFinished(summary);
  }

  /**
   * Every model call's cost (judge, tour, resolver, QA) passes here: also the platform's spend and
   * the plan's AI usage today (project and account).
   */
  override async recordSpend(input: { changeId: string; usd: number }): Promise<number> {
    const total = await super.recordSpend(input);
    const env = this.env as SettleEnv & PlanGateEnv;
    const change = await new D1Store(env.DB, env.BLOBS).getChange(input.changeId).catch(() => null);
    await recordSpend(env, {
      source: "llm",
      usd: input.usd,
      repoId: change?.repoId ?? null,
      ref: `change ${input.changeId}`,
    });
    if (change !== null && input.usd > 0) {
      await addPlanUsage(env, change.repoId, AI_USD_MICROS, Math.round(input.usd * 1e6)).catch(
        (e: unknown) => console.warn("could not record AI usage", e),
      );
    }
    return total;
  }

  /**
   * What the Change has spent, as its AI budget sees it: also everything today's plan budget
   * (project and account) and the spend breaker no longer cover. Callers compute what's left as
   * `budgetUsdPerChange − spent`, so a spent day makes model calls stop and the Change go to a
   * human, exactly like an exhausted per-Change budget (only ever a higher lane).
   */
  override async spent(changeId: string): Promise<number> {
    const own = await super.spent(changeId);
    const env = this.env as SettleEnv & PlanGateEnv;
    try {
      const store = new D1Store(env.DB, env.BLOBS);
      const change = await store.getChange(changeId);
      const repo = change === null ? null : await store.getRepo(change.repoId);
      if (repo === null) return own;
      const limit = repo.policy.ai.budgetUsdPerChange;
      const left = await aiRemainingToday(env, repo.id);
      return Math.max(own, limit - left);
    } catch (e) {
      console.warn("could not read today's AI budget", e);
      return own;
    }
  }
}
