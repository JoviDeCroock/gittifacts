/**
 * Wiring of import-by-push grants (src/import/push-grant.ts) into the Worker:
 *
 * - `grantDeps(svc)`: request handlers' deps; a finished import starts the bootstrap CI and the
 *   O5 detection proposal (`.platform/*` as a Plan + Lane 2 Change).
 * - `guardImportGrants(api, …)`: the coordinator facade closes a live grant before startChange
 *   and startBootstrapChange (a Change must never fork a main repo someone else can still push).
 * - `platformPushObserver`: the PushRouter's observer (integration webhooks + closing grants).
 * - `runImportGrantSweep`: the cron's TTL sweep.
 */
import { type CoordinatorApi, resolveRuntime } from "@app/coordinator";
import type { PushEventInfo } from "@app/coordinator/workers";
import type { Bindings, Services } from "../app-env.js";
import { onPushEvent as emitPushWebhooks } from "../integrations/worker.js";
import { D1Store } from "../store/d1-store.js";
import { getGrant } from "./grant-store.js";
import {
  closeImportGrantBeforeChange,
  type GrantDeps,
  onImportPush,
  sweepImportGrants,
} from "./push-grant.js";
import { startPlatformConfigProposal } from "./service.js";
import { servicesFor, systemCaller } from "./steps.js";

/** What follows a push import: the first CI run on the default branch, and the proposal. */
async function afterPushImport(svc: Services, repoId: string, openedBy: string): Promise<void> {
  const system = await systemCaller(svc);
  const results = await Promise.allSettled([
    svc.coordinator.startBootstrapChange(system.principal, repoId),
    startPlatformConfigProposal(svc, { repoId, requestedBy: openedBy }),
  ]);
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    throw new Error(`after import: ${failed.map((r) => String(r.reason)).join("; ")}`);
  }
}

export function grantDeps(svc: Services): GrantDeps {
  return {
    db: svc.store.db,
    store: svc.store,
    audit: svc.audit,
    git: resolveRuntime(svc.env, "default").ports.git,
    now: () => svc.clock.now(),
    onImported: (repo, { openedBy }) => afterPushImport(svc, repo.id, openedBy),
  };
}

const NO_CTX = {
  waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined),
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

/** Deps outside a request (workflows, cron): services for the configured origin. */
export function grantDepsFromEnv(env: Bindings, ctx: ExecutionContext = NO_CTX): GrantDeps {
  return grantDeps(servicesFor(env, ctx, env.BETTER_AUTH_URL ?? "https://gittifacts.invalid"));
}

/** The facade with a live import grant closed before any Change starts on that repo. */
export function guardImportGrants(
  api: CoordinatorApi,
  env: Bindings,
  ctx: ExecutionContext,
  origin: string,
): CoordinatorApi {
  const closeFirst = async (repoId: string, actorId: string): Promise<void> => {
    const db = new D1Store(env.DB, env.BLOBS).db;
    const row = await getGrant(db, repoId);
    if (row === null || row.status === "closed") return;
    await closeImportGrantBeforeChange(grantDeps(servicesFor(env, ctx, origin)), repoId, actorId);
  };
  return {
    ...api,
    startChange: async (actor, input) => {
      await closeFirst(input.repoId, actor.id);
      return api.startChange(actor, input);
    },
    startBootstrapChange: async (actor, repoId) => {
      await closeFirst(repoId, actor.id);
      return api.startBootstrapChange(actor, repoId);
    },
  };
}

/** `configureCoordinatorRuntime({ onPushEvent })`: webhooks, then import grants. */
export async function platformPushObserver(env: Bindings, push: PushEventInfo): Promise<void> {
  const [hooks, grant] = await Promise.allSettled([
    emitPushWebhooks(env, push),
    onImportPush(grantDepsFromEnv(env), push),
  ]);
  // A rejection makes the PushRouter's observe step retry (closing is idempotent).
  if (grant.status === "rejected") throw grant.reason;
  if (hooks.status === "rejected") throw hooks.reason;
}

export async function runImportGrantSweep(env: Bindings): Promise<number> {
  const closed = await sweepImportGrants(grantDepsFromEnv(env));
  if (closed.length > 0) console.log(JSON.stringify({ event: "import-grant-sweep", closed }));
  return closed.length;
}
