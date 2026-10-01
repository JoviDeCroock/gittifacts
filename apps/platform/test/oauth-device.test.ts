/**
 * RFC 8628 device flow for CLIs, on better-auth's device-authorization plugin: the code is
 * approved on /device by a human and exchanged at /api/oauth/token for an agent token bound to a
 * new agent principal. better-auth's own session-minting endpoints are unreachable.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, expectError, json, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";
import {
  API_RESOURCE,
  DEVICE_GRANT,
  expectOAuthError,
  MCP_RESOURCE,
  postForm,
  rawMcp,
  seedRepos,
  type TokenResponse,
} from "./oauth-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function requestCode(
  app: TestApp,
  params: Record<string, string> = {},
): Promise<DeviceCodeResponse> {
  const res = await postForm(app, "/api/auth/device/code", {
    client_id: "gittifacts-cli",
    scope: "repo:read change:create",
    ...params,
  });
  expect(res.status).toBe(200);
  return json<DeviceCodeResponse>(res);
}

/** The plugin enforces the polling interval; pretend the last poll was long ago. */
async function forgetLastPoll(deviceCode: string): Promise<void> {
  await env.DB.prepare("UPDATE device_code SET last_polled_at = NULL WHERE device_code = ?")
    .bind(deviceCode)
    .run();
}

function poll(app: TestApp, deviceCode: string, clientId = "gittifacts-cli") {
  return postForm(app, "/api/oauth/token", {
    grant_type: DEVICE_GRANT,
    device_code: deviceCode,
    client_id: clientId,
  });
}

