/**
 * POST /github/webhooks — every GitHub App's webhook (docs/research/github-app.md §4, decision 7).
 *
 * 1. Rate-limit by client IP before any work (nothing is authenticated yet).
 * 2. Our App from config (`X-GitHub-Hook-Installation-Target-ID` must be its id, else 401; the
 *    current webhook secret and, during a rotation, the previous one). Not configured → 503.
 * 3. HMAC-SHA-256 over the raw body, constant-time; bad or missing signature → 401.
 * 4. Dedupe on `X-GitHub-Delivery` (D1, kept 8 days): a redelivery is acknowledged, not re-queued.
 * 5. Enqueue on `GITHUB_EVENTS` (payloads over 96 KB go to R2 first; a queue message is ≤ 128 KB)
 *    and answer 202. If the enqueue fails the GUID is forgotten and GitHub gets a 503, so a
 *    redelivery is processed.
 */
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { ApiError } from "../errors.js";
import { appForId, githubApp } from "./app-config.js";
import { verifyGithubSignature } from "./crypto.js";
import { forgetDelivery, recordDelivery } from "./store.js";

export const GITHUB_WEBHOOK_PATH = "/github/webhooks";
/** Inline payloads up to this size; larger ones go through R2. */
const INLINE_MAX = 96 * 1024;
/** GitHub doesn't deliver payloads over 25 MB. */
const BODY_MAX = 25 * 1024 * 1024;

export const GithubEventMessage = z.object({
  v: z.literal(1),
  deliveryId: z.string(),
  appId: z.number().int(),
  event: z.string(),
  action: z.string().nullable(),
  installationId: z.number().int().nullable(),
  receivedAt: z.string(),
  payload: z.unknown().optional(),
  /** R2 key in BLOBS when the payload was too large to inline. */
  payloadRef: z.string().optional(),
});
export type GithubEventMessage = z.infer<typeof GithubEventMessage>;

export interface GithubEventsQueue {
  send(body: GithubEventMessage, opts?: { contentType?: "json" }): Promise<unknown>;
}

export interface GithubWebhookBindings {
  GITHUB_EVENTS?: GithubEventsQueue;
  GITHUB_WEBHOOK_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

const Envelope = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number().int() }).nullable().optional(),
});

/** 401 with a hint that fits a webhook sender, not an API client. */
const unauthorized = (message: string) =>
  new ApiError(401, "unauthorized", message, undefined, {
    explanation:
      "GitHub App deliveries name the App in X-GitHub-Hook-Installation-Target-ID and are signed with that App's webhook secret (X-Hub-Signature-256 over the raw body). Only the platform's own Apps (GITHUB_APP_ID, GITHUB_ACTOR_APP_ID in the Worker config) are accepted.",
  });

const DELIVERY_ID = /^[A-Za-z0-9-]{8,64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

export async function handleGithubWebhook(c: Context<AppEnv>): Promise<Response> {
  const env = c.env as GithubWebhookBindings;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (env.GITHUB_WEBHOOK_LIMITER) {
    const { success } = await env.GITHUB_WEBHOOK_LIMITER.limit({ key: `ip:${ip}` });
    if (!success) {
      c.header("retry-after", "60");
      throw new ApiError(429, "rate-limited", "too many webhook requests from this address");
    }
  }
  // GitHub mode not configured (Worker vars and secrets): say so plainly, not "unauthorized".
  if (githubApp(c.env as unknown as Record<string, unknown>) === null) {
    throw new ApiError(
      503,
      "github-not-configured",
      "GitHub mode is not configured on this platform",
      undefined,
      {
        explanation:
          "Set the GitHub App's vars and secrets (docs/deploy.md, GitHub mode); until then GitHub deliveries are refused.",
      },
    );
  }
  const appHeader = c.req.header("x-github-hook-installation-target-id") ?? "";
  const targetType = c.req.header("x-github-hook-installation-target-type");
  if (!/^\d{1,12}$/.test(appHeader) || (targetType && targetType !== "integration")) {
    throw unauthorized("not a GitHub App webhook we know");
  }
  // Only our own App(s), from config: the Reader App (and the Actor App once configured).
  const app = appForId(c.env as unknown as Record<string, unknown>, Number(appHeader));
  if (app === null) throw unauthorized("not a GitHub App webhook we know");
  const appId = app.appId;

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > BODY_MAX) throw new ApiError(413, "payload-too-large", "payload over 25 MB");
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (
    !(await verifyGithubSignature(app.webhookSecrets, raw, c.req.header("x-hub-signature-256")))
  ) {
    throw unauthorized("bad webhook signature");
  }

  const deliveryId = c.req.header("x-github-delivery") ?? "";
  const event = c.req.header("x-github-event") ?? "";
  if (!DELIVERY_ID.test(deliveryId) || !EVENT_NAME.test(event)) {
    throw new ApiError(400, "invalid-request", "missing X-GitHub-Delivery or X-GitHub-Event");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiError(400, "invalid-request", "the payload is not JSON");
  }
  const env2 = Envelope.safeParse(payload);
  const action = env2.success ? (env2.data.action ?? null) : null;
  const installationId = env2.success ? (env2.data.installation?.id ?? null) : null;
  if (event === "ping") return c.json({ received: true, event, deliveryId }, 202);

  const svc = c.get("services");
  const receivedAt = svc.clock.now().toISOString();
  const fresh = await recordDelivery(svc.store.db, {
    id: deliveryId,
    appId,
    event,
    action,
    installationId,
    receivedAt,
  });
  if (!fresh) return c.json({ received: true, duplicate: true, deliveryId }, 202);

  const msg: GithubEventMessage = {
    v: 1,
    deliveryId,
    appId,
    event,
    action,
    installationId,
    receivedAt,
  };
  try {
    if (!env.GITHUB_EVENTS) throw new Error("GITHUB_EVENTS queue is not bound");
    if (raw.byteLength > INLINE_MAX) {
      const key = `github/deliveries/${deliveryId}.json`;
      await svc.env.BLOBS.put(key, raw, { httpMetadata: { contentType: "application/json" } });
      msg.payloadRef = key;
    } else {
      msg.payload = payload;
    }
    await env.GITHUB_EVENTS.send(msg, { contentType: "json" });
  } catch (err) {
    await forgetDelivery(svc.store.db, deliveryId);
    throw new ApiError(
      503,
      "unavailable",
      `could not queue the delivery: ${(err as Error).message}`,
    );
  }
  return c.json({ received: true, deliveryId }, 202);
}
