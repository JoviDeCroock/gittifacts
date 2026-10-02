/**
 * Webhook fan-out. An event about a repo becomes one `webhook_deliveries` row per active
 * installation that (1) covers the repo, (2) holds `webhooks`, and (3) whose integration has an
 * active webhook URL subscribed to the event. Each row is sent to the `WEBHOOK_QUEUE` (at least
 * once; ./delivery.ts signs and POSTs). Without a queue binding rows stay pending and the cron
 * sweep picks them up.
 *
 * Sources: change rows (inserted/updated through the coordinator's Store: created, updated,
 * merged, reverted), Artifacts push events (the PushRouter hook: default branch + change forks),
 * installations (created/deleted) and pings.
 */
import type { Change, Repo } from "@app/domain";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Services } from "../app-env.js";
import { installationRepos, installations, integrations, webhookDeliveries } from "../db/schema.js";
import { canInstallOn } from "./access.js";
import { changeCloneUrl, type NamingDeps, type RepoNames, repoNames } from "./handles.js";
import { type WebhookEvent, integrationScopesOf } from "./scopes.js";
import { eventsOf } from "./registry.js";

export interface WebhookMessage {
  deliveryId: string;
}

/** The queue producer (a `Queue<WebhookMessage>` binding, or a test double). */
export interface WebhookQueue {
  send(body: WebhookMessage, options?: { delaySeconds?: number }): Promise<void>;
}

export type EventDeps = NamingDeps & { queue: WebhookQueue | null };

export interface Target {
  integrationId: string;
  installationId: string | null;
  url: string;
}

/** Installations that should hear about `event` on `repo`. */
export async function targetsForRepo(
  deps: EventDeps,
  repo: Repo,
  event: WebhookEvent,
): Promise<Target[]> {
  if (repo.claim.status !== "claimed" || repo.claim.ownerId === null) return [];
  const owner = repo.claim.ownerId;
  const rows = await deps.store.db
    .select({
      installationId: installations.id,
      accountId: installations.accountId,
      scopes: installations.scopes,
      integrationId: integrations.id,
      url: integrations.webhookUrl,
      events: integrations.webhookEvents,
    })
    .from(installations)
    .innerJoin(integrations, eq(integrations.id, installations.integrationId))
    .where(
      and(
        eq(installations.status, "active"),
        eq(installations.accountId, owner),
        isNull(integrations.deletedAt),
        isNotNull(integrations.webhookUrl),
        eq(integrations.webhookActive, true),
        or(
          eq(installations.repoSelection, "all"),
          sql`exists (select 1 from ${installationRepos} where ${installationRepos.installationId} = ${installations.id} and ${installationRepos.repoId} = ${repo.id})`,
        ),
      ),
    )
    .all();
  return rows
    .filter((r) => canInstallOn({ id: r.accountId, kind: "human" }, repo))
    .filter((r) => integrationScopesOf(r.scopes).includes("webhooks"))
    .filter((r) => eventsOf(r.events).includes(event))
    .map((r) => ({ integrationId: r.integrationId, installationId: r.installationId, url: r.url ?? "" }));
}

/** Insert one pending delivery per target and queue them. Returns the delivery ids. */
export async function enqueueDeliveries(
  deps: EventDeps,
  targets: readonly Target[],
  event: WebhookEvent,
  action: string | null,
  repoId: string | null,
  body: (deliveryId: string, target: Target) => unknown,
): Promise<string[]> {
  const ids: string[] = [];
  const now = deps.clock.now().toISOString();
  for (const t of targets) {
    const id = crypto.randomUUID();
    await deps.store.db.insert(webhookDeliveries).values({
      id,
      guid: id,
      integrationId: t.integrationId,
      installationId: t.installationId,
      event,
      action,
      repoId,
      payload: JSON.stringify(body(id, t)),
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastAttemptAt: null,
      leaseUntil: null,
      url: t.url,
      responseStatus: null,
      responseBody: null,
      durationMs: null,
      error: null,
      redeliveryOf: null,
      createdAt: now,
    });
    ids.push(id);
  }
  await sendAll(deps.queue, ids);
  return ids;
}

export async function sendAll(queue: WebhookQueue | null, ids: readonly string[], delaySeconds = 0): Promise<void> {
  if (queue === null) return;
  for (const deliveryId of ids) {
    try {
      await queue.send({ deliveryId }, delaySeconds > 0 ? { delaySeconds } : undefined);
    } catch (e) {
      // The row stays pending; the cron sweep re-queues it.
      console.error("webhook queue send failed", deliveryId, e);
    }
  }
}

// ---------------------------------------------------------------- payloads

export function repositoryJson(deps: NamingDeps, repo: Repo, names: RepoNames) {
  return {
    id: repo.id,
    name: repo.name,
    fullName: names.fullName,
    owner: names.owner,
    defaultBranch: repo.defaultBranch,
    cloneUrl: names.cloneUrl,
    htmlUrl: `${deps.origin}/repos/${repo.id}`,
    apiUrl: `${deps.origin}/api/v1/repos/${repo.id}`,
  };
}

export function changeJson(deps: NamingDeps, change: Change, names: RepoNames) {
  return {
    id: change.id,
    title: change.title,
    status: change.status,
    planId: change.planId,
    baseSha: change.baseSha,
    headSha: change.headSha,
    mergedSha: change.mergedSha,
    lane: change.lane,
    revertOf: change.revertOf,
    cloneUrl: changeCloneUrl(names, change),
    htmlUrl: `${deps.origin}/changes/${change.id}`,
    apiUrl: `${deps.origin}/api/v1/changes/${change.id}`,
  };
}

