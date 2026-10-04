/**
 * `GITHUB_EVENTS` consumer: verified, deduplicated GitHub deliveries (src/github/webhook.ts).
 * At least once, so every handler is idempotent. Installation events keep the installation and
 * repo lists in sync; change events go to grading (M2 phase B).
 */
import { z } from "zod";
import type { Bindings } from "../app-env.js";
import { D1Store, type Db } from "../store/d1-store.js";
import { GithubRateLimited } from "@app/host-github";
import { InstallationInfo, RepoInfo } from "./api.js";
import { repoIdFor } from "@app/host-github";
import { AUTO_REPOS, latestBacktest, startBacktest } from "./backtests.js";
import { repoAllowed } from "./allowlist.js";
import { githubApp } from "./app-config.js";
import { onChangeDelivery } from "./grading.js";
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
  /** Change events need the whole Worker (coordinator runtime, App credentials). */
  env?: Bindings;
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

/** Repo rows to record; with GITHUB_REPO_ALLOWLIST set, only allowed repos are recorded at all. */
const repoRows = (deps: GithubEventDeps, rs: z.infer<typeof RepoInfo>[]) =>
  rs
    .filter(
      (r) =>
        deps.env === undefined ||
        repoAllowed(deps.env as unknown as Record<string, unknown>, r.full_name),
    )
    .map((r) => ({ id: r.id, fullName: r.full_name, private: r.private }));

async function onInstallation(deps: GithubEventDeps, msg: GithubEventMessage, payload: unknown) {
  const ev = InstallationEvent.safeParse(payload);
  if (!ev.success || ev.data.installation.app_id !== msg.appId) return;
  const i = ev.data.installation;
  const now = deps.now();
  if (ev.data.action === "deleted") {
    await patchInstallation(deps.db, i.id, { deletedAt: now.toISOString() }, now);
    await removeRepos(
      deps.db,
      i.id,
      (await reposOf(deps.db, i.id)).map((r) => r.repoId),
    );
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
      suspendedAt:
        ev.data.action === "suspend"
          ? (i.suspended_at ?? now.toISOString())
          : (i.suspended_at ?? null),
    },
    now,
  );
  if (ev.data.repositories)
    await addRepos(deps.db, i.id, repoRows(deps, ev.data.repositories), now);
  // The "aha" report (spec §3.7): a backtest of a few of the new installation's repos.
  if (ev.data.action === "created" && deps.env !== undefined) {
    await autoBacktest(deps.env, msg, i.id, ev.data.repositories ?? []);
  }
}

/** Backtest up to AUTO_REPOS repos of a new installation of the Reader App (never twice). */
async function autoBacktest(
  env: Bindings,
  msg: GithubEventMessage,
  installationId: number,
  repos: z.infer<typeof RepoInfo>[],
) {
  const store = new D1Store(env.DB, env.BLOBS);
  if (githubApp(env as unknown as Record<string, unknown>)?.appId !== msg.appId) return;
  const cfg = env as unknown as Record<string, unknown>;
  for (const r of repos.filter((x) => repoAllowed(cfg, x.full_name)).slice(0, AUTO_REPOS)) {
    if ((await latestBacktest(store.db, repoIdFor(r.id))) !== null) continue;
    try {
      await startBacktest(env, {
        installationId,
        appId: msg.appId,
        githubRepoId: r.id,
        fullName: r.full_name,
        by: "system",
      });
    } catch (e) {
      console.error("auto backtest failed to start", r.full_name, (e as Error).message);
    }
  }
}

async function onInstallationRepos(
  deps: GithubEventDeps,
  msg: GithubEventMessage,
  payload: unknown,
) {
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
  await addRepos(deps.db, i.id, repoRows(deps, ev.data.repositories_added), now);
  await removeRepos(
    deps.db,
    i.id,
    ev.data.repositories_removed.map((r) => r.id),
  );
  const selection = ev.data.repository_selection ?? i.repository_selection;
  await patchInstallation(deps.db, i.id, { repositorySelection: selection }, now);
}

export type GithubEventHandler = (
  deps: GithubEventDeps,
  msg: GithubEventMessage,
  payload: unknown,
) => Promise<void>;

const withEnv =
  (
    fn: (env: Bindings, msg: GithubEventMessage, payload: unknown) => Promise<void>,
  ): GithubEventHandler =>
  async (deps, msg, payload) => {
    if (deps.env !== undefined) await fn(deps.env, msg, payload);
  };

/** Event name → handler. Change events grade through GithubSync (src/github/grading.ts). */
export const GITHUB_EVENT_HANDLERS: Record<string, GithubEventHandler> = {
  installation: onInstallation,
  installation_repositories: onInstallationRepos,
  pull_request: withEnv(onChangeDelivery),
  pull_request_review: withEnv(onChangeDelivery),
  push: withEnv(onChangeDelivery),
  merge_group: withEnv(onChangeDelivery),
  // M3: the check run's buttons, and plan labels on issues.
  check_run: withEnv(onChangeDelivery),
  issues: withEnv(onChangeDelivery),
  // QA on request: `/gittifacts qa` in a PR comment (needs the App's Issue comment event).
  issue_comment: withEnv(onChangeDelivery),
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
  const deps: GithubEventDeps = { db: store.db, blobs: env.BLOBS, now: () => new Date(), env };
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
      console.error(
        "github event failed",
        parsed.data.event,
        parsed.data.deliveryId,
        (err as Error).message,
      );
      // GitHub's rate limits say when to come back; anything else backs off exponentially.
      const delay = err instanceof GithubRateLimited ? err.retryAfterSec : 5 * 2 ** m.attempts;
      m.retry({ delaySeconds: Math.min(900, Math.max(1, delay)) });
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
