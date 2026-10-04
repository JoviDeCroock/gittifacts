/**
 * Change events from the `GITHUB_EVENTS` queue → `GithubSync` (packages/host-github): the
 * Artifacts mirror fetches the head, the PR's Change is created or updated, the
 * `gittifacts/lane` run opens, and the ChangeWorkflow grades the head (src/index.ts gives it the
 * GitHub host). Only the Reader App grades, only for live installations.
 *
 * Also here: the principals PR authors grade as (disabled: they never sign in), repo
 * memberships for the humans who linked the installation, and check-run buttons (intent only
 * until M3).
 */
import { githubQaPort } from "../qa/github.js";
import { resolveRuntime } from "@app/coordinator";
import type { GithubRepoHost, Repo } from "@app/domain";
import type { Identity } from "@app/host";
import { GithubRepo, GithubSync, InstallationTokens, principalIdFor, repoIdFor } from "@app/host-github";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { putMember } from "../access/members-store.js";
import type { Bindings } from "../app-env.js";
import { principals } from "../db/app-schema.js";
import { githubInstallationLinks, githubInstallationRepos } from "../db/github-schema.js";
import { D1Store } from "../store/d1-store.js";
import { githubActorPrincipal, upsertGithubPlan } from "./plans.js";
import { githubHostFor, githubReadSource } from "./runtime.js";
import { repoAllowed } from "./allowlist.js";
import { githubApp } from "./app-config.js";
import { appInstallation } from "./api.js";
import { addRepos, getInstallation, upsertInstallation } from "./store.js";
import type { GithubEventMessage } from "./webhook.js";

/** The principal a GitHub account authors as: created once, disabled (it never authenticates). */
export async function ensureGithubPrincipal(
  store: D1Store,
  who: Identity & { login: string },
): Promise<string> {
  const id = principalIdFor(Number(who.id));
  const now = new Date().toISOString();
  await store.db
    .insert(principals)
    .values({
      id,
      kind: who.kind === "human" ? "human" : "agent",
      name: `${who.login} (GitHub)`.slice(0, 120),
      ownerId: null,
      userId: null,
      scopes: [],
      disabledAt: now,
      createdAt: now,
    })
    .onConflictDoNothing();
  return id;
}

/** Humans who linked the installation see its repos: the first as owner, the rest maintainers. */
export async function grantInstallationMembers(
  store: D1Store,
  repo: Repo,
  installationId: number,
): Promise<void> {
  const links = await store.db
    .select()
    .from(githubInstallationLinks)
    .where(eq(githubInstallationLinks.installationId, installationId))
    .orderBy(githubInstallationLinks.linkedAt)
    .all();
  const at = new Date().toISOString();
  for (const [i, link] of links.entries()) {
    if (i === 0 && repo.claim.ownerId === null) {
      // A claimed repo's owner becomes an `owner` member (d1-store updateRepo).
      await store.updateRepo(repo.id, {
        claim: { status: "claimed", ownerId: link.principalId, expiresAt: null },
      });
    } else {
      await putMember(store, {
        repoId: repo.id,
        principalId: link.principalId,
        role: "maintainer",
        addedBy: "system",
        addedAt: at,
      });
    }
  }
}

/** After a link: memberships on the installation's repos that are already graded. */
export async function grantLinkedRepos(
  store: D1Store,
  installationId: number,
  principalId: string,
): Promise<void> {
  const rows = await store.db
    .select({ id: githubInstallationRepos.repoId })
    .from(githubInstallationRepos)
    .where(eq(githubInstallationRepos.installationId, installationId))
    .all();
  const at = new Date().toISOString();
  for (const { id } of rows) {
    const repo = await store.getRepo(repoIdFor(id));
    if (repo === null) continue;
    if (repo.claim.ownerId === null) {
      await store.updateRepo(repo.id, {
        claim: { status: "claimed", ownerId: principalId, expiresAt: null },
      });
    } else if (repo.claim.ownerId !== principalId) {
      await putMember(store, {
        repoId: repo.id,
        principalId,
        role: "maintainer",
        addedBy: "system",
        addedAt: at,
      });
    }
  }
}

