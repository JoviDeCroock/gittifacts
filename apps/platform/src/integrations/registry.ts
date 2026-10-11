/**
 * The developer portal: humans register integrations (OAuth apps for deploy platforms), get a
 * `client_id` and (confidential clients) a client secret shown once and stored hashed, rotate
 * secrets, and configure the webhook. Every change is audit-logged under `integration:<id>`.
 */
import { IntegrationScope } from "@app/domain";
import { sha256Hex } from "@app/evidence";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Caller, Services } from "../app-env.js";
import { installations, integrationSecrets, integrations, principals } from "../db/schema.js";
import { ApiError, forbidden, notFound } from "../errors.js";
import { isValidRedirectUri } from "../oauth/clients.js";
import {
  CLIENT_SECRET_PREFIX,
  encryptSecret,
  masterSecretOf,
  newClientId,
  randomSecret,
  WEBHOOK_SECRET_PREFIX,
} from "./crypto.js";
import {
  DEFAULT_EVENTS,
  explainScopes,
  integrationScopesOf,
  ScopeExplainedSchema,
  WebhookEvent,
} from "./scopes.js";
import { webhookUrlRefusal } from "./webhook-url.js";

export type IntegrationRow = typeof integrations.$inferSelect;
type SecretRow = typeof integrationSecrets.$inferSelect;

/** Secrets that may be active at once (rotate without downtime, then revoke the old one). */
export const MAX_ACTIVE_SECRETS = 2;

const HttpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith("https://"), "must be an https:// URL");
const RedirectUri = z
  .string()
  .min(1)
  .max(2048)
  .refine(isValidRedirectUri, "must be https, http on a loopback host, or a private-use scheme");

const WebhookInput = z.object({
  url: HttpsUrl.nullable(),
  events: z
    .array(WebhookEvent)
    .max(WebhookEvent.options.length)
    .default([...DEFAULT_EVENTS]),
  active: z.boolean().optional(),
  /** Your own secret (16-200 chars); omitted: one is generated and shown once. */
  secret: z.string().min(16).max(200).optional(),
});

export const IntegrationInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    logoUrl: HttpsUrl.nullable().optional(),
    homepageUrl: HttpsUrl,
    redirectUris: z.array(RedirectUri).min(1).max(10),
    clientType: z.enum(["confidential", "public"]).default("confidential"),
    scopes: z.array(IntegrationScope).min(1).max(IntegrationScope.options.length),
    webhook: WebhookInput.optional(),
  })
  .meta({ id: "IntegrationInput" });
export type IntegrationInput = z.infer<typeof IntegrationInput>;

/** PATCH: absent fields stay as they are (no defaults applied). */
export const IntegrationPatch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    logoUrl: HttpsUrl.nullable().optional(),
    homepageUrl: HttpsUrl.optional(),
    redirectUris: z.array(RedirectUri).min(1).max(10).optional(),
    scopes: z.array(IntegrationScope).min(1).max(IntegrationScope.options.length).optional(),
    webhook: z
      .object({
        url: HttpsUrl.nullable().optional(),
        events: z.array(WebhookEvent).max(WebhookEvent.options.length).optional(),
        active: z.boolean().optional(),
        secret: z.string().min(16).max(200).optional(),
      })
      .optional(),
  })
  .meta({ id: "IntegrationPatch" });
export type IntegrationPatch = z.infer<typeof IntegrationPatch>;

