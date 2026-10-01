/**
 * MCP OAuth (authorization code + PKCE S256) end to end: protected resource metadata discovery →
 * authorize → consent → token → MCP call, plus every rejection the MCP 2026-07-28 profile needs.
 */
import { env } from "cloudflare:workers";
import { parseToolError } from "@app/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeFixture, classificationFixture, HEAD_SHA, store } from "./fixtures.js";
import { call, expectError, json, makeApp, ORIGIN, signUpHuman } from "./http.js";
import {
  API_RESOURCE,
  approveRequest,
  authorizeQuery,
  CLIENT_ID,
  cimdDocument,
  connectClient,
  expectOAuthError,
  MCP_RESOURCE,
  mcpClient,
  mockCimd,
  pkce,
  postForm,
  REDIRECT,
  rawMcp,
  seedRepos,
  startAuthorize,
  type TokenResponse,
} from "./oauth-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discovery", () => {
  it("/mcp without a token answers 401 with the RFC 9728 resource_metadata challenge", async () => {
    const { app } = makeApp();
    const res = await rawMcp(app);
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="repo:read plan:create change:create"`,
    );
    await expectError(res, 401, "unauthorized");
  });

  it('an invalid token gets error="invalid_token" in the challenge', async () => {
    const { app } = makeApp();
    const res = await rawMcp(app, `gtf_${"x".repeat(43)}`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(
      /^Bearer error="invalid_token", resource_metadata="[^"]+", scope="[^"]+", error_description="/,
    );
    await res.text();
  });

  it("serves protected resource metadata (path form, root fallback, HTTP API)", async () => {
    const { app } = makeApp();
    for (const [path, resource] of [
      ["/.well-known/oauth-protected-resource/mcp", MCP_RESOURCE],
      ["/.well-known/oauth-protected-resource", MCP_RESOURCE],
      ["/.well-known/oauth-protected-resource/api", API_RESOURCE],
    ] as const) {
      const res = await call(app, "GET", path);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const doc = await json<Record<string, unknown>>(res);
      expect(doc).toMatchObject({
        resource,
        authorization_servers: [ORIGIN],
        scopes_supported: ["repo:read", "plan:create", "change:create"],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("serves RFC 8414 authorization server metadata with S256, CIMD and no DCR", async () => {
    const { app } = makeApp();
    const res = await call(app, "GET", "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const md = await json<Record<string, unknown>>(res);
    expect(md).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      device_authorization_endpoint: `${ORIGIN}/api/auth/device/code`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["repo:read", "plan:create", "change:create"],
    });
    expect(md.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ]);
    expect(md).not.toHaveProperty("registration_endpoint");
  });
});

describe("authorization code + PKCE → MCP", () => {
  it("discovery → authorize → consent → token → MCP call, scoped to the approved repo", async () => {
    const { app } = makeApp();
    const { seen } = mockCimd();
    const human = await signUpHuman(app, "Maya");
    const [repoX, repoY] = await seedRepos(2);
    const s = store();
    const changeX = changeFixture(repoX!.id, human.principal.id);
    const changeY = changeFixture(repoY!.id, human.principal.id);
    await s.insertChange(changeX);
    await s.insertChange(changeY);
    await s.putClassification(changeX.id, HEAD_SHA, classificationFixture());

    // 1. The client hits /mcp and follows the challenge to the metadata.
    const challenge = await rawMcp(app);
    const prmUrl = /resource_metadata="([^"]+)"/.exec(
      challenge.headers.get("www-authenticate") ?? "",
    )?.[1];
    await challenge.text();
    const prm = await json<{ authorization_servers: string[]; resource: string }>(
      await call(app, "GET", new URL(prmUrl ?? "").pathname),
    );
    expect(prm.resource).toBe(MCP_RESOURCE);
    const as = await json<{ authorization_endpoint: string; token_endpoint: string }>(
      await call(app, "GET", "/.well-known/oauth-authorization-server"),
    );
    expect(as.authorization_endpoint).toBe(`${prm.authorization_servers[0]}/api/oauth/authorize`);

    // 2. authorize (the client's metadata document is fetched) → consent screen.
    const { verifier, challenge: codeChallenge } = await pkce();
    const requestId = await startAuthorize(app, { challenge: codeChallenge, state: "xyz" });
    expect(seen).toEqual([CLIENT_ID]);

    // 3. The consent screen says who asks for what.
    const view = await json<{ consent: Record<string, unknown> }>(
      await call(app, "GET", `/api/v1/oauth/requests/${requestId}`, { cookie: human.cookie }),
    );
    expect(view.consent).toMatchObject({
      flow: "authorization_code",
      status: "pending",
      client: { id: CLIENT_ID, name: "Example MCP Client", host: "client.example", kind: "cimd" },
      redirectHost: "client.example",
      requestedScopes: ["repo:read", "change:create"],
      audience: [{ uri: MCP_RESOURCE, label: "MCP server" }],
      grantableScopes: ["repo:read", "plan:create", "change:create"],
      neverScopes: ["repo:admin", "plan:approve", "change:review", "policy:admin"],
      sessionDayChoices: [1, 7, 30, 90],
    });
    expect((view.consent.repos as { id: string }[]).map((r) => r.id)).toEqual(
      expect.arrayContaining([repoX!.id, repoY!.id]),
    );

    // 4. The human approves "open Changes on repo X".
    const { code, redirect } = await approveRequest(app, human.cookie, requestId, {
      repoIds: [repoX!.id],
    });
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);

    // 5. Token exchange with the PKCE verifier.
    const tokRes = await postForm(app, "/api/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    });
    expect(tokRes.status).toBe(200);
    expect(tokRes.headers.get("cache-control")).toBe("no-store");
    const tokens = await json<TokenResponse>(tokRes);
    expect(tokens).toMatchObject({ token_type: "Bearer", scope: "repo:read change:create" });
    expect(tokens.access_token).toMatch(/^gtf_/);
    expect(tokens.refresh_token).toMatch(/^gtr_/);
    expect(tokens.expires_in).toBeGreaterThan(3500);

    // 6. MCP works, as a new agent principal owned by the human, on repo X only.
    const mcp = await mcpClient(app, tokens.access_token);
    try {
      const who = await mcp.tools.whoami();
      if (who.isError) throw new Error(JSON.stringify(who.content));
      expect(who.structuredContent).toMatchObject({ kind: "agent", canApprove: false });
      expect(who.structuredContent.repos.map((r) => r.id)).toEqual([repoX!.id]);
      expect(who.structuredContent.principalId).not.toBe(human.principal.id);

      const ok = await mcp.tools.get_change_status({ changeId: changeX.id });
      expect(ok.isError).toBeFalsy();
      const denied = await mcp.tools.get_change_status({ changeId: changeY.id });
      expect(denied.isError).toBe(true);
      const err = parseToolError((denied.content as { text: string }[])[0]!.text);
      expect(err?.error.code).toBe("repo-not-granted");
      expect(err?.error.fix.explanation).toMatch(/approve a new session/);
    } finally {
      await mcp.client.close();
    }

    // The principal is an agent owned by the human, limited to repo X.
    const row = await env.DB.prepare(
      "SELECT p.kind, p.owner_id, p.repo_ids, p.scopes FROM agent_sessions s JOIN principals p ON p.id = s.principal_id WHERE s.owner_id = ?",
    )
      .bind(human.principal.id)
      .first<{ kind: string; owner_id: string; repo_ids: string; scopes: string }>();
    expect(row).toMatchObject({ kind: "agent", owner_id: human.principal.id });
    expect(JSON.parse(row!.repo_ids)).toEqual([repoX!.id]);
    expect(JSON.parse(row!.scopes)).toEqual(["repo:read", "change:create"]);
  });

  it("each authorization becomes its own agent principal", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const a = await connectClient(app, human.cookie, { repoIds: [repo!.id] });
    const b = await connectClient(app, human.cookie, { repoIds: null });
    const sessions = await json<{ sessions: { principalId: string; repoIds: string[] | null }[] }>(
      await call(app, "GET", "/api/v1/agent-sessions", { cookie: human.cookie }),
    );
    expect(sessions.sessions).toHaveLength(2);
    expect(new Set(sessions.sessions.map((s) => s.principalId)).size).toBe(2);
    expect(sessions.sessions.map((s) => s.repoIds)).toEqual(
      expect.arrayContaining([[repo!.id], null]),
    );
    expect(a.access_token).not.toBe(b.access_token);
  });

  it("refresh rotates; replaying a rotated refresh token revokes the whole session", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const first = await connectClient(app, human.cookie, { repoIds: [repo!.id] });

    const refreshed = await postForm(app, "/api/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CLIENT_ID,
    });
    expect(refreshed.status).toBe(200);
    const second = await json<TokenResponse>(refreshed);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await rawMcp(app, second.access_token)).status).toBe(200);

    // Narrowing is allowed, widening is not.
    const narrowed = await postForm(app, "/api/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: second.refresh_token,
      client_id: CLIENT_ID,
      scope: "repo:read",
    });
    expect(narrowed.status).toBe(200);
    const third = await json<TokenResponse>(narrowed);
    expect(third.scope).toBe("repo:read");
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: third.refresh_token,
        client_id: CLIENT_ID,
        scope: "repo:read plan:create",
      }),
      400,
      "invalid_scope",
    );

    // Replay of the first (rotated) refresh token: theft signal → session revoked.
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: CLIENT_ID,
      }),
      400,
      "invalid_grant",
    );
    const dead = await rawMcp(app, third.access_token);
    expect(dead.status).toBe(401);
    await dead.text();
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: third.refresh_token,
        client_id: CLIENT_ID,
      }),
      400,
      "invalid_grant",
    );
  });

  it("an authorization code works once; a second redemption revokes what the first created", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const { verifier, challenge } = await pkce();
    const id = await startAuthorize(app, { challenge });
    const { code } = await approveRequest(app, human.cookie, id, { repoIds: [repo!.id] });
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    };
    const ok = await postForm(app, "/api/oauth/token", params);
    expect(ok.status).toBe(200);
    const tokens = await json<TokenResponse>(ok);
    await expectOAuthError(await postForm(app, "/api/oauth/token", params), 400, "invalid_grant");
    const res = await rawMcp(app, tokens.access_token);
    expect(res.status).toBe(401);
    await res.text();
  });
});

describe("rejections", () => {
  it("PKCE is required: missing challenge or plain method are refused before consent", async () => {
    const { app } = makeApp();
    mockCimd();
    for (const [challenge, method] of [
      ["", "S256"],
      ["a".repeat(43), "plain"],
      ["a".repeat(43), null],
    ] as const) {
      const res = await call(
        app,
        "GET",
        `/api/oauth/authorize?${authorizeQuery({ challenge, method })}`,
      );
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("error_description")).toMatch(/S256|PKCE/);
      expect(loc.searchParams.get("state")).toBe("st-1");
      expect(loc.searchParams.get("iss")).toBe(ORIGIN);
    }
    const n = await env.DB.prepare(
      "SELECT count(*) AS n FROM oauth_requests WHERE client_id = ? AND status = 'pending' AND code_challenge IS NULL",
    )
      .bind(CLIENT_ID)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("the token endpoint refuses a missing or wrong code_verifier", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const { challenge } = await pkce();
    const id = await startAuthorize(app, { challenge });
    const { code } = await approveRequest(app, human.cookie, id, { repoIds: [repo!.id] });
    const base = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
    };
    await expectOAuthError(await postForm(app, "/api/oauth/token", base), 400, "invalid_request");
    const other = await pkce();
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", { ...base, code_verifier: other.verifier }),
      400,
      "invalid_grant",
    );
  });

  it("a resource other than this MCP server or API is refused at authorize and at token", async () => {
    const { app } = makeApp();
    mockCimd();
    const res = await call(
      app,
      "GET",
      `/api/oauth/authorize?${authorizeQuery({ challenge: "a".repeat(43), resource: "https://evil.example/mcp" })}`,
    );
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("error")).toBe("invalid_target");

    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const { verifier, challenge } = await pkce();
    const id = await startAuthorize(app, { challenge });
    const { code } = await approveRequest(app, human.cookie, id, { repoIds: [repo!.id] });
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: API_RESOURCE,
      }),
      400,
      "invalid_target",
    );
  });

  it("tokens are audience-bound: an MCP token is refused by the HTTP API, an API token by /mcp", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const mcpOnly = await connectClient(app, human.cookie, { repoIds: [repo!.id] });
    const body = await expectError(
      await call(app, "GET", "/api/v1/me", { token: mcpOnly.access_token }),
      401,
      "unauthorized",
    );
    expect(body.error.message).toMatch(/issued for http:\/\/localhost\/mcp/);

    const apiOnly = await connectClient(app, human.cookie, {
      repoIds: [repo!.id],
      resource: API_RESOURCE,
    });
    const me = await call(app, "GET", "/api/v1/me", { token: apiOnly.access_token });
    expect(me.status).toBe(200);
    await me.text();
    const res = await rawMcp(app, apiOnly.access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    await res.text();
  });

  it("unknown clients and unregistered redirect URIs are never redirected to", async () => {
    const { app } = makeApp();
    mockCimd(cimdDocument({ client_id: "https://client.example/other.json" }));
    for (const q of [
      authorizeQuery({ challenge: "a".repeat(43), clientId: "my-random-client" }),
      authorizeQuery({
        challenge: "a".repeat(43),
        clientId: "http://client.example/oauth/client.json",
      }),
      authorizeQuery({ challenge: "a".repeat(43) }), // document's client_id does not match its URL
    ]) {
      const res = await call(app, "GET", `/api/oauth/authorize?${q}`);
      await expectError(res, 400, "invalid-request");
    }
    vi.restoreAllMocks();
    mockCimd();
    const res = await call(
      app,
      "GET",
      `/api/oauth/authorize?${authorizeQuery({ challenge: "a".repeat(43), redirectUri: "https://evil.example/cb" })}`,
    );
    const body = await expectError(res, 400, "invalid-request");
    expect(body.error.message).toMatch(/not registered/);
  });

  it("browsers get the error on the consent screen instead of raw JSON", async () => {
    const { app } = makeApp();
    const res = await call(
      app,
      "GET",
      `/api/oauth/authorize?${authorizeQuery({ challenge: "a".repeat(43), clientId: "nope" })}`,
      { headers: { accept: "text/html" } },
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname).toBe("/oauth/consent");
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("a consent request belongs to the first human who opens it", async () => {
    const { app } = makeApp();
    mockCimd();
    const maya = await signUpHuman(app, "Maya");
    const eve = await signUpHuman(app, "Eve");
    const [repo] = await seedRepos(1);
    const id = await startAuthorize(app, { challenge: "a".repeat(43) });
    const view = await call(app, "GET", `/api/v1/oauth/requests/${id}`, { cookie: maya.cookie });
    expect(view.status).toBe(200);
    await view.text();
    await expectError(
      await call(app, "GET", `/api/v1/oauth/requests/${id}`, { cookie: eve.cookie }),
      403,
      "forbidden",
    );
    await expectError(
      await call(app, "POST", `/api/v1/oauth/requests/${id}/approve`, {
        cookie: eve.cookie,
        body: { scopes: ["repo:read"], repoIds: [repo!.id], sessionDays: 1 },
      }),
      403,
      "forbidden",
    );
  });

  it("deny sends the browser back with access_denied", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const id = await startAuthorize(app, { challenge: "a".repeat(43), state: "s9" });
    const res = await call(app, "POST", `/api/v1/oauth/requests/${id}/deny`, {
      cookie: human.cookie,
    });
    expect(res.status).toBe(200);
    const { redirectTo } = await json<{ redirectTo: string }>(res);
    const u = new URL(redirectTo);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("s9");
    await expectError(
      await call(app, "POST", `/api/v1/oauth/requests/${id}/approve`, {
        cookie: human.cookie,
        body: { scopes: ["repo:read"], repoIds: null, sessionDays: 1 },
      }),
      409,
      "invalid-state",
    );
  });

  it("repo choice is explicit: repoIds is required (null = all), unknown repos are refused", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const id = await startAuthorize(app, { challenge: "a".repeat(43) });
    await expectError(
      await call(app, "POST", `/api/v1/oauth/requests/${id}/approve`, {
        cookie: human.cookie,
        body: { scopes: ["repo:read"], sessionDays: 7 },
      }),
      400,
      "invalid-request",
    );
    await expectError(
      await call(app, "POST", `/api/v1/oauth/requests/${id}/approve`, {
        cookie: human.cookie,
        body: { scopes: ["repo:read"], repoIds: ["repo_does_not_exist"], sessionDays: 7 },
      }),
      400,
      "invalid-request",
    );
  });
});
