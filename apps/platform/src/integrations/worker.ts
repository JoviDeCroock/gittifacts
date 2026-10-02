/**
 * Entry points the Worker module (src/index.ts) wires: the PushRouter observer, the
 * `WEBHOOK_QUEUE` consumer and the cron sweep. They run without a request, so they build their own
 * store and use the configured platform origin (BETTER_AUTH_URL).
 */
import type { PushEventInfo } from "@app/coordinator/workers";
import type { Bindings } from "../app-env.js";
import { D1Store } from "../store/d1-store.js";
import { type DeliveryDeps, handleWebhookBatch, sweepDeliveries } from "./delivery.js";
import { emitPushEvent, type EventDeps } from "./events.js";
import { platformOrigin, webhookQueueOf } from "./runtime.js";

function clock() {
  const now = () => new Date();
  return { now };
}

export function eventDepsFromEnv(env: Bindings): EventDeps {
  const c = clock();
  return {
    store: new D1Store(env.DB, env.BLOBS, c.now),
    clock: c,
    origin: platformOrigin(env),
    queue: webhookQueueOf(env),
  };
}

export function deliveryDepsFromEnv(env: Bindings): DeliveryDeps {
  const c = clock();
  return {
    store: new D1Store(env.DB, env.BLOBS, c.now),
    clock: c,
    env,
    queue: webhookQueueOf(env),
    // Looked up per call (tests replace globalThis.fetch).
    fetch: (input, init) => fetch(input, init),
  };
}

/** `configureCoordinatorRuntime({ onPushEvent })`: default-branch and change-fork pushes → webhooks. */
export async function onPushEvent(env: Bindings, push: PushEventInfo): Promise<void> {
  await emitPushEvent(eventDepsFromEnv(env), push);
}

export async function runWebhookQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  await handleWebhookBatch(batch, deliveryDepsFromEnv(env));
}

export async function runWebhookSweep(env: Bindings): Promise<number> {
  return sweepDeliveries(deliveryDepsFromEnv(env));
}