function envelope(event: WebhookEvent, action: string | null, deliveryId: string, deps: NamingDeps, t: Target) {
  return {
    event,
    action,
    deliveryId,
    createdAt: deps.clock.now().toISOString(),
    installation: t.installationId === null ? null : { id: t.installationId },
  };
}

// ---------------------------------------------------------------- emitters

export type ChangeAction = "created" | "updated" | "merged" | "reverted";

/** `change.<action>` for every installation covering the Change's repo. */
export async function emitChangeEvent(
  deps: EventDeps,
  action: ChangeAction,
  change: Change,
  fields: readonly string[] = [],
): Promise<string[]> {
  const event = `change.${action}` as WebhookEvent;
  const repo = await deps.store.getRepo(change.repoId);
  if (repo === null) return [];
  const targets = await targetsForRepo(deps, repo, event);
  if (targets.length === 0) return [];
  const names = await repoNames(deps, repo);
  if (names === null) return [];
  const sha = action === "merged" ? (change.mergedSha ?? change.headSha) : change.headSha;
  return enqueueDeliveries(deps, targets, event, action, repo.id, (id, t) => ({
    ...envelope(event, action, id, deps, t),
    repository: repositoryJson(deps, repo, names),
    change: changeJson(deps, change, names),
    // Where to build from: the Change's fork head, or (merged) the default branch.
    cloneUrl: action === "merged" ? names.cloneUrl : changeCloneUrl(names, change),
    sha,
    ...(fields.length > 0 ? { changedFields: [...fields] } : {}),
  }));
}

export interface PushInput {
  repoName: string;
  ref: string;
  before: string;
  after: string;
}

const ZERO = /^0+$/;
/** Where the merge queue's sandbox pushes a rebased head in a fork (not the author's push). */
const REBASE_REF = "refs/heads/gittifacts/rebased";

/**
 * An Artifacts push (the PushRouter hook): the default branch of a main repo, or any branch of a
 * change fork. Deletes, tags, notes and queue refs are not `push` events.
 */
export async function emitPushEvent(deps: EventDeps, push: PushInput): Promise<string[]> {
  if (!push.ref.startsWith("refs/heads/") || ZERO.test(push.after) || push.ref === REBASE_REF) return [];
  let repo: Repo | null;
  let change: Change | null = null;
  if (push.repoName.startsWith("task-")) {
    change = await deps.store.getChangeByFork(push.repoName);
    if (change === null) return [];
    repo = await deps.store.getRepo(change.repoId);
  } else {
    repo = await deps.store.getRepoByArtifactsName(push.repoName);
    if (repo !== null && push.ref !== `refs/heads/${repo.defaultBranch}`) return [];
  }
  if (repo === null) return [];
  const targets = await targetsForRepo(deps, repo, "push");
  if (targets.length === 0) return [];
  const names = await repoNames(deps, repo);
  if (names === null) return [];
  const r = repo;
  const c = change;
  return enqueueDeliveries(deps, targets, "push", null, repo.id, (id, t) => ({
    ...envelope("push", null, id, deps, t),
    repository: repositoryJson(deps, r, names),
    kind: c === null ? "default-branch" : "change",
    ref: push.ref,
    before: push.before,
    after: push.after,
    sha: push.after,
    cloneUrl: c === null ? names.cloneUrl : changeCloneUrl(names, c),
    change: c === null ? null : changeJson(deps, { ...c, headSha: push.after }, names),
  }));
}

/** `installation.created` / `installation.deleted` to the integration itself (no repo filter). */
export async function emitInstallationEvent(
  deps: EventDeps,
  action: "created" | "deleted",
  installationId: string,
  detail: { account: { id: string; handle: string }; repoSelection: string; repositories: unknown[]; scopes: string[] },
): Promise<string[]> {
  const event: WebhookEvent = action === "created" ? "installation.created" : "installation.deleted";
  const row = await deps.store.db
    .select({ integrationId: installations.integrationId, url: integrations.webhookUrl, events: integrations.webhookEvents, active: integrations.webhookActive })
    .from(installations)
    .innerJoin(integrations, eq(integrations.id, installations.integrationId))
    .where(eq(installations.id, installationId))
    .get();
  if (!row?.url || !row.active || !eventsOf(row.events).includes(event)) return [];
  const target: Target = { integrationId: row.integrationId, installationId, url: row.url };
  return enqueueDeliveries(deps, [target], event, action, null, (id, t) => ({
    ...envelope(event, action, id, deps, t),
    installation: { id: installationId, ...detail },
  }));
}

/** `ping` to the integration's webhook URL (always allowed while a URL is set). */
export async function emitPing(deps: EventDeps, integrationId: string): Promise<string | null> {
  const row = await deps.store.db.select().from(integrations).where(eq(integrations.id, integrationId)).get();
  if (!row?.webhookUrl) return null;
  const target: Target = { integrationId, installationId: null, url: row.webhookUrl };
  const [id] = await enqueueDeliveries(deps, [target], "ping", null, null, (deliveryId, t) => ({
    ...envelope("ping", null, deliveryId, deps, t),
    zen: "Humans approve intent. Machines prove conformance.",
    integration: { id: row.id, clientId: row.clientId, name: row.name },
    hook: { url: row.webhookUrl, events: eventsOf(row.webhookEvents), active: row.webhookActive },
  }));
  return id ?? null;
}
