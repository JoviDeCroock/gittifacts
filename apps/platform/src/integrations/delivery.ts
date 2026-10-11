/**
 * Webhook delivery: the `WEBHOOK_QUEUE` consumer (at least once), retries with backoff, the
 * delivery log, redeliver, and the cron sweep that re-queues anything a lost send left pending.
 *
 * Each POST carries the exact stored body and
 *   Content-Type: application/json
 *   X-Gittifacts-Event: <event>            X-Gittifacts-Delivery: <guid> (same on redeliveries)
 *   X-Gittifacts-Signature-256: sha256=<hex HMAC-SHA-256(webhook secret, raw body)>
 *   X-Gittifacts-Installation-Id: <installation id> (absent for ping)
 * 2xx = delivered. Anything else (or 10 s without an answer) is retried after 10 s, 30 s, 2 min,
 * 10 min, 30 min, 1 h, 2 h; the 8th failure marks it failed. A delivery whose installation was
 * removed (or integration deleted, webhook switched off) is cancelled instead of sent.
 */
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { Services } from "../app-env.js";
import { installations, integrations, webhookDeliveries } from "../db/schema.js";
import { decryptSecret, masterSecretOf, signWebhook } from "./crypto.js";
import { sendAll, type WebhookMessage, type WebhookQueue } from "./events.js";
import { type WebhookUrlEnv, webhookUrlRefusal } from "./webhook-url.js";

export const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600, 7200] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const TIMEOUT_MS = 10_000;
const LEASE_MS = 60_000;
const RESPONSE_SNIPPET = 2048;
const SWEEP_GRACE_MS = 5 * 60_000;
export const USER_AGENT = "gittifacts-Hookshot/1";

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface DeliveryDeps {
  store: Pick<Services["store"], "db">;
  clock: Services["clock"];
  env: { BETTER_AUTH_SECRET?: string } & WebhookUrlEnv;
  queue: WebhookQueue | null;
  fetch: typeof fetch;
}

export type DeliveryOutcome =
  | { outcome: "delivered" | "failed" | "cancelled" | "skipped" }
  | { outcome: "retry"; delaySeconds: number };

export function headersFor(
  d: Pick<DeliveryRow, "event" | "guid" | "installationId">,
  signature: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-gittifacts-event": d.event,
    "x-gittifacts-delivery": d.guid,
    "x-gittifacts-signature-256": signature,
    ...(d.installationId ? { "x-gittifacts-installation-id": d.installationId } : {}),
  };
}

async function claim(deps: DeliveryDeps, id: string): Promise<DeliveryRow | null> {
  const now = deps.clock.now();
  const rows = await deps.store.db
    .update(webhookDeliveries)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() })
    .where(
      and(
        eq(webhookDeliveries.id, id),
        eq(webhookDeliveries.status, "pending"),
        or(
          isNull(webhookDeliveries.leaseUntil),
          lt(webhookDeliveries.leaseUntil, now.toISOString()),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

async function finish(deps: DeliveryDeps, id: string, set: Partial<DeliveryRow>): Promise<void> {
  await deps.store.db
    .update(webhookDeliveries)
    .set({ ...set, leaseUntil: null })
    .where(eq(webhookDeliveries.id, id));
}

/** Send one delivery now (if it is still due and nobody else holds it). */
export async function deliver(deps: DeliveryDeps, id: string): Promise<DeliveryOutcome> {
  const d = await claim(deps, id);
  if (d === null) return { outcome: "skipped" };
  const integration = await deps.store.db
    .select()
    .from(integrations)
    .where(eq(integrations.id, d.integrationId))
    .get();
  const cancel = async (why: string): Promise<DeliveryOutcome> => {
    await finish(deps, id, { status: "cancelled", nextAttemptAt: null, error: why });
    return { outcome: "cancelled" };
  };
  if (!integration || integration.deletedAt !== null) return cancel("integration deleted");
  if (!integration.webhookUrl || !integration.webhookActive || !integration.webhookSecretEnc) {
    return cancel("webhook disabled");
  }
  const refused = webhookUrlRefusal(integration.webhookUrl, deps.env);
  if (refused !== null) return cancel(`webhook url refused: ${refused}`);
  if (d.installationId !== null && d.event !== "installation.deleted") {
    const inst = await deps.store.db
      .select({ status: installations.status })
      .from(installations)
      .where(eq(installations.id, d.installationId))
      .get();
    if (inst?.status !== "active") return cancel("installation deleted");
  }
  const secret = await decryptSecret(masterSecretOf(deps.env), integration.webhookSecretEnc);
  const headers = headersFor(d, await signWebhook(secret, d.payload));
  const started = Date.now();
  const attempts = d.attempts + 1;
  const now = deps.clock.now();
  let status: number | null = null;
  let body: string | null = null;
  let error: string | null = null;
  try {
    const res = await deps.fetch(integration.webhookUrl, {
      method: "POST",
      headers,
      body: d.payload,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    body = (await res.text()).slice(0, RESPONSE_SNIPPET);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const common = {
    attempts,
    lastAttemptAt: now.toISOString(),
    url: integration.webhookUrl,
    responseStatus: status,
    responseBody: body,
    durationMs: Date.now() - started,
    error,
  };
  if (status !== null && status >= 200 && status < 300) {
    await finish(deps, id, { ...common, status: "delivered", nextAttemptAt: null, error: null });
    return { outcome: "delivered" };
  }
  if (attempts >= MAX_ATTEMPTS) {
    await finish(deps, id, {
      ...common,
      status: "failed",
      nextAttemptAt: null,
      error: error ?? `HTTP ${status}`,
    });
    return { outcome: "failed" };
  }
  const delaySeconds = BACKOFF_SECONDS[attempts - 1] ?? 3600;
  await finish(deps, id, {
    ...common,
    error: error ?? `HTTP ${status}`,
    nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
  });
  return { outcome: "retry", delaySeconds };
}

const Message = z.object({ deliveryId: z.string().min(1).max(64) });

/** The queue consumer (`queue()` of the Worker). */
export async function handleWebhookBatch(
  batch: MessageBatch<unknown>,
  deps: DeliveryDeps,
): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = Message.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack();
      continue;
    }
    try {
      const r = await deliver(deps, parsed.data.deliveryId);
      if (r.outcome === "retry") msg.retry({ delaySeconds: r.delaySeconds });
      else msg.ack();
    } catch (e) {
      console.error("webhook delivery crashed", parsed.data.deliveryId, e);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

/** Cron: re-queue (or, without a queue, send) deliveries that are due but not in flight. */
export async function sweepDeliveries(deps: DeliveryDeps, limit = 100): Promise<number> {
  // A grace period so messages still on their way through the queue are not doubled.
  const now = deps.clock.now();
  const overdue = new Date(now.getTime() - SWEEP_GRACE_MS).toISOString();
  const due = await deps.store.db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, overdue),
        or(
          isNull(webhookDeliveries.leaseUntil),
          lt(webhookDeliveries.leaseUntil, now.toISOString()),
        ),
      ),
    )
    .limit(limit)
    .all();
  if (deps.queue)
    await sendAll(
      deps.queue,
      due.map((d) => d.id),
    );
  else for (const d of due) await deliver(deps, d.id);
  return due.length;
}

export type { WebhookMessage };
