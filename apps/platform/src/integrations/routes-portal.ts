/**
 * Developer portal routes (signed-in humans; developers see only their own integrations).
 */
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { IdempotencyHeaders } from "../api/schemas.js";
import { callerOf, requirePrincipal } from "../auth/middleware.js";
import { idempotent } from "../idempotency.js";
import { type ApiApp, body, errors, json, SECURITY } from "../routes/common.js";
import {
  DeliveryDetailSchema,
  DeliveryListQuery,
  DeliverySummarySchema,
  getDelivery,
  listDeliveries,
  ping,
  redeliver,
} from "./deliveries.js";
import { deleteIntegration } from "./installed.js";
import {
  createIntegration,
  createSecret,
  IntegrationInput,
  IntegrationPatch,
  IntegrationViewSchema,
  integrationView,
  listIntegrations,
  ownIntegration,
  revokeSecret,
  rotateWebhookSecret,
  SecretViewSchema,
  updateIntegration,
} from "./registry.js";

const TAG = ["integrations"];
const humanOnly = requirePrincipal([], { humanOnly: true });
const IdParam = z.object({ integrationId: z.string().min(1).max(64) });
const SecretParam = IdParam.extend({ secretId: z.string().min(1).max(64) });
const DeliveryParam = IdParam.extend({ deliveryId: z.string().min(1).max(64) });
const One = z.object({ integration: IntegrationViewSchema });

const list = createRoute({
  method: "get", path: "/api/v1/integrations", tags: TAG, security: SECURITY,
  summary: "Your registered integrations (developer portal)",
  middleware: [humanOnly] as const,
  responses: { 200: json(z.object({ integrations: z.array(IntegrationViewSchema) }), "Integrations"), ...errors(401, 403) },
});
const create = createRoute({
  method: "post", path: "/api/v1/integrations", tags: TAG, security: SECURITY,
  summary: "Register an integration: returns its client_id and (confidential clients) the client secret, once",
  description: "Redirect URIs match exactly. Permissions are a subset of repo:read contents:read webhooks deployments:write checks:write. Without webhook.secret a webhook secret is generated and returned once.",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, body: body(IntegrationInput) },
  responses: {
    201: json(z.object({ integration: IntegrationViewSchema, clientSecret: z.string().nullable(), webhookSecret: z.string().nullable() }), "Registered"),
    ...errors(400, 401, 403),
  },
});
const get = createRoute({
  method: "get", path: "/api/v1/integrations/{integrationId}", tags: TAG, security: SECURITY,
  summary: "One of your integrations", middleware: [humanOnly] as const,
  request: { params: IdParam }, responses: { 200: json(One, "Integration"), ...errors(401, 403, 404) },
});
const patch = createRoute({
  method: "patch", path: "/api/v1/integrations/{integrationId}", tags: TAG, security: SECURITY,
  summary: "Update an integration (name, URLs, redirect URIs, permissions, webhook)",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: IdParam, body: body(IntegrationPatch) },
  responses: { 200: json(One, "Updated"), ...errors(400, 401, 403, 404) },
});
const del = createRoute({
  method: "delete", path: "/api/v1/integrations/{integrationId}", tags: TAG, security: SECURITY,
  summary: "Delete an integration: uninstalled everywhere, its tokens stop working now",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: IdParam },
  responses: { 200: json(z.object({ deleted: z.literal(true), uninstalled: z.number().int() }), "Deleted"), ...errors(401, 403, 404) },
});
const newSecret = createRoute({
  method: "post", path: "/api/v1/integrations/{integrationId}/secrets", tags: TAG, security: SECURITY,
  summary: "Generate a new client secret (shown once; at most two active while you rotate)",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: IdParam },
  responses: {
    201: json(z.object({ clientSecret: z.string(), secret: SecretViewSchema, integration: IntegrationViewSchema }), "Created"),
    ...errors(401, 403, 404, 409),
  },
});
const delSecret = createRoute({
  method: "delete", path: "/api/v1/integrations/{integrationId}/secrets/{secretId}", tags: TAG, security: SECURITY,
  summary: "Revoke a client secret", middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: SecretParam },
  responses: { 200: json(One, "Revoked"), ...errors(401, 403, 404) },
});
const webhookSecret = createRoute({
  method: "post", path: "/api/v1/integrations/{integrationId}/webhook-secret", tags: TAG, security: SECURITY,
  summary: "Generate a new webhook secret (shown once; signatures use it from now on)",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: IdParam },
  responses: { 200: json(z.object({ webhookSecret: z.string(), integration: IntegrationViewSchema }), "Rotated"), ...errors(401, 403, 404) },
});
const pingRoute = createRoute({
  method: "post", path: "/api/v1/integrations/{integrationId}/ping", tags: TAG, security: SECURITY,
  summary: "Send a signed `ping` event to the webhook URL", middleware: [humanOnly] as const,
  request: { params: IdParam },
  responses: { 202: json(z.object({ delivery: DeliverySummarySchema }), "Queued"), ...errors(401, 403, 404, 409) },
});
const deliveries = createRoute({
  method: "get", path: "/api/v1/integrations/{integrationId}/deliveries", tags: TAG, security: SECURITY,
  summary: "Webhook delivery log (newest first)", middleware: [humanOnly] as const,
  request: { params: IdParam, query: DeliveryListQuery },
  responses: { 200: json(z.object({ deliveries: z.array(DeliverySummarySchema) }), "Deliveries"), ...errors(401, 403, 404) },
});
const delivery = createRoute({
  method: "get", path: "/api/v1/integrations/{integrationId}/deliveries/{deliveryId}", tags: TAG, security: SECURITY,
  summary: "One delivery: request headers (signature), payload, response", middleware: [humanOnly] as const,
  request: { params: DeliveryParam },
  responses: { 200: json(z.object({ delivery: DeliveryDetailSchema }), "Delivery"), ...errors(401, 403, 404) },
});
const redeliverRoute = createRoute({
  method: "post", path: "/api/v1/integrations/{integrationId}/deliveries/{deliveryId}/redeliver", tags: TAG, security: SECURITY,
  summary: "Send a delivery again (same X-Gittifacts-Delivery, fresh signature)",
  middleware: [humanOnly, idempotent()] as const,
  request: { headers: IdempotencyHeaders, params: DeliveryParam },
  responses: { 202: json(z.object({ delivery: DeliverySummarySchema }), "Queued"), ...errors(401, 403, 404, 409) },
});

