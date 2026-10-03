/**
 * Retention (the 10-minute cron): rows that only ever grow and stop meaning anything a while after
 * they end. Both deletions are idempotent and bounded per run, so a backlog drains over a few runs.
 *
 * - `agent_tokens` that expired or were revoked more than `RETENTION_DAYS` ago. They can no longer
 *   authenticate (a deleted token is as unknown as an expired one), nothing references them, and the
 *   audit log keeps who minted and revoked them. Live tokens and tokens without an expiry stay.
 * - `webhook_deliveries` that finished (delivered, failed, cancelled) more than `RETENTION_DAYS`
 *   ago (their last attempt; `created_at` when there was none), signed payloads included. Pending deliveries are never touched: the sweep still owes them.
 */
import { and, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Bindings } from "./app-env.js";
import { agentTokens } from "./db/app-schema.js";
import { webhookDeliveries } from "./db/integration-schema.js";
import { createDb, type Db } from "./store/d1-store.js";

export const RETENTION_DAYS = 30;
/** Rows deleted per table per run (D1 caps statement cost; the next run continues). */
export const RETENTION_BATCH = 500;

export interface PurgeResult {
  agentTokens: number;
  webhookDeliveries: number;
}

export async function purgeExpired(
  db: Db,
  now: Date,
  opts: { days?: number; limit?: number } = {},
): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - (opts.days ?? RETENTION_DAYS) * 86_400_000).toISOString();
  const limit = opts.limit ?? RETENTION_BATCH;

  // DELETE … WHERE id IN (SELECT id … LIMIT n): one statement each, and no bound list of ids
  // (D1 allows at most 100 bound parameters per statement).
  const tokens = await db
    .delete(agentTokens)
    .where(
      inArray(
        agentTokens.id,
        db
          .select({ id: agentTokens.id })
          .from(agentTokens)
          .where(
            or(
              and(isNotNull(agentTokens.expiresAt), lt(agentTokens.expiresAt, cutoff)),
              and(isNotNull(agentTokens.revokedAt), lt(agentTokens.revokedAt, cutoff)),
            ),
          )
          .limit(limit),
      ),
    )
    .returning({ id: agentTokens.id });

  const deliveries = await db
    .delete(webhookDeliveries)
    .where(
      inArray(
        webhookDeliveries.id,
        db
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(
            and(
              inArray(webhookDeliveries.status, ["delivered", "failed", "cancelled"]),
              // Aged by when it finished (its last attempt), not when it was created: a delivery
              // retried for a while ends after it began.
              sql`coalesce(${webhookDeliveries.lastAttemptAt}, ${webhookDeliveries.createdAt}) < ${cutoff}`,
            ),
          )
          .limit(limit),
      ),
    )
    .returning({ id: webhookDeliveries.id });

  return { agentTokens: tokens.length, webhookDeliveries: deliveries.length };
}

export async function runRetention(env: Bindings): Promise<PurgeResult> {
  const purged = await purgeExpired(createDb(env.DB), new Date());
  if (purged.agentTokens + purged.webhookDeliveries > 0)
    console.log(JSON.stringify({ event: "retention-purge", ...purged }));
  return purged;
}
