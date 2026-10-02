/**
 * The delivery log (developer portal): list, detail (headers as sent, payload, response),
 * redeliver (a new row, same `X-Gittifacts-Delivery`), and ping.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { repos, webhookDeliveries } from "../db/schema.js";
import { ApiError, notFound } from "../errors.js";
import { decryptSecret, masterSecretOf, signWebhook } from "./crypto.js";
import { headersFor } from "./delivery.js";
import { emitPing, sendAll } from "./events.js";
import { ownIntegration } from "./registry.js";
import { eventDepsFor, webhookQueueOf } from "./runtime.js";
import { WebhookEvent } from "./scopes.js";

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export const DeliveryStatus = z.enum(["pending", "delivered", "failed", "cancelled"]);

export const DeliverySummarySchema = z
  .object({
    id: z.string(),
    guid: z.string(),
    event: WebhookEvent,
    action: z.string().nullable(),
    repo: z.object({ id: z.string(), name: z.string() }).nullable(),
    installationId: z.string().nullable(),
    status: DeliveryStatus,
    attempts: z.number().int(),
    responseStatus: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.string(),
    lastAttemptAt: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    redeliveryOf: z.string().nullable(),
  })
  .meta({ id: "WebhookDelivery" });
export type DeliverySummary = z.infer<typeof DeliverySummarySchema>;

export const DeliveryDetailSchema = DeliverySummarySchema.extend({
  url: z.string(),
  requestHeaders: z.record(z.string(), z.string()),
  payload: z.string(),
  responseBody: z.string().nullable(),
  error: z.string().nullable(),
}).meta({ id: "WebhookDeliveryDetail" });
export type DeliveryDetail = z.infer<typeof DeliveryDetailSchema>;

export const DeliveryListQuery = z.object({
  status: DeliveryStatus.optional(),
  event: WebhookEvent.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function repoNamesById(svc: Services, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await svc.store.db
    .select({ id: repos.id, name: repos.name })
    .from(repos)
    .where(inArray(repos.id, ids))
    .all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

function summary(d: DeliveryRow, repoName: string | undefined): DeliverySummary {
  return {
    id: d.id,
    guid: d.guid,
    event: WebhookEvent.catch("ping").parse(d.event),
    action: d.action,
    repo: d.repoId ? { id: d.repoId, name: repoName ?? d.repoId } : null,
    installationId: d.installationId,
    status: d.status,
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    durationMs: d.durationMs,
    createdAt: d.createdAt,
    lastAttemptAt: d.lastAttemptAt,
    nextAttemptAt: d.nextAttemptAt,
    redeliveryOf: d.redeliveryOf,
  };
}

export async function listDeliveries(
  svc: Services,
  caller: Caller,
  integrationId: string,
  q: z.infer<typeof DeliveryListQuery>,
): Promise<DeliverySummary[]> {
  await ownIntegration(svc, caller, integrationId);
  const conds = [eq(webhookDeliveries.integrationId, integrationId)];
  if (q.status) conds.push(eq(webhookDeliveries.status, q.status));
  if (q.event) conds.push(eq(webhookDeliveries.event, q.event));
  const rows = await svc.store.db
    .select()
    .from(webhookDeliveries)
    .where(and(...conds))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(q.limit)
    .all();
  const names = await repoNamesById(svc, [
    ...new Set(rows.flatMap((r) => (r.repoId ? [r.repoId] : []))),
  ]);
  return rows.map((r) => summary(r, r.repoId ? names.get(r.repoId) : undefined));
}

async function ownDelivery(
  svc: Services,
  caller: Caller,
  integrationId: string,
  id: string,
): Promise<DeliveryRow> {
  await ownIntegration(svc, caller, integrationId);
  const d = await svc.store.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id))
    .get();
  if (!d || d.integrationId !== integrationId) throw notFound(`delivery ${id}`);
  return d;
}

export async function getDelivery(
  svc: Services,
  caller: Caller,
  integrationId: string,
  id: string,
): Promise<DeliveryDetail> {
  const d = await ownDelivery(svc, caller, integrationId, id);
  const integration = await ownIntegration(svc, caller, integrationId);
  let signature = "(no webhook secret)";
  if (integration.webhookSecretEnc) {
    signature = await signWebhook(
      await decryptSecret(masterSecretOf(svc.env), integration.webhookSecretEnc),
      d.payload,
    );
  }
  const names = await repoNamesById(svc, d.repoId ? [d.repoId] : []);
  return {
    ...summary(d, d.repoId ? names.get(d.repoId) : undefined),
    url: d.url ?? integration.webhookUrl ?? "",
    requestHeaders: headersFor(d, signature),
    payload: d.payload,
    responseBody: d.responseBody,
    error: d.error,
  };
}

export async function redeliver(
  svc: Services,
  caller: Caller,
  integrationId: string,
  id: string,
): Promise<DeliverySummary> {
  const d = await ownDelivery(svc, caller, integrationId, id);
  if (d.status === "pending") {
    throw new ApiError(409, "invalid-state", "this delivery is still being retried", undefined, {
      explanation: "Wait for it to be delivered or fail, then redeliver it.",
    });
  }
  const now = svc.clock.now().toISOString();
  const row: DeliveryRow = {
    ...d,
    id: crypto.randomUUID(),
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    lastAttemptAt: null,
    leaseUntil: null,
    responseStatus: null,
    responseBody: null,
    durationMs: null,
    error: null,
    redeliveryOf: d.redeliveryOf ?? d.id,
    createdAt: now,
  };
  await svc.store.db.insert(webhookDeliveries).values(row);
  await sendAll(webhookQueueOf(svc.env), [row.id]);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.webhook-redelivered",
    subject: `integration:${integrationId}`,
    payload: { summary: `Redelivered ${d.event} ${d.guid}`, deliveryId: row.id, of: d.id },
  });
  const names = await repoNamesById(svc, d.repoId ? [d.repoId] : []);
  return summary(row, d.repoId ? names.get(d.repoId) : undefined);
}

export async function ping(
  svc: Services,
  caller: Caller,
  integrationId: string,
): Promise<DeliverySummary> {
  const integration = await ownIntegration(svc, caller, integrationId);
  if (!integration.webhookUrl) {
    throw new ApiError(409, "invalid-state", "this integration has no webhook URL", undefined, {
      explanation: "Set webhook.url (PATCH /api/v1/integrations/{id}) first.",
    });
  }
  const id = await emitPing(eventDepsFor(svc), integrationId);
  if (id === null) throw new ApiError(409, "invalid-state", "could not queue the ping");
  const d = await svc.store.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id))
    .get();
  if (!d) throw new Error(`delivery ${id} vanished`);
  return summary(d, undefined);
}