export function registerPortalRoutes(app: ApiApp): void {
  app.openapi(list, async (c) => c.json({ integrations: await listIntegrations(c.get("services"), callerOf(c)) }, 200));
  app.openapi(create, async (c) => c.json(await createIntegration(c.get("services"), callerOf(c), c.req.valid("json")), 201));
  app.openapi(get, async (c) => {
    const svc = c.get("services");
    const row = await ownIntegration(svc, callerOf(c), c.req.valid("param").integrationId);
    return c.json({ integration: await integrationView(svc, row) }, 200);
  });
  app.openapi(patch, async (c) =>
    c.json({ integration: await updateIntegration(c.get("services"), callerOf(c), c.req.valid("param").integrationId, c.req.valid("json")) }, 200),
  );
  app.openapi(del, async (c) => c.json(await deleteIntegration(c.get("services"), callerOf(c), c.req.valid("param").integrationId), 200));
  app.openapi(newSecret, async (c) => c.json(await createSecret(c.get("services"), callerOf(c), c.req.valid("param").integrationId), 201));
  app.openapi(delSecret, async (c) => {
    const p = c.req.valid("param");
    return c.json({ integration: await revokeSecret(c.get("services"), callerOf(c), p.integrationId, p.secretId) }, 200);
  });
  app.openapi(webhookSecret, async (c) => c.json(await rotateWebhookSecret(c.get("services"), callerOf(c), c.req.valid("param").integrationId), 200));
  app.openapi(pingRoute, async (c) => c.json({ delivery: await ping(c.get("services"), callerOf(c), c.req.valid("param").integrationId) }, 202));
  app.openapi(deliveries, async (c) =>
    c.json({ deliveries: await listDeliveries(c.get("services"), callerOf(c), c.req.valid("param").integrationId, c.req.valid("query")) }, 200),
  );
  app.openapi(delivery, async (c) => {
    const p = c.req.valid("param");
    return c.json({ delivery: await getDelivery(c.get("services"), callerOf(c), p.integrationId, p.deliveryId) }, 200);
  });
  app.openapi(redeliverRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json({ delivery: await redeliver(c.get("services"), callerOf(c), p.integrationId, p.deliveryId) }, 202);
  });
}
