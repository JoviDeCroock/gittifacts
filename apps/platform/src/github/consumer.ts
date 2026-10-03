/**
 * `GITHUB_EVENTS` consumer: verified, deduplicated GitHub deliveries (src/github/webhook.ts).
 * At least once, so every handler is idempotent. Installation events keep the installation and
 * repo lists in sync; change events go to grading (M2 phase B).
 */
import { z } from "zod";
import type { Bindings } from "../app-env.js";
import { D1Store, type Db } from "../store/d1-store.js";
import { InstallationInfo, RepoInfo } from "./api.js";
import {
  addRepos,
  getInstallation,
  patchInstallation,
  removeRepos,
  reposOf,
  sweepGithub,
  upsertInstallation,
} from "./store.js";
import { GithubEventMessage } from "./webhook.js";

export interface GithubEventDeps {
  db: Db;
  blobs: R2Bucket;
  now(): Date;
}

const InstallationEvent = z.object({
  action: z.string(),
  installation: InstallationInfo,
  repositories: z.array(RepoInfo).optional(),
});

const InstallationReposEvent = z.object({
  action: z.enum(["added", "removed"]),
  installation: InstallationInfo,
  repository_selection: z.enum(["all", "selected"]).optional(),
  repositories_added: z.array(RepoInfo).default([]),
  repositories_removed: z.array(RepoInfo.pick({ id: true, full_name: true })).default([]),
});

const repoRows = (rs: z.infer<typeof RepoInfo>[]) =>
  rs.map((r) => ({ id: r.id, fullName: r.full_name, private: r.private }));

async function onInstallation(deps: GithubEventDeps, msg: GithubEventMessage, payload: unknown) {
  const ev = InstallationEvent.safeParse(payload);
  if (!ev.success || ev.data.installation.app_id !== msg.appId) return;
  const i = ev.data.installation;
  const now = deps.now();
  if (ev.data.action === "deleted") {
    await patchInstallation(deps.db, i.id, { deletedAt: now.toISOString() }, now);
    await removeRepos(deps.db, i.id, (await reposOf(deps.db, i.id)).map((r) => r.repoId));
    return;
  }
  if (!i.account) return;
  await upsertInstallation(
    deps.db,
    {
      id: i.id,
      appId: i.app_id,
      account: i.account,
      repositorySelection: i.repository_selection,
      permissions: i.permissions,
      events: i.events,
      suspendedAt: ev.data.action === "suspend" ? (i.suspended_at ?? now.toISOString()) : (i.suspended_at ?? null),
    },
    now,
  );
  if (ev.data.repositories) await addRepos(deps.db, i.id, repoRows(ev.data.repositories), now);
}

async function onInstallationRepos(deps: GithubEventDeps, msg: GithubEventMessage, payload: unknown) {
  const ev = InstallationReposEvent.safeParse(payload);
  if (!ev.success || ev.data.installation.app_id !== msg.appId) return;
  const i = ev.data.installation;
  const now = deps.now();
  if (!(await getInstallation(deps.db, i.id)) && i.account) {
    await upsertInstallation(
      deps.db,
      {
        id: i.id,
        appId: i.app_id,
        account: i.account,
        repositorySelection: i.repository_selection,
        permissions: i.permissions,
        events: i.events,
        suspendedAt: i.suspended_at ?? null,
      },
      now,
    );
  }
  await addRepos(deps.db, i.id, repoRows(ev.data.repositories_added), now);
  await removeRepos(deps.db, i.id, ev.data.repositories_removed.map((r) => r.id));
  const selection = ev.data.repository_selection ?? i.repository_selection;
  await patchInstallation(deps.db, i.id, { repositorySelection: selection }, now);
}

export type GithubEventHandler = (
  deps: GithubEventDeps,
  msg: GithubEventMessage,
  payload: unknown,
) => Promise<void>;

/** Event name → handler. Phase B adds pull_request, pull_request_review, push, merge_group. */
export const GITHUB_EVENT_HANDLERS: Record<string, GithubEventHandler> = {
  installation: onInstallation,
  installation_repositories: onInstallationRepos,
};

async function payloadOf(deps: GithubEventDeps, msg: GithubEventMessage): Promise<unknown> {
  if (msg.payloadRef === undefined) return msg.payload;
  const obj = await deps.blobs.get(msg.payloadRef);
  if (!obj) throw new Error(`payload ${msg.payloadRef} is missing`);
  return JSON.parse(await obj.text());
}

export async function handleGithubEvent(deps: GithubEventDeps, msg: GithubEventMessage) {
  const handler = GITHUB_EVENT_HANDLERS[msg.event];
  if (!handler) return;
  await handler(deps, msg, await payloadOf(deps, msg));
  if (msg.payloadRef) await deps.blobs.delete(msg.payloadRef);
}

export async function runGithubEventQueue(batch: MessageBatch<unknown>, env: Bindings) {
  const store = new D1Store(env.DB, env.BLOBS, () => new Date());
  const deps: GithubEventDeps = { db: store.db, blobs: env.BLOBS, now: () => new Date() };
  for (const m of batch.messages) {
    const parsed = GithubEventMessage.safeParse(m.body);
    if (!parsed.success) {
      console.error("github event: malformed queue message dropped", m.id);
      m.ack();
      continue;
    }
    try {
      await handleGithubEvent(deps, parsed.data);
      m.ack();
    } catch (err) {
      console.error("github event failed", parsed.data.event, parsed.data.deliveryId, (err as Error).message);
      m.retry({ delaySeconds: Math.min(300, 5 * 2 ** m.attempts) });
    }
  }
}

export const GITHUB_EVENTS_QUEUE = "gittifacts-github-events";

/** Cron: delivery GUIDs past 8 days, states expired a day ago. */
export async function runGithubSweep(env: Bindings): Promise<void> {
  try {
    await sweepGithub(new D1Store(env.DB, env.BLOBS, () => new Date()).db, new Date());
  } catch (err) {
    console.error("github sweep failed", (err as Error).message);
  }
}