/**
 * A change event for an installation we never recorded (its `installation.created` delivery
 * failed, or is still waiting for a redelivery): ask GitHub with the App's JWT and record it,
 * with only this (already allowed) repo, instead of dropping the event for good. Only the Reader
 * App's installations. GitHub doesn't know it (deleted): null, nothing recorded. Any other GitHub
 * error throws, so the queue retries the delivery.
 */
export async function adoptInstallation(
  env: Bindings,
  store: D1Store,
  installationId: number,
  appId: number,
  repo: GithubRepo,
) {
  const app = githubApp(env as unknown as Record<string, unknown>);
  if (app === null || app.appId !== appId) return null;
  const jwt = await new InstallationTokens({
    appId: app.appId,
    clientId: app.clientId,
    privateKey: app.privateKey,
  }).appJwt();
  const i = await appInstallation(jwt, installationId);
  if (i === null || i.app_id !== appId || i.account === null) return null;
  const now = new Date();
  await upsertInstallation(
    store.db,
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
  await addRepos(store.db, i.id, [{ id: repo.id, fullName: repo.full_name, private: repo.private }], now);
  console.log(JSON.stringify({ github: "installation.adopted", installationId: i.id, repo: repo.full_name }));
  return getInstallation(store.db, i.id);
}

const WithRepo = z.object({ repository: GithubRepo });

/** pull_request, pull_request_review, push, merge_group → GithubSync. */
export async function onChangeDelivery(
  env: Bindings,
  msg: GithubEventMessage,
  payload: unknown,
): Promise<void> {
  const parsed = WithRepo.safeParse(payload);
  if (!parsed.success || msg.installationId === null) return;
  // Outside GITHUB_REPO_ALLOWLIST: no mirror, no grade, no write (and nothing read from D1).
  if (!repoAllowed(env as unknown as Record<string, unknown>, parsed.data.repository.full_name))
    return;
  const store = new D1Store(env.DB, env.BLOBS, () => new Date());
  const inst =
    (await getInstallation(store.db, msg.installationId)) ??
    (await adoptInstallation(env, store, msg.installationId, msg.appId, parsed.data.repository));
  if (
    inst === null ||
    inst.deletedAt !== null ||
    inst.suspendedAt !== null ||
    inst.appId !== msg.appId
  )
    return;
  // Only the Reader App grades (the Actor App, M5, acts on decisions and never grades).
  if (githubApp(env as unknown as Record<string, unknown>)?.appId !== msg.appId) return;
  const r = parsed.data.repository;
  const repoHost: GithubRepoHost = {
    kind: "github",
    owner: r.owner.login,
    repo: r.name,
    githubRepoId: r.id,
    installationId: msg.installationId,
    appId: msg.appId,
    private: r.private,
  };
  const { ports, bindings } = resolveRuntime(env, "github");
  const { host, release } = githubHostFor(env, ports, repoHost);
  const sync = new GithubSync({
    ports,
    coordinator: (id) => bindings.changeCoordinator(id),
    host,
    installationId: msg.installationId,
    appId: msg.appId,
    source: () => githubReadSource(env, repoHost),
    // One person, one principal: a linked GitHub login acts as the human who linked it.
    authorPrincipal: (who) => githubActorPrincipal(store, who),
    reviewerPrincipal: (who) => githubActorPrincipal(store, who),
    plans: { upsert: (plan) => upsertGithubPlan(env, store, plan) },
    onRepoCreated: (repo) => grantInstallationMembers(store, repo, repoHost.installationId),
    // QA on request: the check run's Run QA button and `/gittifacts qa` (src/qa/github.ts).
    qa: githubQaPort(env),
  });
  try {
    const out = await sync.handle({ event: msg.event, payload });
    console.log(
      JSON.stringify({
        github: msg.event,
        action: msg.action,
        delivery: msg.deliveryId,
        receivedAt: msg.receivedAt,
        out,
      }),
    );
  } finally {
    await release();
  }
}
