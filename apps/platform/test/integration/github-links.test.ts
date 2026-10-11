/**
 * GitHub links in workerd (security audit 2026-10-11): what linking an installation grants (H1:
 * per repo, from what the user's token sees and with what access, never the whole installation),
 * and who counts as a pull request's author (M4: GitHub's numeric user id, never the login).
 * The real setup flow and API over the real coordinator facade; GitHub's API is stubbed.
 */
import { env } from "cloudflare:workers";
import { repoIdFor } from "@app/host-github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberRole } from "../../src/access/members-store.js";
import { githubInstallationLinks } from "../../src/db/github-schema.js";
import { handleGithubEvent } from "../../src/github/consumer.js";
import { ensureGithubPrincipal, grantInstallationMembers } from "../../src/github/grading.js";
import { githubActorPrincipal } from "../../src/github/plans.js";
import { addRepos, linksSeeingRepo, upsertInstallation } from "../../src/github/store.js";
import { addMember, changeFixture, repoFixture, store } from "../fixtures.js";
import { APP_ID, CLIENT_ID, callEnv, jsonRes, stubGithub } from "../github-helpers.js";
import { expectError, signUpHuman, type TestApp } from "../http.js";
import { platformApp } from "./harness.js";

afterEach(() => vi.restoreAllMocks());

const API = "https://api.github.com";
const WEB = "https://github.com";
let next = 7_100_000 + Math.floor(Math.random() * 100_000);

type Perms = {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
};
const PULL: Perms = { admin: false, maintain: false, push: false, triage: false, pull: true };
const PUSH: Perms = { ...PULL, push: true };
const ADMIN: Perms = { admin: true, maintain: true, push: true, triage: true, pull: true };

const account = (login: string, id: number, type: "Organization" | "User") => ({ login, id, type });

function installation(id: number, acct: ReturnType<typeof account>) {
  return {
    id,
    app_id: APP_ID,
    account: acct,
    repository_selection: "selected" as const,
    permissions: { metadata: "read", checks: "write" },
    events: ["pull_request"],
    suspended_at: null,
  };
}

const ghHost = (repoId: number, installationId: number, owner: string) => ({
  kind: "github" as const,
  owner,
  repo: `r${repoId}`,
  githubRepoId: repoId,
  installationId,
  appId: APP_ID,
  private: true,
});

/** A repo of the installation graded here (as GithubSync's first PR would make it). */
async function graded(
  repoId: number,
  installationId: number,
  owner: string,
  ownerId: string | null = null,
) {
  const repo = repoFixture({
    id: repoIdFor(repoId),
    name: `${owner}/r${repoId}`,
    artifactsName: `ghm-${repoId}`,
    host: ghHost(repoId, installationId, owner),
    claim: { status: "claimed", ownerId, expiresAt: null },
  });
  await store().insertRepo(repo);
  return repo;
}

/** The setup URL → GitHub's user authorization → our callback, as a browser walks it. */
async function link(
  app: TestApp,
  cookie: string,
  inst: ReturnType<typeof installation>,
  user: { login: string; id: number },
  visible: { id: number; permissions?: Perms }[],
) {
  const setup = await callEnv(
    app,
    {},
    "GET",
    `/github/setup?installation_id=${inst.id}&setup_action=install`,
    { cookie },
  );
  expect(setup.status).toBe(303);
  const state = new URL(setup.headers.get("location")!).searchParams.get("state")!;
  const nonce = /^gh_install_nonce=([^;]+)/.exec(setup.headers.get("set-cookie") ?? "")![1]!;
  const owner = inst.account.login;
  stubGithub({
    [`POST ${WEB}/login/oauth/access_token`]: () =>
      jsonRes({ access_token: "ghu_usertoken", token_type: "bearer" }),
    [`GET ${API}/user`]: () => jsonRes(user),
    [`GET ${API}/user/installations`]: () => jsonRes({ total_count: 1, installations: [inst] }),
    [`GET ${API}/user/installations/${inst.id}/repositories`]: () =>
      jsonRes({
        total_count: visible.length,
        repositories: visible.map((r) => ({
          id: r.id,
          full_name: `${owner}/r${r.id}`,
          private: true,
          permissions: r.permissions,
        })),
      }),
    [`DELETE ${API}/applications/${CLIENT_ID}/token`]: () => new Response(null, { status: 204 }),
  });
  const res = await callEnv(
    app,
    {},
    "GET",
    `/github/oauth/callback?code=c0de&state=${encodeURIComponent(state)}`,
    {
      cookie: `${cookie}; gh_install_nonce=${nonce}`,
    },
  );
  expect(res.headers.get("location")).toBe(`/settings/github?linked=${inst.id}`);
  vi.restoreAllMocks();
}