describe("device flow (RFC 8628)", () => {
  it("code → human approves on /device → agent token for a new principal, scoped to the repo", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app, "Maya");
    const [repoX, repoY] = await seedRepos(2);

    const dc = await requestCode(app);
    expect(dc.verification_uri).toBe(`${ORIGIN}/device`);
    expect(dc.verification_uri_complete).toBe(`${ORIGIN}/device?user_code=${dc.user_code}`);
    expect(dc.interval).toBe(5);
    expect(dc.expires_in).toBe(900);

    await expectOAuthError(await poll(app, dc.device_code), 400, "authorization_pending");

    // The human opens /device and sees what is being granted.
    const view = await json<{ consent: Record<string, unknown> }>(
      await call(app, "GET", `/api/v1/oauth/device/${dc.user_code}`, { cookie: human.cookie }),
    );
    expect(view.consent).toMatchObject({
      flow: "device_code",
      status: "pending",
      client: { id: "gittifacts-cli", name: "gittifacts CLI", kind: "first-party", host: null },
      requestedScopes: ["repo:read", "change:create"],
      audience: [
        { uri: MCP_RESOURCE, label: "MCP server" },
        { uri: API_RESOURCE, label: "HTTP API" },
      ],
    });

    const approved = await call(app, "POST", `/api/v1/oauth/device/${dc.user_code}/approve`, {
      cookie: human.cookie,
      body: { scopes: ["repo:read", "change:create"], repoIds: [repoX!.id], sessionDays: 1 },
    });
    expect(approved.status).toBe(200);
    expect(await json(approved)).toEqual({ status: "approved" });

    // Polling faster than the interval is slow_down (the plugin's state machine).
    await expectOAuthError(await poll(app, dc.device_code), 400, "slow_down");
    await forgetLastPoll(dc.device_code);
    const tokRes = await poll(app, dc.device_code);
    expect(tokRes.status).toBe(200);
    const tokens = await json<TokenResponse>(tokRes);
    expect(tokens.access_token).toMatch(/^gtf_/);
    expect(tokens.refresh_token).toMatch(/^gtr_/);
    expect(tokens.scope).toBe("repo:read change:create");

    // Works on the HTTP API and on MCP (device tokens cover both), as a new agent principal.
    const caps = await json<{
      principal: { id: string; kind: string; ownerId: string; repoIds: string[] | null };
      repos: { id: string }[];
      canApprove: boolean;
    }>(await call(app, "GET", "/api/v1/capabilities", { token: tokens.access_token }));
    expect(caps.principal).toMatchObject({
      kind: "agent",
      ownerId: human.principal.id,
      repoIds: [repoX!.id],
    });
    expect(caps.canApprove).toBe(false);
    expect(caps.repos.map((r) => r.id)).toEqual([repoX!.id]);
    expect(caps.repos.map((r) => r.id)).not.toContain(repoY!.id);
    const mcp = await rawMcp(app, tokens.access_token);
    expect(mcp.status).toBe(200);
    await mcp.text();

    // The code is consumed.
    await forgetLastPoll(dc.device_code);
    await expectOAuthError(await poll(app, dc.device_code), 400, "invalid_grant");
  });

  it("a device code never becomes a better-auth session: /device/token, /approve, /deny are gone", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const dc = await requestCode(app);
    for (const path of [
      "/api/auth/device/token",
      "/api/auth/device/approve",
      "/api/auth/device/deny",
    ]) {
      const res = await call(app, "POST", path, {
        cookie: human.cookie,
        body: {
          grant_type: DEVICE_GRANT,
          device_code: dc.device_code,
          client_id: "gittifacts-cli",
          userCode: dc.user_code,
        },
      });
      expect(res.status).toBe(404);
      await res.text();
    }
    const verify = await call(app, "GET", `/api/auth/device?user_code=${dc.user_code}`, {
      cookie: human.cookie,
    });
    expect(verify.status).toBe(404);
    await verify.text();
    // Still pending: nothing above approved it.
    await expectOAuthError(await poll(app, dc.device_code), 400, "authorization_pending");
  });

  it("deny → access_denied; wrong client_id → invalid_grant", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const dc = await requestCode(app);
    await expectOAuthError(await poll(app, dc.device_code, "someone-else"), 400, "invalid_grant");
    const res = await call(app, "POST", `/api/v1/oauth/device/${dc.user_code}/deny`, {
      cookie: human.cookie,
    });
    expect(await json(res)).toEqual({ status: "denied" });
    await forgetLastPoll(dc.device_code);
    await expectOAuthError(await poll(app, dc.device_code), 400, "access_denied");
  });

  it("a device code belongs to the first human who opens it; codes are case/dash tolerant", async () => {
    const { app } = makeApp();
    const maya = await signUpHuman(app, "Maya");
    const eve = await signUpHuman(app, "Eve");
    const dc = await requestCode(app);
    const dashed = `${dc.user_code.slice(0, 4).toLowerCase()}-${dc.user_code.slice(4).toLowerCase()}`;
    const ok = await call(app, "GET", `/api/v1/oauth/device/${dashed}`, { cookie: maya.cookie });
    expect(ok.status).toBe(200);
    await ok.text();
    await expectError(
      await call(app, "GET", `/api/v1/oauth/device/${dc.user_code}`, { cookie: eve.cookie }),
      403,
      "forbidden",
    );
    await expectError(
      await call(app, "GET", "/api/v1/oauth/device/ZZZZZZZZ", { cookie: maya.cookie }),
      404,
      "not-found",
    );
  });

  it("device code requests are validated: unknown client, bad resource, user_id pre-binding", async () => {
    const { app } = makeApp();
    for (const [params, error] of [
      [{ client_id: "random-cli" }, "invalid_client"],
      [{ resource: "https://evil.example/mcp" }, "invalid_target"],
      [{ user_id: "someone" }, "invalid_request"],
    ] as const) {
      const res = await postForm(app, "/api/auth/device/code", {
        client_id: "gittifacts-cli",
        ...params,
      });
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toBe(error);
    }
  });

  it("a device token requested for the HTTP API only is refused by /mcp", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const dc = await requestCode(app, { resource: API_RESOURCE });
    await call(app, "GET", `/api/v1/oauth/device/${dc.user_code}`, { cookie: human.cookie }).then(
      (r) => r.text(),
    );
    const ok = await call(app, "POST", `/api/v1/oauth/device/${dc.user_code}/approve`, {
      cookie: human.cookie,
      body: { scopes: ["repo:read"], repoIds: [repo!.id], sessionDays: 1 },
    });
    expect(ok.status).toBe(200);
    await ok.text();
    const tokens = await json<TokenResponse>(await poll(app, dc.device_code));
    const res = await rawMcp(app, tokens.access_token);
    expect(res.status).toBe(401);
    await res.text();
  });
});
