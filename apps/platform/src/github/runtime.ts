/**
 * GitHub mode on Cloudflare: the App's credentials (Worker config, app-config.ts), per-job
 * installation tokens, the per-installation write gate (a Durable Object) and the D1 check-run
 * index, assembled into a `GitHubHost` for one repository. Both the queue consumer (mirror sync)
 * and the ChangeWorkflow (publishing the verdict) build hosts here.
 *
 * Tokens: minted lazily per job, scoped to the one repository with the least permissions the
 * job needs, revoked when the job ends; never logged, never handed to a sandbox (the sandbox
 * reads the Artifacts mirror with an Artifacts read token).
 */
import type { Ports } from "@app/coordinator";
import type { GithubRepoHost } from "@app/domain";
import {
  type AppCredentials,
  type CheckRunIndex,
  GitHubHost,
  GithubApi,
  type GithubSource,
  InstallationTokens,
  JobToken,
  mirrorNameFor,
  type Permissions,
  repoIdFor,
  WriteGovernor,
} from "@app/host-github";
import { and, eq } from "drizzle-orm";
import type { Bindings } from "../app-env.js";
import { githubCheckRuns } from "../db/github-schema.js";
import { platformOrigin } from "../integrations/runtime.js";
import { D1Store, type Db } from "../store/d1-store.js";
import { appForId } from "./app-config.js";
import { d1PrIndex, prWritesEnabled } from "./pr-index.js";
import { durableWriteGate, type GithubWriteGate } from "./write-gate-do.js";

/** What a grading job may do on GitHub: read the PR and code, write its own check run. */
export const HOST_PERMISSIONS: Permissions = {
  checks: "write",
  contents: "read",
  // M3: the tour review and the summary comment (when PR writes are on for the repo).
  pull_requests: "write",
  issues: "read",
  metadata: "read",
};
/** What a mirror fetch may do: read code. */
export const FETCH_PERMISSIONS: Permissions = { contents: "read", metadata: "read" };

export interface GithubRuntimeBindings {
  GITHUB_WRITE_GATE?: DurableObjectNamespace<GithubWriteGate>;
}

/** The App's id, client id and private key, from Worker config (null when not configured). */
export function appCredentials(env: Bindings, appId: number): AppCredentials | null {
  const app = appForId(env as unknown as Record<string, unknown>, appId);
  return app === null
    ? null
    : { appId: app.appId, clientId: app.clientId, privateKey: app.privateKey };
}

const tokenSources = new Map<string, InstallationTokens>();

/** Token minting for one of our Apps (the JWT is cached per isolate until it nearly expires). */
function tokensFor(env: Bindings, appId: number): InstallationTokens {
  const c = appCredentials(env, appId);
  if (c === null) throw new Error(`GitHub App ${appId} is not configured on this platform`);
  const key = `${c.appId}:${c.clientId}:${c.privateKey.length}`;
  let t = tokenSources.get(key);
  if (t === undefined) {
    t = new InstallationTokens(c);
    tokenSources.set(key, t);
  }
  return t;
}

export function d1CheckRunIndex(db: Db, now: () => Date = () => new Date()): CheckRunIndex {
  return {
    async get(changeId, headSha) {
      const row = await db
        .select({ id: githubCheckRuns.checkRunId })
        .from(githubCheckRuns)
        .where(and(eq(githubCheckRuns.changeId, changeId), eq(githubCheckRuns.headSha, headSha)))
        .get();
      return row?.id ?? null;
    },
    async put(changeId, headSha, checkRunId) {
      await db
        .insert(githubCheckRuns)
        .values({ changeId, headSha, checkRunId, createdAt: now().toISOString() })
        .onConflictDoUpdate({
          target: [githubCheckRuns.changeId, githubCheckRuns.headSha],
          set: { checkRunId },
        });
    },
  };
}

/** A `GitHubHost` for one repository; `release` ends its job (revokes the token, if minted). */
export function githubHostFor(
  env: Bindings,
  ports: Pick<Ports, "store" | "git" | "clock">,
  repo: GithubRepoHost,
): { host: GitHubHost; api: GithubApi; release(): Promise<void> } {
  const db = new D1Store(env.DB, env.BLOBS, () => new Date()).db;
  let job: JobToken | null = null;
  const token = async () => {
    job ??= new JobToken(tokensFor(env, repo.appId), repo.installationId, {
      repositoryIds: [repo.githubRepoId],
      permissions: HOST_PERMISSIONS,
    });
    return job.value();
  };
  const release = async () => {
    const j = job;
    job = null;
    await j?.release();
  };
  const ns = (env as GithubRuntimeBindings).GITHUB_WRITE_GATE;
  const api = new GithubApi({
    token,
    governor: ns === undefined ? new WriteGovernor() : durableWriteGate(ns, repo.installationId),
  });
  const host = new GitHubHost({
    repoId: repoIdFor(repo.githubRepoId),
    mirror: mirrorNameFor(repo.githubRepoId),
    repo,
    api,
    ports,
    checks: d1CheckRunIndex(db),
    origin: platformOrigin(env),
    onJobEnd: release,
    prs: d1PrIndex(db),
    prWrites: () => prWritesEnabled(db, repoIdFor(repo.githubRepoId), repo.installationId),
  });
  return { host, api, release };
}

/** A GitHub remote readable for one fetch: a contents-read token for this one repo, revoked after. */
export async function githubReadSource(env: Bindings, repo: GithubRepoHost): Promise<GithubSource> {
  const tokens = tokensFor(env, repo.appId);
  const t = await tokens.mint(repo.installationId, {
    repositoryIds: [repo.githubRepoId],
    permissions: FETCH_PERMISSIONS,
  });
  return {
    remote: {
      url: `https://github.com/${repo.owner}/${repo.repo}.git`,
      auth: { basic: { username: "x-access-token", password: t.value() } },
    },
    release: async () => void (await tokens.revoke(t)),
  };
}