const ownerOf = async (repoId: number) =>
  (await store().getRepo(repoIdFor(repoId)))?.claim.ownerId ?? null;
const roleOn = (repoId: number, principalId: string) =>
  memberRole(store(), repoIdFor(repoId), principalId);

describe("linking an installation grants per repo, from the user's own GitHub access (H1)", () => {
  it("a collaborator of some repos gets those repos at their GitHub access; nothing else of the installation", async () => {
    const app = platformApp();
    const inst = installation(next++, account("acme-h1", 4242, "Organization"));
    const [pull, push, admin, hidden, theirs, kept, laterHidden, laterPush, laterAdmin] = [
      next++,
      next++,
      next++,
      next++,
      next++,
      next++,
      next++,
      next++,
      next++,
    ] as const;
    // The installation covers every repo; the webhook recorded them all.
    await upsertInstallation(
      store().db,
      {
        id: inst.id,
        appId: APP_ID,
        account: inst.account,
        repositorySelection: "selected",
        permissions: inst.permissions,
        events: inst.events,
        suspendedAt: null,
      },
      new Date(),
    );
    await addRepos(
      store().db,
      inst.id,
      [pull, push, admin, hidden, theirs, kept, laterHidden, laterPush, laterAdmin].map((id) => ({
        id,
        fullName: `acme-h1/r${id}`,
        private: true,
      })),
      new Date(),
    );
    const someone = await signUpHuman(app, "Owner");
    const outsider = await signUpHuman(app, "Outsider");
    for (const id of [pull, push, admin, hidden, kept]) await graded(id, inst.id, "acme-h1");
    await graded(theirs, inst.id, "acme-h1", someone.principal.id);
    // A membership someone set by hand is never lowered by a link.
    await addMember(store(), repoIdFor(kept), outsider.principal.id, "maintainer");

    await link(app, outsider.cookie, inst, { login: "outsider", id: 9101 }, [
      { id: pull, permissions: PULL },
      { id: push, permissions: PUSH },
      { id: admin, permissions: ADMIN },
      { id: theirs, permissions: ADMIN },
      { id: kept, permissions: PULL },
      { id: laterPush, permissions: PUSH },
      { id: laterAdmin, permissions: ADMIN },
    ]);
    const me = outsider.principal.id;
    expect([await ownerOf(pull), await roleOn(pull, me)]).toEqual([null, "reader"]);
    expect([await ownerOf(push), await roleOn(push, me)]).toEqual([null, "maintainer"]);
    expect(await ownerOf(admin)).toBe(me);
    expect([await ownerOf(theirs), await roleOn(theirs, me)]).toEqual([
      someone.principal.id,
      "maintainer",
    ]);
    expect(await roleOn(kept, me)).toBe("maintainer");
    // The repo their token didn't list: nothing, and the API says so.
    expect([await ownerOf(hidden), await roleOn(hidden, me)]).toEqual([null, null]);
    const read = await callEnv(app, {}, "GET", `/api/v1/repos/${repoIdFor(hidden)}`, {
      cookie: outsider.cookie,
    });
    expect([403, 404]).toContain(read.status);
    expect(
      (
        await callEnv(app, {}, "GET", `/api/v1/repos/${repoIdFor(pull)}`, {
          cookie: outsider.cookie,
        })
      ).status,
    ).toBe(200);
    // The GitHub page lists only the repos they saw.
    const view = (await (
      await callEnv(app, {}, "GET", "/api/v1/github", { cookie: outsider.cookie })
    ).json()) as {
      installations: { id: number; repos: { id: number }[] }[];
    };
    const listed = view.installations
      .find((i) => i.id === inst.id)
      ?.repos.map((r) => r.id)
      .sort();
    expect(listed).toEqual([pull, push, admin, theirs, kept, laterPush, laterAdmin].sort());

    // Repos graded after the link: only those the link saw, at its access.
    for (const id of [laterHidden, laterPush, laterAdmin]) {
      await grantInstallationMembers(store(), await graded(id, inst.id, "acme-h1"), inst.id);
    }
    expect([await ownerOf(laterHidden), await roleOn(laterHidden, me)]).toEqual([null, null]);
    expect([await ownerOf(laterPush), await roleOn(laterPush, me)]).toEqual([null, "maintainer"]);
    expect(await ownerOf(laterAdmin)).toBe(me);

    // A repo that leaves the installation takes every link's access to it along.
    expect(await linksSeeingRepo(store().db, inst.id, laterPush)).toHaveLength(1);
    await handleGithubEvent(
      { db: store().db, blobs: env.BLOBS, now: () => new Date() },
      {
        v: 1,
        deliveryId: crypto.randomUUID(),
        appId: APP_ID,
        event: "installation_repositories",
        action: "removed",
        installationId: inst.id,
        receivedAt: new Date().toISOString(),
        payload: {
          action: "removed",
          installation: inst,
          repository_selection: "selected",
          repositories_added: [],
          repositories_removed: [{ id: laterPush, full_name: `acme-h1/r${laterPush}` }],
        },
      },
    );
    expect(await linksSeeingRepo(store().db, inst.id, laterPush)).toEqual([]);
  });

  it("the personal account the App is installed on administers its repos, whatever the listing says", async () => {
    const app = platformApp();
    const inst = installation(next++, account("solo-dev", 9202, "User"));
    const repo = next++;
    await graded(repo, inst.id, "solo-dev");
    const solo = await signUpHuman(app, "Solo");
    await link(app, solo.cookie, inst, { login: "solo-dev", id: 9202 }, [{ id: repo }]);
    expect(await ownerOf(repo)).toBe(solo.principal.id);
  });
});

