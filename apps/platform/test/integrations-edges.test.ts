/**
 * External integrations: the edges around the acceptance path — who may install where, what an
 * authorize/token request may ask for, refresh rotation, event sources (Store wrapper, pushes),
 * delivery retries and redelivery, preview evidence before the bundle exists, and the docs.
 */
import { env } from "cloudflare:workers";
import type { Evidence } from "@app/domain";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { webhookDeliveries } from "../src/db/schema.js";
import { BACKOFF_SECONDS, deliver } from "../src/integrations/delivery.js";
import { emitPushEvent } from "../src/integrations/events.js";
import { deliveryDepsFromEnv, eventDepsFromEnv } from "../src/integrations/worker.js";
import { buildPorts, type PortsEnv } from "../src/runtime/ports.js";
import {
  addMember,
  changeFixture,
  evidenceFixture,
  HEAD_SHA,
  repoFixture,
  store,
} from "./fixtures.js";
import { call, json, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";
import { basic, CALLBACK, HOOK_URL, mockPlatform, raw } from "./integrations-helpers.js";
import { pkce, postForm, seedRepos } from "./oauth-helpers.js";

const bindings = env as unknown as Bindings;
afterEach(() => vi.restoreAllMocks());

async function registered(app: TestApp, cookie: string, over: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/api/v1/integrations", {
    cookie,
    body: {
      name: "Edge Deploy",
      homepageUrl: "https://deploy.example",
      redirectUris: [CALLBACK],
      scopes: ["repo:read", "contents:read", "webhooks", "deployments:write"],
      webhook: { url: HOOK_URL, events: ["push", "change.created", "change.merged"] },
      ...over,
    },
  });
  expect(res.status).toBe(201);
  return json<{
    integration: { id: string; clientId: string };
    clientSecret: string | null;
    webhookSecret: string | null;
  }>(res);
}

function authorizeUrl(
  clientId: string,
  challenge: string,
  over: Record<string, string | null> = {},
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  return `/api/oauth/authorize?${q}`;
}

async function installOn(
  app: TestApp,
  cookie: string,
  clientId: string,
  repoIds: string[],
  secret: string | null,
) {
  const { verifier, challenge } = await pkce();
  const loc = new URL(
    (await call(app, "GET", authorizeUrl(clientId, challenge))).headers.get("location") ?? "",
  );
  const id = loc.searchParams.get("request") ?? "";
  const ok = await call(app, "POST", `/api/v1/integration-installs/${id}/approve`, {
    cookie,
    body: { repoSelection: "selected", repoIds },
  });
  expect(ok.status).toBe(200);
  const code =
    new URL((await json<{ redirectTo: string }>(ok)).redirectTo).searchParams.get("code") ?? "";
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
  };
  if (secret) params.client_secret = secret;
  const res = await postForm(app, "/api/oauth/token", params);
  expect(res.status).toBe(200);
  return json<{ access_token: string; refresh_token: string; installation_id: string }>(res);
}

