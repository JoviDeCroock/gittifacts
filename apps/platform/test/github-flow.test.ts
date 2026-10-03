import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { githubKeys, openCredential } from "../src/github/crypto.js";
import { consumeState, createState, getApp, STATE_TTL_MS } from "../src/github/store.js";
import { callEnv, jsonRes, newAppId, stubGithub } from "./github-helpers.js";
import { makeApp, signUpHuman } from "./http.js";
import { store } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

const API = "https://api.github.com";

describe("GitHub App manifest flow", () => {
  const { app } = makeApp();

  async function admin() {
    const h = await signUpHuman(app, "Admin");
    return { ...h, over: { PLATFORM_ADMINS: h.principal.id } };
  }

  it("only platform admins get a manifest; it targets the org and the live host", async () => {
    const someone = await signUpHuman(app);
    const denied = await callEnv(app, {}, "POST", "/api/v1/github/manifests", { cookie: someone.cookie, body: {} });
    expect(denied.status).toBe(403);
    const a = await admin();
    const res = await callEnv(app, a.over, "POST", "/api/v1/github/manifests", {
      cookie: a.cookie,
      body: { org: "gf-test-org", name: "gittifacts-dev" },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { action: string; manifest: string; state: string; name: string };
    expect(out.action).toBe(
      `https://github.com/organizations/gf-test-org/settings/apps/new?state=${encodeURIComponent(out.state)}`,
    );
    const m = JSON.parse(out.manifest);
    expect(m).toMatchObject({
      name: "gittifacts-dev",
      public: true,
      hook_attributes: { url: "http://localhost/github/webhooks", active: true },
      redirect_url: "http://localhost/github/manifest/callback",
      setup_url: "http://localhost/github/setup",
      callback_urls: ["http://localhost/github/oauth/callback"],
      request_oauth_on_install: false,
    });
    expect(m.default_permissions).toEqual({
      metadata: "read", contents: "read", pull_requests: "write", checks: "write", issues: "read",
      merge_queues: "read", deployments: "read", statuses: "read",
    });
    expect(m.default_events).toEqual(expect.arrayContaining(["merge_group", "deployment_status", "status", "pull_request"]));
    // A user-account App, default name; the Actor App stays off until M5.
    const user = await callEnv(app, a.over, "POST", "/api/v1/github/manifests", { cookie: a.cookie, body: {} });
    const u = (await user.json()) as { action: string; name: string };
    expect(u.action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(u.name).toBe("gittifacts");
    const actor = await callEnv(app, a.over, "POST", "/api/v1/github/manifests", {
      cookie: a.cookie,
      body: { kind: "actor", org: "gf-test-org" },
    });
    expect(actor.status).toBe(403);
    const tooLong = await callEnv(app, a.over, "POST", "/api/v1/github/manifests", {
      cookie: a.cookie,
      body: { name: "x".repeat(35) },
    });
    expect(tooLong.status).toBe(400);
  });

  it("the callback stores sealed credentials once; a replayed or forged state is refused", async () => {
    const a = await admin();
    const start = await callEnv(app, a.over, "POST", "/api/v1/github/manifests", { cookie: a.cookie, body: {} });
    const { state } = (await start.json()) as { state: string };
    const id = newAppId();
    const seen = stubGithub({
      [`POST ${API}/app-manifests/abc123/conversions`]: () =>
        jsonRes({
          id, slug: `gittifacts-${id}`, name: "gittifacts", owner: { login: "jovi", id: 1, type: "User" },
          client_id: "Iv23abc", client_secret: "cs-plain", webhook_secret: "wh-plain",
          pem: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n",
          html_url: `https://github.com/apps/gittifacts-${id}`,
          permissions: { metadata: "read", checks: "write" }, events: ["pull_request"],
        }, 201),
    });
    const cb = `/github/manifest/callback?code=abc123&state=${encodeURIComponent(state)}`;
    const res = await callEnv(app, a.over, "GET", cb, { cookie: a.cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/settings/github?created=gittifacts-${id}`);
    expect(seen).toHaveLength(1);
    const row = await getApp(store().db, id);
    expect(JSON.stringify(row)).not.toMatch(/cs-plain|wh-plain|BEGIN RSA/);
    const keys = await githubKeys((env as Bindings).GITHUB_APP_KEK);
    expect(await openCredential(keys, id, "webhook_secret", row!.webhookSecretEnc)).toBe("wh-plain");
    // Replay: the state was consumed.
    const again = await callEnv(app, a.over, "GET", cb, { cookie: a.cookie });
    expect(again.headers.get("location")).toBe("/settings/github?error=state-expired");
    const forged = await callEnv(app, a.over, "GET", "/github/manifest/callback?code=abc123&state=AAAAAAAAAAAAAAAAAAAA.x", { cookie: a.cookie });
    expect(forged.headers.get("location")).toBe("/settings/github?error=state-invalid");
    expect(seen).toHaveLength(1);
  });

  it("another person's state is refused; signed-out browsers are sent to sign in first", async () => {
    const a = await admin();
    const start = await callEnv(app, a.over, "POST", "/api/v1/github/manifests", { cookie: a.cookie, body: {} });
    const { state } = (await start.json()) as { state: string };
    const other = await signUpHuman(app, "Mallory");
    const cb = `/github/manifest/callback?code=abc&state=${encodeURIComponent(state)}`;
    const res = await callEnv(app, { PLATFORM_ADMINS: other.principal.id }, "GET", cb, { cookie: other.cookie });
    expect(res.headers.get("location")).toBe("/settings/github?error=state-not-yours");
    const anon = await callEnv(app, {}, "GET", cb);
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe(`/signin?next=${encodeURIComponent(cb)}`);
  });

  it("states expire after an hour and are single-use", async () => {
    const db = store().db;
    const t0 = new Date("2026-10-03T10:00:00Z");
    const row = { purpose: "manifest" as const, principalId: "hu_x", data: {}, createdAt: t0.toISOString() };
    const exp = new Date(t0.getTime() + STATE_TTL_MS).toISOString();
    await createState(db, { ...row, id: "state-expiry-0001", expiresAt: exp });
    expect(await consumeState(db, "state-expiry-0001", "manifest", new Date(t0.getTime() + STATE_TTL_MS + 1))).toBeNull();
    await createState(db, { ...row, id: "state-replay-0001", expiresAt: exp });
    expect(await consumeState(db, "state-replay-0001", "install", t0)).toBeNull();
    expect(await consumeState(db, "state-replay-0001", "manifest", t0)).not.toBeNull();
    expect(await consumeState(db, "state-replay-0001", "manifest", t0)).toBeNull();
  });
});