describe("who authored a pull request: GitHub's user id, never the login (M4)", () => {
  async function linkRow(
    principalId: string,
    installationId: number,
    login: string,
    githubUserId: number | null,
  ) {
    await store().db.insert(githubInstallationLinks).values({
      installationId,
      principalId,
      githubLogin: login,
      githubUserId,
      linkedAt: new Date().toISOString(),
    });
  }

  it("a renamed author can't review their own PR here; a link without an id can't either; others can", async () => {
    const app = platformApp();
    const inst = next++;
    const owner = await signUpHuman(app, "Owner");
    const alice = await signUpHuman(app, "Alice");
    const bob = await signUpHuman(app, "Bob");
    const carol = await signUpHuman(app, "Carol");
    const repo = await graded(next++, inst, "acme-m4", owner.principal.id);
    for (const h of [alice, bob, carol])
      await addMember(store(), repo.id, h.principal.id, "maintainer");
    // Alice linked as "alice-old" (id 5150), then renamed herself on GitHub to "alice-new".
    await linkRow(alice.principal.id, inst, "alice-old", 5150);
    await linkRow(bob.principal.id, inst, "bob", 6160);
    // Carol linked before ids were recorded (migration 0024): who she is on GitHub is unknown.
    await linkRow(carol.principal.id, inst, "carol", null);
    const n = 7;
    // The PR's author principal, as GithubSync made it when "alice-new" opened the PR.
    const authorId = await ensureGithubPrincipal(store(), {
      kind: "human",
      id: "5150",
      login: "alice-new",
    });
    const change = changeFixture(repo.id, authorId, {
      id: `gh-${repo.host!.githubRepoId}-${n}`,
      forkName: `ghm-${repo.host!.githubRepoId}`,
      host: {
        kind: "github",
        number: n,
        headBranch: `gittifacts/pr/${n}`,
        fork: false,
        headRepo: null,
        baseRef: "main",
        author: { login: "alice-new", id: 5150, kind: "human" },
        url: `https://github.com/acme-m4/r${repo.host!.githubRepoId}/pull/${n}`,
      },
    });
    await store().insertChange(change);
    const review = (cookie: string) =>
      callEnv(app, {}, "POST", `/api/v1/changes/${change.id}/review`, {
        cookie,
        body: { decision: "approve" },
      });

    await expectError(await review(alice.cookie), 403, "self-approval");
    await expectError(await review(carol.cookie), 403, "self-approval");
    const byBob = await review(bob.cookie);
    const bobBody = (await byBob.json()) as { error?: { code?: string } };
    expect(bobBody.error?.code).not.toBe("self-approval");
  });

  it("GitHub activity is attributed by id: a re-registered old login is someone else", async () => {
    const s = store();
    const app = platformApp();
    const inst = next++;
    const dana = await signUpHuman(app, "Dana");
    const erin = await signUpHuman(app, "Erin");
    await linkRow(dana.principal.id, inst, "dana-old", 7310);
    await linkRow(erin.principal.id, inst, "erin", null);
    // Dana under her new login is still Dana.
    expect(await githubActorPrincipal(s, { kind: "human", id: "7310", login: "dana-new" })).toBe(
      dana.principal.id,
    );
    // Whoever registered Dana's old login is not.
    expect(await githubActorPrincipal(s, { kind: "human", id: "7311", login: "dana-old" })).toBe(
      "gh-u-7311",
    );
    // A link without an id attributes nobody to its human, even with the same login.
    expect(await githubActorPrincipal(s, { kind: "human", id: "7312", login: "erin" })).toBe(
      "gh-u-7312",
    );
  });
});