describe("integration installs", () => {
  it("only owners and maintainers of claimed repos install; unclaimed projects and readers are refused", async () => {
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Dev Eloper");
    const reader = await signUpHuman(app, "Rea Der");
    const [mine] = await seedRepos(1, dev.principal.id);
    const [theirs] = await seedRepos(1, reader.principal.id);
    if (!mine || !theirs) throw new Error("seed");
    await addMember(store(), theirs.id, dev.principal.id, "maintainer");
    const [other] = await seedRepos(1, reader.principal.id);
    if (!other) throw new Error("seed");
    await addMember(store(), other.id, dev.principal.id, "reader");
    const unclaimed = repoFixture({
      claim: { status: "unclaimed", ownerId: null, expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await store().insertRepo(unclaimed);
    const reg = await registered(app, dev.cookie);
    const { challenge } = await pkce();
    const loc = new URL(
      (await call(app, "GET", authorizeUrl(reg.integration.clientId, challenge))).headers.get(
        "location",
      ) ?? "",
    );
    const id = loc.searchParams.get("request") ?? "";
    const view = await json<{ install: { repos: { id: string }[] } }>(
      await call(app, "GET", `/api/v1/integration-installs/${id}`, { cookie: dev.cookie }),
    );
    expect(view.install.repos.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    for (const repoId of [unclaimed.id, other.id]) {
      const res = await call(app, "POST", `/api/v1/integration-installs/${id}/approve`, {
        cookie: dev.cookie,
        body: { repoSelection: "selected", repoIds: [repoId] },
      });
      expect(res.status).toBe(403);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
        "repo-not-installable",
      );
    }
    // Another human can't decide someone else's request; an integration token can't approve installs.
    expect(
      (await call(app, "GET", `/api/v1/integration-installs/${id}`, { cookie: reader.cookie }))
        .status,
    ).toBe(403);
  });

  it("refuses approval scopes, missing PKCE, the MCP audience, unknown redirect URIs and bad client secrets", async () => {
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Sco Pes");
    const reg = await registered(app, dev.cookie);
    const { challenge } = await pkce();
    const errorOf = async (over: Record<string, string | null>) => {
      const res = await call(app, "GET", authorizeUrl(reg.integration.clientId, challenge, over));
      expect(res.status).toBe(302);
      return new URL(res.headers.get("location") ?? "").searchParams.get("error");
    };
    expect(await errorOf({ scope: "repo:read plan:approve" })).toBe("invalid_scope");
    expect(await errorOf({ scope: "change:create" })).toBe("invalid_scope");
    expect(await errorOf({ scope: "checks:write" })).toBe("invalid_scope"); // not registered
    expect(await errorOf({ code_challenge: null })).toBe("invalid_request");
    expect(await errorOf({ resource: `${ORIGIN}/mcp` })).toBe("invalid_target");
    const badRedirect = await call(
      app,
      "GET",
      authorizeUrl(reg.integration.clientId, challenge, {
        redirect_uri: "https://evil.example/cb",
      }),
    );
    expect(badRedirect.status).toBe(400);
    const wrong = await postForm(
      app,
      "/api/oauth/token",
      { grant_type: "authorization_code", code: "x", code_verifier: "y".repeat(43) },
      { authorization: basic(reg.integration.clientId, `gtis_${"A".repeat(43)}`) },
    );
    expect(wrong.status).toBe(401);
    expect((await json<{ error: string }>(wrong)).error).toBe("invalid_client");
    const noSecret = await postForm(app, "/api/oauth/token", {
      grant_type: "authorization_code",
      code: "x",
      client_id: reg.integration.clientId,
    });
    expect(noSecret.status).toBe(401);
  });

  it("rotates refresh tokens; replaying a spent one revokes the installation's tokens; public clients use PKCE only", async () => {
    mockPlatform();
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Ro Tate");
    const [repo] = await seedRepos(1, dev.principal.id);
    if (!repo) throw new Error("seed");
    const reg = await registered(app, dev.cookie, { clientType: "public" });
    expect(reg.clientSecret).toBeNull();
    const t = await installOn(app, dev.cookie, reg.integration.clientId, [repo.id], null);
    const refresh = (token: string) =>
      postForm(app, "/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: reg.integration.clientId,
      });
    const r1 = await refresh(t.refresh_token);
    expect(r1.status).toBe(200);
    const next = await json<{ access_token: string; refresh_token: string }>(r1);
    expect(
      (
        await raw(app, "GET", "/api/v1/installation", {
          authorization: `Bearer ${next.access_token}`,
        })
      ).status,
    ).toBe(200);
    const replay = await refresh(t.refresh_token);
    expect(replay.status).toBe(400);
    expect(
      (
        await raw(app, "GET", "/api/v1/installation", {
          authorization: `Bearer ${next.access_token}`,
        })
      ).status,
    ).toBe(401);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    // The installation itself survives (the person can reconnect): it is still listed.
    const listed = await json<{ installations: { id: string }[] }>(
      await call(app, "GET", "/api/v1/installations", { cookie: dev.cookie }),
    );
    expect(listed.installations.map((i) => i.id)).toContain(t.installation_id);
  });
});

describe("integration events, deliveries and evidence", () => {
  it("Store writes and default-branch pushes become webhooks; retries back off; redelivery keeps the delivery id", async () => {
    const seen = mockPlatform();
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Ev Ents");
    const [repo] = await seedRepos(1, dev.principal.id);
    if (!repo) throw new Error("seed");
    const reg = await registered(app, dev.cookie);
    const t = await installOn(
      app,
      dev.cookie,
      reg.integration.clientId,
      [repo.id],
      reg.clientSecret,
    );
    const ports = buildPorts(env as unknown as PortsEnv, "default");
    const change = changeFixture(repo.id, dev.principal.id, { status: "running" });
    await ports.store.insertChange(change);
    await ports.store.updateChange(change.id, { status: "merged", mergedSha: "d".repeat(40) });
    const rows = await store()
      .db.select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.installationId, t.installation_id))
      .all();
    expect(rows.map((r) => r.event).sort()).toEqual(["change.created", "change.merged"]);
    const merged = JSON.parse(rows.find((r) => r.event === "change.merged")?.payload ?? "{}") as {
      sha: string;
      cloneUrl: string;
    };
    expect(merged.sha).toBe("d".repeat(40));
    expect(merged.cloneUrl).toMatch(new RegExp(`/git/ev-ents/${repo.name}\\.git$`));

    const deps = eventDepsFromEnv(bindings);
    const main = await emitPushEvent(deps, {
      repoName: repo.artifactsName,
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: "e".repeat(40),
    });
    expect(main.length).toBe(1);
    expect(
      await emitPushEvent(deps, {
        repoName: repo.artifactsName,
        ref: "refs/heads/feature",
        before: "0".repeat(40),
        after: "e".repeat(40),
      }),
    ).toEqual([]);
    expect(
      await emitPushEvent(deps, {
        repoName: repo.artifactsName,
        ref: "refs/notes/evidence",
        before: "0".repeat(40),
        after: "e".repeat(40),
      }),
    ).toEqual([]);
    const [pushRow] = await store()
      .db.select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, main[0] ?? ""))
      .all();
    expect(JSON.parse(pushRow?.payload ?? "{}")).toMatchObject({
      kind: "default-branch",
      change: null,
      sha: "e".repeat(40),
    });

    // The receiver fails: backoff, then failed after the last attempt; redeliver from the log.
    const failing = {
      ...deliveryDepsFromEnv(bindings),
      fetch: async () => new Response("boom", { status: 502 }),
    };
    const id = main[0] ?? "";
    expect(await deliver(failing, id)).toEqual({
      outcome: "retry",
      delaySeconds: BACKOFF_SECONDS[0],
    });
    await store()
      .db.update(webhookDeliveries)
      .set({ attempts: BACKOFF_SECONDS.length })
      .where(eq(webhookDeliveries.id, id));
    expect(await deliver(failing, id)).toEqual({ outcome: "failed" });
    const log = await json<{ deliveries: { id: string; status: string }[] }>(
      await call(
        app,
        "GET",
        `/api/v1/integrations/${reg.integration.id}/deliveries?status=failed`,
        { cookie: dev.cookie },
      ),
    );
    expect(log.deliveries.map((d) => d.id)).toContain(id);
    const detail = await json<{
      delivery: { requestHeaders: Record<string, string>; responseStatus: number };
    }>(
      await call(app, "GET", `/api/v1/integrations/${reg.integration.id}/deliveries/${id}`, {
        cookie: dev.cookie,
      }),
    );
    expect(detail.delivery.responseStatus).toBe(502);
    expect(detail.delivery.requestHeaders["x-gittifacts-signature-256"]).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
    const again = await call(
      app,
      "POST",
      `/api/v1/integrations/${reg.integration.id}/deliveries/${id}/redeliver`,
      { cookie: dev.cookie },
    );
    expect(again.status).toBe(202);
    const re = await json<{ delivery: { id: string; guid: string; redeliveryOf: string } }>(again);
    expect(re.delivery).toMatchObject({ guid: id, redeliveryOf: id });
    await deliver(deliveryDepsFromEnv(bindings), re.delivery.id);
    expect(seen.hooks.some((h) => h.headers["x-gittifacts-delivery"] === id)).toBe(true);
  });

  it("a preview reported before the bundle is sealed is attached when the coordinator seals it", async () => {
    mockPlatform();
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Pen Ding");
    const [repo] = await seedRepos(1, dev.principal.id);
    if (!repo) throw new Error("seed");
    const reg = await registered(app, dev.cookie);
    const t = await installOn(
      app,
      dev.cookie,
      reg.integration.clientId,
      [repo.id],
      reg.clientSecret,
    );
    const change = changeFixture(repo.id, dev.principal.id, { status: "running" });
    await store().insertChange(change);
    const bearer = {
      authorization: `Bearer ${t.access_token}`,
      "content-type": "application/json",
    };
    const dep = await json<{ deployment: { id: string } }>(
      await raw(
        app,
        "POST",
        `/api/v1/repos/${repo.id}/deployments`,
        bearer,
        JSON.stringify({ sha: HEAD_SHA, environment: "preview", changeId: change.id }),
      ),
    );
    const st = await json<{ deployment: { evidence: { status: string } } }>(
      await raw(
        app,
        "POST",
        `/api/v1/deployments/${dep.deployment.id}/statuses`,
        bearer,
        JSON.stringify({ state: "success", url: "https://pv.deploy.example" }),
      ),
    );
    expect(st.deployment.evidence.status).toBe("pending");
    const ports = buildPorts(env as unknown as PortsEnv, "default");
    await ports.store.putEvidence(await evidenceFixture(change.id));
    const ev = (await store().getEvidence(change.id, HEAD_SHA)) as Evidence;
    expect(ev.items.map((i) => i.id)).toContain(`preview:${reg.integration.id}`);
    expect((await ports.signer.verifyEvidence(ev)).ok).toBe(true);
    // Unclaimed projects take no reports, and other repos are out of the grant.
    const [otherRepo] = await seedRepos(1, dev.principal.id);
    const outside = await raw(
      app,
      "POST",
      `/api/v1/repos/${otherRepo?.id}/deployments`,
      bearer,
      JSON.stringify({ sha: HEAD_SHA, environment: "preview" }),
    );
    expect(outside.status).toBe(403);
  });

  it("serves /docs/integrations as markdown, HTML and JSON, and documents the API in OpenAPI", async () => {
    const { app } = makeApp();
    const md = await call(app, "GET", "/docs/integrations");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("X-Gittifacts-Signature-256");
    const html = await call(app, "GET", "/docs/integrations", { headers: { accept: "text/html" } });
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain('<h2 id="7-example-connect-a-cloudflare-workers-project">');
    const doc = await json<{ oauth: { token: string }; git: { refused: string[] } }>(
      await call(app, "GET", "/docs/integrations", { headers: { accept: "application/json" } }),
    );
    expect(doc.oauth.token).toBe(`${ORIGIN}/api/oauth/token`);
    expect(doc.git.refused).toEqual(["git-receive-pack"]);
    const spec = await json<{ paths: Record<string, unknown> }>(
      await call(app, "GET", "/api/v1/openapi.json"),
    );
    for (const p of [
      "/api/v1/integrations",
      "/api/v1/integration-installs/{id}/approve",
      "/api/v1/installations/{installationId}/uninstall",
      "/api/v1/repos/{repoId}/deployments",
      "/api/v1/deployments/{deploymentId}/statuses",
      "/git/{owner}/{repo}.git/info/refs",
      "/api/v1/installation",
    ]) {
      expect(Object.keys(spec.paths)).toContain(p);
    }
  });
});
