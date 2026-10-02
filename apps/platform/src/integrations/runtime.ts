/**
 * How integrations hook into the rest of the platform without the coordinator knowing about them:
 *
 * - `withIntegrationEvents(ports, env)` wraps the coordinator's Store (built in `buildPorts`, so
 *   the HTTP facade, the Durable Objects and the Workflows all get it): a Change insert is
 *   `change.created`; status/head/lane/evidence/tour updates are `change.updated`, `merged` and
 *   `reverted` their own events; a sealed evidence bundle picks up pending integration previews.
 *   Event emission is best effort and never fails the coordinator's write.
 */
import type { Ports } from "@app/coordinator";
import type { Change, Evidence } from "@app/domain";
import type { Services } from "../app-env.js";
import type { D1Store } from "../store/d1-store.js";
import { type ChangeAction, type EventDeps, emitChangeEvent, type WebhookQueue } from "./events.js";
import { attachPendingPreviews } from "./evidence.js";

/** The bindings integrations read beyond `Env` (declared in wrangler.jsonc). */
export interface IntegrationBindings {
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  WEBHOOK_QUEUE?: WebhookQueue;
  INTEGRATION_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

/** Where the platform lives when there is no request to ask (Workflows, DOs, queue consumer). */
export const DEFAULT_PLATFORM_ORIGIN = "https://gittifacts.decroockjovi.workers.dev";

export function platformOrigin(env: IntegrationBindings): string {
  const configured = env.BETTER_AUTH_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through
    }
  }
  return DEFAULT_PLATFORM_ORIGIN;
}

export function webhookQueueOf(env: unknown): WebhookQueue | null {
  const q = (env as IntegrationBindings).WEBHOOK_QUEUE;
  return q && typeof q.send === "function" ? q : null;
}

export function eventDepsFor(svc: Services): EventDeps {
  return { store: svc.store, clock: svc.clock, origin: svc.origin, queue: webhookQueueOf(svc.env) };
}

const UPDATE_FIELDS = ["status", "headSha", "lane", "evidenceId", "tourId"] as const;

function actionFor(patch: Partial<Change>): { action: ChangeAction; fields: string[] } | null {
  if (patch.status === "merged") return { action: "merged", fields: ["status"] };
  if (patch.status === "reverted") return { action: "reverted", fields: ["status"] };
  const fields = UPDATE_FIELDS.filter((f) => patch[f] !== undefined);
  return fields.length > 0 ? { action: "updated", fields: [...fields] } : null;
}

async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`integrations: ${what} failed`, e);
  }
}

export function withIntegrationEvents(ports: Ports, env: unknown): Ports {
  const store = ports.store as D1Store;
  if (typeof (store as { db?: unknown }).db !== "object") return ports; // not the D1 store (tests)
  const deps: EventDeps = {
    store,
    clock: ports.clock,
    origin: platformOrigin(env as IntegrationBindings),
    queue: webhookQueueOf(env),
  };
  const wrapped = new Proxy(store, {
    get(target, prop) {
      if (prop === "insertChange") {
        return async (change: Change) => {
          await target.insertChange(change);
          await quietly("change.created", () => emitChangeEvent(deps, "created", change));
        };
      }
      if (prop === "updateChange") {
        return async (id: string, patch: Partial<Change>) => {
          const row = await target.updateChange(id, patch);
          const a = actionFor(patch);
          if (a)
            await quietly(`change.${a.action}`, () =>
              emitChangeEvent(deps, a.action, row, a.fields),
            );
          return row;
        };
      }
      if (prop === "putEvidence") {
        return async (ev: Evidence) => {
          let out = ev;
          try {
            out = await attachPendingPreviews({ store: target, signer: ports.signer }, ev);
          } catch (e) {
            console.error("integrations: attaching previews to evidence failed", e);
          }
          await target.putEvidence(out);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { ...ports, store: wrapped };
}