export const SecretViewSchema = z
  .object({
    id: z.string(),
    prefix: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .meta({ id: "IntegrationSecret" });

export const IntegrationViewSchema = z
  .object({
    id: z.string(),
    clientId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    logoUrl: z.string().nullable(),
    homepageUrl: z.string(),
    redirectUris: z.array(z.string()),
    clientType: z.enum(["confidential", "public"]),
    scopes: z.array(IntegrationScope),
    /** The same permissions in the install screen's plain words. */
    scopesExplained: z.array(ScopeExplainedSchema),
    /** How the install screen names the developer. */
    developer: z.object({ name: z.string() }),
    webhook: z.object({
      url: z.string().nullable(),
      active: z.boolean(),
      events: z.array(WebhookEvent),
      secretSet: z.boolean(),
    }),
    secrets: z.array(SecretViewSchema),
    installationCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Integration" });
export type IntegrationView = z.infer<typeof IntegrationViewSchema>;

export function eventsOf(raw: unknown): WebhookEvent[] {
  return z
    .array(z.string())
    .catch([])
    .parse(raw)
    .filter((e): e is WebhookEvent => WebhookEvent.safeParse(e).success);
}

function humanOnly(caller: Caller): void {
  if (caller.principal.kind !== "human") {
    throw forbidden("only a signed-in human can manage integrations", {
      kind: caller.principal.kind,
    });
  }
}

async function secretsOf(svc: Services, integrationId: string): Promise<SecretRow[]> {
  return svc.store.db
    .select()
    .from(integrationSecrets)
    .where(
      and(
        eq(integrationSecrets.integrationId, integrationId),
        isNull(integrationSecrets.revokedAt),
      ),
    )
    .orderBy(desc(integrationSecrets.createdAt))
    .all();
}

export async function integrationView(
  svc: Services,
  row: IntegrationRow,
): Promise<IntegrationView> {
  const [secrets, installs, developer] = await Promise.all([
    secretsOf(svc, row.id),
    svc.store.db
      .select({ n: count() })
      .from(installations)
      .where(and(eq(installations.integrationId, row.id), eq(installations.status, "active")))
      .get(),
    svc.store.db
      .select({ name: principals.name })
      .from(principals)
      .where(eq(principals.id, row.ownerId))
      .get(),
  ]);
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    description: row.description,
    logoUrl: row.logoUrl,
    homepageUrl: row.homepageUrl,
    redirectUris: [...row.redirectUris],
    clientType: row.clientType,
    scopes: integrationScopesOf(row.scopes),
    scopesExplained: explainScopes(integrationScopesOf(row.scopes)),
    developer: { name: developer?.name ?? "unknown developer" },
    webhook: {
      url: row.webhookUrl,
      active: row.webhookActive,
      events: eventsOf(row.webhookEvents),
      secretSet: row.webhookSecretEnc !== null,
    },
    secrets: secrets.map((s) => ({
      id: s.id,
      prefix: s.prefix,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    })),
    installationCount: Number(installs?.n ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A live integration by id (any owner), or null. */
export async function getIntegration(svc: Services, id: string): Promise<IntegrationRow | null> {
  const row = await svc.store.db.select().from(integrations).where(eq(integrations.id, id)).get();
  return row && row.deletedAt === null ? row : null;
}

export async function getIntegrationByClientId(
  svc: Services,
  clientId: string,
): Promise<IntegrationRow | null> {
  const row = await svc.store.db
    .select()
    .from(integrations)
    .where(eq(integrations.clientId, clientId))
    .get();
  return row && row.deletedAt === null ? row : null;
}

/** The caller's own integration (developers see only theirs). */
export async function ownIntegration(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<IntegrationRow> {
  humanOnly(caller);
  const row = await getIntegration(svc, id);
  if (!row || row.ownerId !== caller.principal.id) {
    throw notFound(`integration ${id}`, {
      explanation: "List yours with GET /api/v1/integrations and use one of those ids.",
    });
  }
  return row;
}

async function addSecret(
  svc: Services,
  integrationId: string,
): Promise<{ plaintext: string; row: SecretRow }> {
  const plaintext = randomSecret(CLIENT_SECRET_PREFIX);
  const row: SecretRow = {
    id: `isec_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    integrationId,
    secretHash: await sha256Hex(plaintext),
    prefix: plaintext.slice(0, 12),
    createdAt: svc.clock.now().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await svc.store.db.insert(integrationSecrets).values(row);
  return { plaintext, row };
}

async function sealWebhookSecret(svc: Services, secret: string): Promise<string> {
  return encryptSecret(masterSecretOf(svc.env), secret);
}

export async function listIntegrations(svc: Services, caller: Caller): Promise<IntegrationView[]> {
  humanOnly(caller);
  const rows = await svc.store.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.ownerId, caller.principal.id), isNull(integrations.deletedAt)))
    .orderBy(desc(integrations.createdAt))
    .all();
  return Promise.all(rows.map((r) => integrationView(svc, r)));
}

export interface CreatedIntegration {
  integration: IntegrationView;
  clientSecret: string | null;
  webhookSecret: string | null;
}

/** 400 when the webhook URL points somewhere the platform must not POST to (./webhook-url.ts). */
function assertWebhookUrl(svc: Services, url: string | null | undefined): void {
  if (!url) return;
  const why = webhookUrlRefusal(url, svc.env);
  if (why === null) return;
  throw new ApiError(
    400,
    "invalid-request",
    `webhook.url ${why}`,
    { field: "webhook.url" },
    {
      explanation:
        "Webhooks go to a public https:// DNS name you control: not an IP address, localhost, an internal name, this platform or its previews.",
    },
  );
}

export async function createIntegration(
  svc: Services,
  caller: Caller,
  input: IntegrationInput,
): Promise<CreatedIntegration> {
  humanOnly(caller);
  const now = svc.clock.now().toISOString();
  const id = `itg_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const webhookUrl = input.webhook?.url ?? null;
  assertWebhookUrl(svc, webhookUrl);
  let webhookSecret: string | null = null;
  if (webhookUrl !== null)
    webhookSecret = input.webhook?.secret ?? randomSecret(WEBHOOK_SECRET_PREFIX);
  const row: IntegrationRow = {
    id,
    clientId: newClientId(),
    ownerId: caller.principal.id,
    name: input.name,
    description: input.description ?? null,
    logoUrl: input.logoUrl ?? null,
    homepageUrl: input.homepageUrl,
    redirectUris: [...new Set(input.redirectUris)],
    clientType: input.clientType,
    scopes: [...new Set(input.scopes)],
    webhookUrl,
    webhookSecretEnc: webhookSecret === null ? null : await sealWebhookSecret(svc, webhookSecret),
    webhookActive: input.webhook?.active ?? true,
    webhookEvents: [...new Set(input.webhook?.events ?? DEFAULT_EVENTS)],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await svc.store.db.insert(integrations).values(row);
  const secret = row.clientType === "confidential" ? await addSecret(svc, id) : null;
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.registered",
    subject: `integration:${id}`,
    payload: {
      summary: `Registered integration ${row.name}`,
      clientId: row.clientId,
      clientType: row.clientType,
      scopes: row.scopes,
      redirectUris: row.redirectUris,
      webhookUrl,
    },
  });
  return {
    integration: await integrationView(svc, row),
    clientSecret: secret?.plaintext ?? null,
    // Only a generated secret is echoed back; one the developer chose, they already know.
    webhookSecret:
      webhookSecret !== null && input.webhook?.secret === undefined ? webhookSecret : null,
  };
}

export async function updateIntegration(
  svc: Services,
  caller: Caller,
  id: string,
  patch: IntegrationPatch,
): Promise<IntegrationView> {
  const row = await ownIntegration(svc, caller, id);
  const now = svc.clock.now().toISOString();
  const next: Partial<IntegrationRow> = { updatedAt: now };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.logoUrl !== undefined) next.logoUrl = patch.logoUrl;
  if (patch.homepageUrl !== undefined) next.homepageUrl = patch.homepageUrl;
  if (patch.redirectUris !== undefined) next.redirectUris = [...new Set(patch.redirectUris)];
  if (patch.scopes !== undefined) next.scopes = [...new Set(patch.scopes)];
  const wh = patch.webhook;
  if (wh !== undefined) {
    assertWebhookUrl(svc, wh.url);
    if (wh.url !== undefined) next.webhookUrl = wh.url;
    if (wh.events !== undefined) next.webhookEvents = [...new Set(wh.events)];
    if (wh.active !== undefined) next.webhookActive = wh.active;
    if (wh.secret !== undefined) next.webhookSecretEnc = await sealWebhookSecret(svc, wh.secret);
    else if (wh.url && row.webhookSecretEnc === null) {
      throw new ApiError(400, "invalid-request", "a webhook URL needs a secret", undefined, {
        explanation:
          "Send webhook.secret (16-200 chars) with the URL, or call POST /api/v1/integrations/{id}/webhook-secret to generate one.",
      });
    }
  }
  await svc.store.db.update(integrations).set(next).where(eq(integrations.id, id));
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.updated",
    subject: `integration:${id}`,
    payload: {
      summary: `Updated integration ${next.name ?? row.name}`,
      fields: Object.keys(patch),
      webhookSecretChanged: wh?.secret !== undefined,
    },
  });
  const after = await ownIntegration(svc, caller, id);
  return integrationView(svc, after);
}

export async function createSecret(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<{
  clientSecret: string;
  secret: z.infer<typeof SecretViewSchema>;
  integration: IntegrationView;
}> {
  const row = await ownIntegration(svc, caller, id);
  if (row.clientType !== "confidential") {
    throw new ApiError(409, "invalid-state", "public clients have no client secret", undefined, {
      explanation:
        "Public clients authenticate with PKCE only. Register a confidential integration to use a secret.",
    });
  }
  if ((await secretsOf(svc, id)).length >= MAX_ACTIVE_SECRETS) {
    throw new ApiError(
      409,
      "invalid-state",
      `at most ${MAX_ACTIVE_SECRETS} secrets can be active`,
      undefined,
      {
        explanation:
          "Revoke the old secret (DELETE /api/v1/integrations/{id}/secrets/{secretId}) once your platform uses the new one, then generate another.",
      },
    );
  }
  const { plaintext, row: s } = await addSecret(svc, id);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.secret-created",
    subject: `integration:${id}`,
    payload: {
      summary: `New client secret ${s.prefix}… for ${row.name}`,
      secretId: s.id,
      prefix: s.prefix,
    },
  });
  return {
    clientSecret: plaintext,
    secret: { id: s.id, prefix: s.prefix, createdAt: s.createdAt, lastUsedAt: null },
    integration: await integrationView(svc, row),
  };
}

export async function revokeSecret(
  svc: Services,
  caller: Caller,
  id: string,
  secretId: string,
): Promise<IntegrationView> {
  const row = await ownIntegration(svc, caller, id);
  const active = await secretsOf(svc, id);
  if (active.length <= 1 && active.some((s) => s.id === secretId)) {
    throw new ApiError(
      409,
      "last-secret",
      "this is the integration's only active client secret",
      undefined,
      {
        explanation:
          "Generate a new secret first (POST /api/v1/integrations/{id}/secrets), switch your platform to it, then revoke this one.",
      },
    );
  }
  const updated = await svc.store.db
    .update(integrationSecrets)
    .set({ revokedAt: svc.clock.now().toISOString() })
    .where(
      and(
        eq(integrationSecrets.id, secretId),
        eq(integrationSecrets.integrationId, id),
        isNull(integrationSecrets.revokedAt),
      ),
    )
    .returning({ prefix: integrationSecrets.prefix });
  if (updated.length === 0) throw notFound(`secret ${secretId}`);
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.secret-revoked",
    subject: `integration:${id}`,
    payload: { summary: `Revoked client secret ${updated[0]?.prefix}… of ${row.name}`, secretId },
  });
  return integrationView(svc, row);
}

export async function rotateWebhookSecret(
  svc: Services,
  caller: Caller,
  id: string,
): Promise<{ webhookSecret: string; integration: IntegrationView }> {
  const row = await ownIntegration(svc, caller, id);
  const webhookSecret = randomSecret(WEBHOOK_SECRET_PREFIX);
  await svc.store.db
    .update(integrations)
    .set({
      webhookSecretEnc: await sealWebhookSecret(svc, webhookSecret),
      updatedAt: svc.clock.now().toISOString(),
    })
    .where(eq(integrations.id, id));
  await svc.audit.append({
    principalId: caller.principal.id,
    action: "integration.webhook-secret-rotated",
    subject: `integration:${id}`,
    payload: { summary: `New webhook secret for ${row.name}` },
  });
  const after = await ownIntegration(svc, caller, id);
  return { webhookSecret, integration: await integrationView(svc, after) };
}
