/**
 * Security audit 2026-10-11 (Low findings) for external integrations, through the real app and D1:
 * deployment reads need repo access, the token exchange needs the authorization's redirect_uri,
 * and webhooks never point at IP literals, internal names, the platform or its previews.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/app-env.js";
import { integrations, webhookDeliveries } from "../src/db/schema.js";
import { deliver } from "../src/integrations/delivery.js";
import { deliveryDepsFromEnv } from "../src/integrations/worker.js";
import { HEAD_SHA, store } from "./fixtures.js";
import { call, createAgent, json, makeApp, signUpHuman, type TestApp } from "./http.js";
import { CALLBACK, HOOK_URL, mockPlatform, raw } from "./integrations-helpers.js";
import { pkce, postForm, seedRepos } from "./oauth-helpers.js";

const bindings = env as unknown as Bindings;
afterEach(() => vi.restoreAllMocks());

async function register(app: TestApp, cookie: string, webhookUrl: string = HOOK_URL) {
  return call(app, "POST", "/api/v1/integrations", {
    cookie,
    body: {
      name: "Hardening Deploy",
      homepageUrl: "https://deploy.example",
      redirectUris: [CALLBACK],
      clientType: "public",
      scopes: ["repo:read", "webhooks", "deployments:write"],
      webhook: { url: webhookUrl, events: ["push"] },
    },
  });
}

/** authorize → approve → the one-time code (not yet exchanged). */
async function codeFor(app: TestApp, cookie: string, clientId: string, repoIds: string[]) {
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const loc = new URL(
    (await call(app, "GET", `/api/oauth/authorize?${q}`)).headers.get("location") ?? "",
  );
  const ok = await call(
    app,
    "POST",
    `/api/v1/integration-installs/${loc.searchParams.get("request")}/approve`,
    { cookie, body: { repoSelection: "selected", repoIds } },
  );
  expect(ok.status).toBe(200);
  const back = new URL((await json<{ redirectTo: string }>(ok)).redirectTo);
  return { code: back.searchParams.get("code") ?? "", verifier };
}

describe("integration hardening", () => {
  it("the token exchange requires the authorization's redirect_uri; a refused exchange does not burn the code", async () => {
    mockPlatform();
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Redi Rect");
    const [repo] = await seedRepos(1, dev.principal.id);
    if (!repo) throw new Error("seed");
    const reg = await json<{ integration: { clientId: string } }>(await register(app, dev.cookie));
    const clientId = reg.integration.clientId;
    const { code, verifier } = await codeFor(app, dev.cookie, clientId, [repo.id]);
    const base = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
    };

    const missing = await postForm(app, "/api/oauth/token", base);
    expect(missing.status).toBe(400);
    expect((await json<{ error: string }>(missing)).error).toBe("invalid_request");
    const wrong = await postForm(app, "/api/oauth/token", {
      ...base,
      redirect_uri: "https://deploy.example/other",
    });
    expect(wrong.status).toBe(400);
    expect((await json<{ error: string }>(wrong)).error).toBe("invalid_grant");
    const right = await postForm(app, "/api/oauth/token", { ...base, redirect_uri: CALLBACK });
    expect(right.status).toBe(200);
  });

  it("GET /api/v1/deployments/{id} needs read on the deployment's repo: anyone else gets the 404 of an unknown id", async () => {
    mockPlatform();
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Dep Loyer");
    const outsider = await signUpHuman(app, "Out Sider");
    const outsiderAgent = await createAgent(app, outsider.cookie);
    const [repo] = await seedRepos(1, dev.principal.id);
    if (!repo) throw new Error("seed");
    const reg = await json<{ integration: { clientId: string } }>(await register(app, dev.cookie));
    const { code, verifier } = await codeFor(app, dev.cookie, reg.integration.clientId, [repo.id]);
    const tokens = await json<{ access_token: string }>(
      await postForm(app, "/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: reg.integration.clientId,
        redirect_uri: CALLBACK,
      }),
    );
    const created = await raw(
      app,
      "POST",
      `/api/v1/repos/${repo.id}/deployments`,
      { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
      JSON.stringify({ sha: HEAD_SHA, environment: "preview" }),
    );
    expect(created.status).toBe(201);
    const id = (await json<{ deployment: { id: string } }>(created)).deployment.id;
    const path = `/api/v1/deployments/${id}`;

    expect((await call(app, "GET", path, { cookie: dev.cookie })).status).toBe(200);
    for (const who of [{ cookie: outsider.cookie }, { token: outsiderAgent.token }]) {
      const res = await call(app, "GET", path, who);
      expect(res.status).toBe(404);
      const unknown = await call(app, "GET", "/api/v1/deployments/dep_nope", who);
      expect(unknown.status).toBe(404);
    }
    // The repo list route agrees: the outsider cannot list the repo's deployments either.
    expect(
      (await call(app, "GET", `/api/v1/repos/${repo.id}/deployments`, { cookie: outsider.cookie }))
        .status,
    ).toBe(404);
  });

  it("webhooks refuse IP literals, localhost, internal names, the platform and its previews, at registration and at delivery", async () => {
    const seen = mockPlatform();
    const { app } = makeApp();
    const dev = await signUpHuman(app, "Hook Er");
    for (const url of [
      "https://127.0.0.1/hook",
      "https://2130706433/hook",
      "https://[::1]/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/hook",
      "https://metadata/hook",
      "https://db.internal/hook",
      "https://printer.local/hook",
      "https://p-abc123-pv.resynapse.dev/hook",
    ]) {
      const res = await register(app, dev.cookie, url);
      expect(res.status, url).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("invalid-request");
    }
    const ok = await register(app, dev.cookie);
    expect(ok.status).toBe(201);
    const reg = await json<{ integration: { id: string } }>(ok);
    const patch = await call(app, "PATCH", `/api/v1/integrations/${reg.integration.id}`, {
      cookie: dev.cookie,
      body: { webhook: { url: "https://10.0.0.1/hook" } },
    });
    expect(patch.status).toBe(400);

    // A row that already points somewhere refused (written before this check): delivery cancels
    // it without sending anything.
    await store()
      .db.update(integrations)
      .set({ webhookUrl: "https://127.0.0.1/hook" })
      .where(eq(integrations.id, reg.integration.id));
    const pinged = await call(app, "POST", `/api/v1/integrations/${reg.integration.id}/ping`, {
      cookie: dev.cookie,
    });
    expect(pinged.status).toBe(202);
    const deliveryId = (await json<{ delivery: { id: string } }>(pinged)).delivery.id;
    const sent: string[] = [];
    await deliver(
      {
        ...deliveryDepsFromEnv(bindings),
        fetch: async (input) => {
          sent.push(String(input));
          return new Response("ok");
        },
      },
      deliveryId,
    );
    expect(sent).toEqual([]);
    expect(seen.hooks).toEqual([]);
    const row = await store()
      .db.select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .get();
    expect(row?.status).toBe("cancelled");
    expect(row?.error).toContain("webhook url refused");
  });
});
