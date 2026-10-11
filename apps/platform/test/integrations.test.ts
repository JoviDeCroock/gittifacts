/**
 * External integrations, end to end with a mock deploy platform (docs/prompts/04-integrations.md
 * §Acceptance): register → OAuth install on one repo → clone through /git/ (push refused) →
 * signed push webhook for a new Change → successful preview deployment → signed `preview`
 * evidence on the Change → uninstall → token and webhooks stop.
 */
import { env } from "cloudflare:workers";
import type { Evidence } from "@app/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { webhookDeliveries } from "../src/db/schema.js";
import { deliver } from "../src/integrations/delivery.js";
import { emitPushEvent } from "../src/integrations/events.js";
import { deliveryDepsFromEnv, eventDepsFromEnv } from "../src/integrations/worker.js";
import { platformSigner } from "../src/signing.js";
import { changeFixture, evidenceFixture, HEAD_SHA, repoFixture, store } from "./fixtures.js";
import { call, json, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";
import {
  ADVERTISEMENT,
  basic,
  bytesText,
  CALLBACK,
  HOOK_URL,
  hmacHex,
  mockPlatform,
  PACK_RESULT,
  raw,
} from "./integrations-helpers.js";
import { pkce, postForm, seedRepos } from "./oauth-helpers.js";

const ZERO = "0".repeat(40);
const bindings = env as unknown as Bindings;

afterEach(() => vi.restoreAllMocks());

interface Registered {
  integration: { id: string; clientId: string };
  clientSecret: string;
  webhookSecret: string;
}

async function register(app: TestApp, cookie: string): Promise<Registered> {
  const res = await call(app, "POST", "/api/v1/integrations", {
    cookie,
    body: {
      name: "Mock Deploy",
      homepageUrl: "https://deploy.example",
      redirectUris: [CALLBACK],
      scopes: ["repo:read", "contents:read", "webhooks", "deployments:write"],
      webhook: {
        url: HOOK_URL,
        events: ["push", "change.created", "installation.created", "installation.deleted"],
      },
    },
  });
  expect(res.status).toBe(201);
  return json<Registered>(res);
}

async function install(app: TestApp, cookie: string, r: Registered, repoIds: string[]) {
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: r.integration.clientId,
    redirect_uri: CALLBACK,
    scope: "repo:read contents:read webhooks deployments:write",
    state: "st-9",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/api`,
  });
  const auth = await call(app, "GET", `/api/oauth/authorize?${q}`);
  expect(auth.status).toBe(302);
  const consent = new URL(auth.headers.get("location") ?? "");
  expect(consent.pathname).toBe("/integrations/install");
  const requestId = consent.searchParams.get("request") ?? "";
  const view = await json<{
    install: {
      scopes: { title: string }[];
      never: string[];
      repos: { id: string }[];
      existing: { installationId: string; scopes: string[] } | null;
    };
  }>(await call(app, "GET", `/api/v1/integration-installs/${requestId}`, { cookie }));
  const approve = await call(app, "POST", `/api/v1/integration-installs/${requestId}/approve`, {
    cookie,
    body: { repoSelection: "selected", repoIds },
  });
  expect(approve.status).toBe(200);
  const back = new URL((await json<{ redirectTo: string }>(approve)).redirectTo);
  expect(back.searchParams.get("state")).toBe("st-9");
  const tokenRes = await postForm(
    app,
    "/api/oauth/token",
    {
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      code_verifier: verifier,
      redirect_uri: CALLBACK,
    },
    { authorization: basic(r.integration.clientId, r.clientSecret) },
  );
  expect(tokenRes.status).toBe(200);
  const tokens = await json<{
    access_token: string;
    refresh_token: string;
    scope: string;
    installation_id: string;
  }>(tokenRes);
  return {
    view: view.install,
    tokens,
    installationId: back.searchParams.get("installation_id") ?? "",
  };
}

async function deliveriesOf(installationId: string, event: string) {
  return store()
    .db.select()
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.installationId, installationId), eq(webhookDeliveries.event, event)),
    )
    .all();
}

describe("external integrations (acceptance)", () => {
  it("installing again shows what the installation already granted (existing.scopes)", async () => {
    mockPlatform();
    const { app } = makeApp();
    const human = await signUpHuman(app, "Jo Again");
    const [repoA] = await seedRepos(1, human.principal.id);
    if (!repoA) throw new Error("seed failed");
    const reg = await register(app, human.cookie);
    const first = await install(app, human.cookie, reg, [repoA.id]);
    expect(first.view.existing).toBeNull();
    const again = await install(app, human.cookie, reg, [repoA.id]);
    expect(again.view.existing?.installationId).toBe(first.installationId);
    expect([...(again.view.existing?.scopes ?? [])].sort()).toEqual(
      ["contents:read", "deployments:write", "repo:read", "webhooks"].sort(),
    );
  });

  it("register → install one repo → clone (push refused) → signed push webhook → preview evidence → uninstall", async () => {
    const seen = mockPlatform();
    const { app } = makeApp();
    const human = await signUpHuman(app, "Jo Deploy");
    const [repoA, repoB] = await seedRepos(2, human.principal.id);
    if (!repoA || !repoB) throw new Error("seed failed");
    const unclaimed = repoFixture({
      claim: { status: "unclaimed", ownerId: null, expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await store().insertRepo(unclaimed);

    // 1. register
    const reg = await register(app, human.cookie);
    expect(reg.integration.clientId).toMatch(/^gtic_/);
    expect(reg.clientSecret).toMatch(/^gtis_/);
    expect(reg.webhookSecret).toMatch(/^whsec_/);

    // 2. OAuth install on repo A only
    const { view, tokens, installationId } = await install(app, human.cookie, reg, [repoA.id]);
    expect(view.scopes.map((s) => s.title)).toContain("Clone the code");
    expect(view.never).toContain("Push code or write any branch");
    expect(view.repos.map((r) => r.id).sort()).toEqual([repoA.id, repoB.id].sort());
    expect(view.repos.map((r) => r.id)).not.toContain(unclaimed.id);
    expect(tokens.access_token).toMatch(/^gti_/);
    expect(tokens.refresh_token).toMatch(/^gtir_/);
    expect(tokens.installation_id).toBe(installationId);
    expect((await deliveriesOf(installationId, "installation.created")).length).toBe(1);
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    const self = await json<{ repositories: { id: string; cloneUrl: string }[] }>(
      await raw(app, "GET", "/api/v1/installation", bearer),
    );
    expect(self.repositories.map((r) => r.id)).toEqual([repoA.id]);
    const cloneUrl = new URL(self.repositories[0]?.cloneUrl ?? "");
    expect(cloneUrl.pathname).toBe(`/git/jo-deploy/${repoA.name}.git`);

    // 3. git through the proxy with the token; push refused; repo B unreachable
    const gitAuth = { authorization: basic("x-access-token", tokens.access_token) };
    const refs = await raw(app, "GET", `${cloneUrl.pathname}/info/refs?service=git-upload-pack`, {
      ...gitAuth,
      "git-protocol": "version=2",
    });
    expect(refs.status).toBe(200);
    expect(refs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(bytesText(await refs.arrayBuffer())).toBe(ADVERTISEMENT);
    const pack = await raw(
      app,
      "POST",
      `${cloneUrl.pathname}/git-upload-pack`,
      { ...gitAuth, "content-type": "application/x-git-upload-pack-request" },
      "0032want bbbb\n00000009done\n",
    );
    expect(pack.status).toBe(200);
    expect(bytesText(await pack.arrayBuffer())).toBe(PACK_RESULT);
    expect(seen.minted).toEqual([
      { repo: repoA.artifactsName, scope: "read", ttl: 300 },
      { repo: repoA.artifactsName, scope: "read", ttl: 300 },
    ]);
    expect(
      seen.upstream.every(
        (u) => u.authorization === `Bearer art_v2_fake_${repoA.artifactsName}?expires=9999999999`,
      ),
    ).toBe(true);
    expect(seen.upstream[0]?.gitProtocol).toBe("version=2");
    expect(seen.upstream[1]?.body).toBe("0032want bbbb\n00000009done\n");
    for (const [method, path] of [
      ["GET", `${cloneUrl.pathname}/info/refs?service=git-receive-pack`],
      ["POST", `${cloneUrl.pathname}/git-receive-pack`],
    ] as const) {
      const push = await raw(app, method, path, gitAuth, method === "POST" ? "0000" : undefined);
      // git prints a text/plain error body as `remote:` lines (and drops JSON): the fix shows.
      expect(push.status).toBe(403);
      expect(push.headers.get("content-type")).toMatch(/^text\/plain/);
      const body = await push.text();
      expect(body).toContain("push refused (push-to-main)");
      expect(body).toContain("Only the merge queue writes main");
      expect(body).toContain('Fix: start_change({ repoId: "<repoId>"');
      expect(body).toContain("push <remote.url> HEAD:<remote.branch>");
      const header = JSON.parse(push.headers.get("x-gittifacts-error") ?? "{}");
      expect(header.code).toBe("push-to-main");
    }
    // Without credentials too: git's first request carries none, and must not get a prompt.
    const anonPush = await raw(
      app,
      "GET",
      `${cloneUrl.pathname}/info/refs?service=git-receive-pack`,
      {},
    );
    expect(anonPush.status).toBe(403);
    expect(await anonPush.text()).toContain("push-to-main");
    expect(
      (
        await raw(
          app,
          "GET",
          `/git/jo-deploy/${repoB.name}.git/info/refs?service=git-upload-pack`,
          gitAuth,
        )
      ).status,
    ).toBe(404);
    const anon = await raw(app, "GET", `${cloneUrl.pathname}/info/refs?service=git-upload-pack`);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Basic");
    expect(seen.minted.length).toBe(2);

    // 4. a new Change on repo A is pushed → signed `push` webhook to the deploy platform
    const change = changeFixture(repoA.id, human.principal.id, { status: "running", lane: 1 });
    await store().insertChange(change);
    const pushed = await emitPushEvent(eventDepsFromEnv(bindings), {
      repoName: change.forkName,
      ref: "refs/heads/main",
      before: ZERO,
      after: HEAD_SHA,
    });
    expect(pushed.length).toBe(1);
    const deliveryId = pushed[0] ?? "";
    await deliver(deliveryDepsFromEnv(bindings), deliveryId); // the queue consumer's step (skipped if it already ran)
    const hook = seen.hooks.find((h) => h.headers["x-gittifacts-delivery"] === deliveryId);
    if (!hook) throw new Error("push webhook not delivered");
    expect(hook.headers["x-gittifacts-event"]).toBe("push");
    expect(hook.headers["x-gittifacts-installation-id"]).toBe(installationId);
    expect(hook.headers["x-gittifacts-signature-256"]).toBe(
      `sha256=${await hmacHex(reg.webhookSecret, hook.body)}`,
    );
    expect(hook.headers["x-gittifacts-signature-256"]).not.toBe(
      `sha256=${await hmacHex("wrong-secret-0000", hook.body)}`,
    );
    const payload = JSON.parse(hook.body) as Record<string, unknown> & {
      change: { id: string };
      repository: { fullName: string };
    };
    expect(payload).toMatchObject({
      event: "push",
      kind: "change",
      ref: "refs/heads/main",
      sha: HEAD_SHA,
      after: HEAD_SHA,
    });
    expect(payload.cloneUrl).toBe(`${ORIGIN}/git/jo-deploy/${repoA.name}/changes/${change.id}.git`);
    expect(payload.change.id).toBe(change.id);
    expect(payload.repository.fullName).toBe(`jo-deploy/${repoA.name}`);
    const [row] = await store()
      .db.select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .all();
    expect(row?.status).toBe("delivered");
    // The Change's fork clones through the proxy too (its head, for the preview build).
    const fork = await raw(
      app,
      "GET",
      `/git/jo-deploy/${repoA.name}/changes/${change.id}.git/info/refs?service=git-upload-pack`,
      gitAuth,
    );
    expect(fork.status).toBe(200);
    expect(seen.minted.at(-1)?.repo).toBe(change.forkName);

    // 5. a successful preview deployment → signed `preview` evidence on the Change (lane untouched)
    const sealed = await evidenceFixture(change.id);
    await store().putEvidence(sealed);
    const dep = await raw(
      app,
      "POST",
      `/api/v1/repos/${repoA.id}/deployments`,
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ sha: HEAD_SHA, environment: "preview", changeId: change.id }),
    );
    expect(dep.status).toBe(201);
    const { deployment } = await json<{ deployment: { id: string; state: string } }>(dep);
    expect(deployment.state).toBe("pending");
    const ok = await raw(
      app,
      "POST",
      `/api/v1/deployments/${deployment.id}/statuses`,
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({
        state: "success",
        url: "https://pv-123.deploy.example",
        logUrl: "https://deploy.example/logs/123",
      }),
    );
    expect(ok.status).toBe(201);
    const after = await json<{
      deployment: { state: string; evidence: { status: string; itemId: string } };
    }>(ok);
    expect(after.deployment).toMatchObject({
      state: "success",
      evidence: { status: "attached", itemId: `preview:${reg.integration.id}` },
    });
    const ev = (await store().getEvidence(change.id, HEAD_SHA)) as Evidence;
    expect(ev.id).toBe(sealed.id);
    expect(ev.items.map((i) => i.id)).toEqual(["tests", `preview:${reg.integration.id}`]);
    expect(ev.items[1]).toMatchObject({
      kind: "preview",
      status: "ok",
      url: "https://pv-123.deploy.example",
      source: {
        kind: "integration",
        id: reg.integration.id,
        name: "Mock Deploy",
        deploymentId: deployment.id,
        logUrl: "https://deploy.example/logs/123",
      },
    });
    expect((await (await platformSigner(env as never)).verifyEvidence(ev)).ok).toBe(true);
    expect(ev.attestation.signature).not.toBe(sealed.attestation.signature);
    expect((await store().getChange(change.id))?.lane).toBe(1);

    // A production deployment of the default branch lands on the Change's rollout timeline.
    const prod = await json<{ deployment: { id: string } }>(
      await raw(
        app,
        "POST",
        `/api/v1/repos/${repoA.id}/deployments`,
        { ...bearer, "content-type": "application/json" },
        JSON.stringify({ sha: HEAD_SHA, environment: "production", changeId: change.id }),
      ),
    );
    await raw(
      app,
      "POST",
      `/api/v1/deployments/${prod.deployment.id}/statuses`,
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ state: "failure", logUrl: "https://deploy.example/logs/prod-1" }),
    );
    const rollout = await json<{ timeline: { action: string; summary?: string }[] }>(
      await call(app, "GET", `/api/v1/changes/${change.id}/rollout`, { cookie: human.cookie }),
    );
    const prodEvent = rollout.timeline.find((e) => e.action === "deployment.production");
    expect(prodEvent?.summary).toContain("https://deploy.example/logs/prod-1");

    // An integration token can never approve, review or reach MCP.
    const review = await raw(
      app,
      "POST",
      `/api/v1/changes/${change.id}/review`,
      { ...bearer, "content-type": "application/json" },
      JSON.stringify({ decision: "approve" }),
    );
    expect(review.status).toBe(403);
    const mcp = await raw(
      app,
      "POST",
      "/mcp",
      {
        ...bearer,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(mcp.status).toBe(401);

    // 6. uninstall → the token and webhooks stop immediately
    const un = await call(app, "POST", `/api/v1/installations/${installationId}/uninstall`, {
      cookie: human.cookie,
    });
    expect(un.status).toBe(200);
    expect((await json<{ installation: { status: string } }>(un)).installation.status).toBe(
      "deleted",
    );
    expect((await raw(app, "GET", "/api/v1/installation", bearer)).status).toBe(401);
    expect(
      (await raw(app, "GET", `${cloneUrl.pathname}/info/refs?service=git-upload-pack`, gitAuth))
        .status,
    ).toBe(401);
    const refresh = await postForm(
      app,
      "/api/oauth/token",
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      { authorization: basic(reg.integration.clientId, reg.clientSecret) },
    );
    expect(refresh.status).toBe(400);
    expect((await json<{ error: string }>(refresh)).error).toBe("invalid_grant");
    const hooksBefore = seen.hooks.length;
    expect(
      await emitPushEvent(eventDepsFromEnv(bindings), {
        repoName: change.forkName,
        ref: "refs/heads/main",
        before: HEAD_SHA,
        after: "c".repeat(40),
      }),
    ).toEqual([]);
    expect(
      await emitPushEvent(eventDepsFromEnv(bindings), {
        repoName: repoA.artifactsName,
        ref: "refs/heads/main",
        before: ZERO,
        after: "c".repeat(40),
      }),
    ).toEqual([]);
    expect((await deliveriesOf(installationId, "installation.deleted")).length).toBe(1);
    expect(seen.hooks.length).toBe(hooksBefore);
  });
});
