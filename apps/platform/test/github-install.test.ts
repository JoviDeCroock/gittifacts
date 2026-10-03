import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGithubEvent } from "../src/github/consumer.js";
import { getInstallation, reposOf } from "../src/github/store.js";
import type { GithubEventMessage } from "../src/github/webhook.js";
import { CLIENT_SECRET, callEnv, jsonRes, seedApp, stubGithub } from "./github-helpers.js";
import { makeApp, signUpHuman } from "./http.js";
import { store } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

const API = "https://api.github.com";
const WEB = "https://github.com";
let nextInst = 5_000_000 + Math.floor(Math.random() * 100_000);

const installation = (id: number, appId: number) => ({
  id,
  app_id: appId,
  account: { login: "gf-test-org", id: 4242, type: "Organization" },
  repository_selection: "selected",
  permissions: { metadata: "read", checks: "write" },
  events: ["pull_request"],
  suspended_at: null,
});

describe("GitHub install: setup URL → user authorization → link", () => {
  const { app } = makeApp();

  async function setup(appId: number, installationId: number, cookie: string) {
    const res = await callEnv(app, {}, "GET", `/github/setup?installation_id=${installationId}&setup_action=install`, { cookie });
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(`${WEB}/login/oauth/authorize`);
    expect(to.searchParams.get("client_id")).toBe(`Iv23test${appId}`);
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost/github/oauth/callback");
    return to.searchParams.get("state")!;
  }

  function github(appId: number, visible: number[]) {
    return stubGithub({
      [`POST ${WEB}/login/oauth/access_token`]: async (req) => {
        const body = (await req.json()) as { client_secret: string; code: string };
        expect(body.client_secret).toBe(CLIENT_SECRET);
        return jsonRes({ access_token: "ghu_usertoken", token_type: "bearer" });
      },
      [`GET ${API}/user`]: () => jsonRes({ login: "octo-owner", id: 7 }),
      [`GET ${API}/user/installations`]: () =>
        jsonRes({ total_count: visible.length, installations: visible.map((i) => installation(i, appId)) }),
      ...Object.fromEntries(
        visible.map((i) => [
          `GET ${API}/user/installations/${i}/repositories`,
          () => jsonRes({ total_count: 1, repositories: [{ id: 101, full_name: "gf-test-org/bugfix", private: true }] }),
        ]),
      ),
      [`DELETE ${API}/applications/Iv23test${appId}/token`]: () => new Response(null, { status: 204 }),
    });
  }

  it("never trusts installation_id: an installation the user can't access is refused", async () => {
    const appId = await seedApp();
    const h = await signUpHuman(app);
    const forged = nextInst++;
    const state = await setup(appId, forged, h.cookie);
    const seen = github(appId, [nextInst++]);
    const res = await callEnv(app, {}, "GET", `/github/oauth/callback?code=c0de&state=${encodeURIComponent(state)}`, { cookie: h.cookie });
    expect(res.headers.get("location")).toBe("/settings/github?error=installation-not-yours");
    expect(await getInstallation(store().db, forged)).toBeNull();
    // The user token was revoked either way.
    expect(seen.some((s) => s.method === "DELETE" && s.url.includes("/token"))).toBe(true);
  });

  it("links a verified installation; the GitHub page lists it with its repos; the state is single-use", async () => {
    const appId = await seedApp();
    const h = await signUpHuman(app);
    const id = nextInst++;
    // The usual order: the installation webhook lands first and names the App.
    await handleGithubEvent(
      { db: store().db, blobs: env.BLOBS, now: () => new Date() },
      {
        v: 1, deliveryId: crypto.randomUUID(), appId, event: "installation", action: "created",
        installationId: id, receivedAt: new Date().toISOString(),
        payload: { action: "created", installation: installation(id, appId), repositories: [] },
      },
    );
    const state = await setup(appId, id, h.cookie);
    github(appId, [id]);
    const cb = `/github/oauth/callback?code=c0de&state=${encodeURIComponent(state)}`;
    const res = await callEnv(app, {}, "GET", cb, { cookie: h.cookie });
    expect(res.headers.get("location")).toBe(`/settings/github?linked=${id}`);
    const view = await callEnv(app, {}, "GET", "/api/v1/github", { cookie: h.cookie });
    const body = (await view.json()) as { installations: { id: number; linkedAs: string; repos: { fullName: string }[] }[] };
    expect(body.installations).toEqual([
      expect.objectContaining({ id, linkedAs: "octo-owner", repos: [expect.objectContaining({ fullName: "gf-test-org/bugfix" })] }),
    ]);
    const replay = await callEnv(app, {}, "GET", cb, { cookie: h.cookie });
    expect(replay.headers.get("location")).toBe("/settings/github?error=state-expired");
    // Someone else sees nothing.
    const other = await signUpHuman(app, "Eve");
    const theirs = (await (await callEnv(app, {}, "GET", "/api/v1/github", { cookie: other.cookie })).json()) as { installations: unknown[] };
    expect(theirs.installations).toEqual([]);
  });
});

describe("GITHUB_EVENTS consumer: installation events", () => {
  const deps = () => ({ db: store().db, blobs: env.BLOBS, now: () => new Date() });
  const msg = (appId: number, event: string, payload: unknown): GithubEventMessage => ({
    v: 1, deliveryId: crypto.randomUUID(), appId, event, action: null, installationId: null,
    receivedAt: new Date().toISOString(), payload,
  });

  it("created → repos added/removed → deleted", async () => {
    const appId = await seedApp();
    const id = nextInst++;
    const inst = installation(id, appId);
    await handleGithubEvent(deps(), msg(appId, "installation", {
      action: "created", installation: inst,
      repositories: [{ id: 1, full_name: "gf-test-org/a", private: false }, { id: 2, full_name: "gf-test-org/b", private: true }],
    }));
    expect((await reposOf(store().db, id)).map((r) => r.fullName)).toEqual(["gf-test-org/a", "gf-test-org/b"]);
    await handleGithubEvent(deps(), msg(appId, "installation_repositories", {
      action: "removed", installation: inst, repository_selection: "selected",
      repositories_added: [], repositories_removed: [{ id: 1, full_name: "gf-test-org/a" }],
    }));
    expect((await reposOf(store().db, id)).map((r) => r.fullName)).toEqual(["gf-test-org/b"]);
    // An event for another App's installation is ignored.
    await handleGithubEvent(deps(), msg(appId + 1, "installation", { action: "deleted", installation: inst }));
    expect((await getInstallation(store().db, id))?.deletedAt).toBeNull();
    await handleGithubEvent(deps(), msg(appId, "installation", { action: "deleted", installation: inst }));
    expect((await getInstallation(store().db, id))?.deletedAt).not.toBeNull();
    expect(await reposOf(store().db, id)).toEqual([]);
  });
});
