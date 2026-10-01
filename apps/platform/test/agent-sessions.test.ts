/**
 * Delegated agent sessions: per-repo scoping (HTTP, MCP, service layer), every path by which an
 * agent might try to approve work or widen its own access, and one-click revoke.
 */
import { env } from "cloudflare:workers";
import { parseToolError } from "@app/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeFixture, planFixture, store } from "./fixtures.js";
import { call, expectError, json, makeApp, signUpHuman, type TestApp } from "./http.js";
import {
  API_RESOURCE,
  approveRequest,
  CLIENT_ID,
  connectClient,
  DEVICE_GRANT,
  expectOAuthError,
  mcpClient,
  mockCimd,
  pkce,
  postForm,
  rawMcp,
  seedRepos,
  startAuthorize,
} from "./oauth-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A human, two repos, a plan + change on each, and an API+MCP session limited to repo X. */
async function world(app: TestApp) {
  mockCimd();
  const human = await signUpHuman(app, "Maya");
  const [repoX, repoY] = await seedRepos(2);
  const s = store();
  const planX = planFixture(repoX!.id, human.principal.id);
  const planY = planFixture(repoY!.id, human.principal.id);
  await s.insertPlan(planX);
  await s.insertPlan(planY);
  const changeX = changeFixture(repoX!.id, human.principal.id, { planId: planX.id });
  const changeY = changeFixture(repoY!.id, human.principal.id, { planId: planY.id });
  await s.insertChange(changeX);
  await s.insertChange(changeY);
  const api = await connectClient(app, human.cookie, {
    repoIds: [repoX!.id],
    scopes: ["repo:read", "plan:create", "change:create"],
    scope: "repo:read plan:create change:create",
    resource: API_RESOURCE,
  });
  const mcp = await connectClient(app, human.cookie, {
    repoIds: [repoX!.id],
    scopes: ["repo:read", "plan:create", "change:create"],
    scope: "repo:read plan:create change:create",
  });
  return { human, repoX: repoX!, repoY: repoY!, planX, planY, changeX, changeY, api, mcp };
}

describe("repo scoping", () => {
  it("HTTP: only the granted repo is visible; every route naming another repo is 403 with a fix", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const token = w.api.access_token;

    const repos = await json<{ repos: { id: string }[] }>(
      await call(app, "GET", "/api/v1/repos", { token }),
    );
    expect(repos.repos.map((r) => r.id)).toEqual([w.repoX.id]);
    const caps = await json<{ repos: { id: string }[] }>(
      await call(app, "GET", "/api/v1/capabilities", { token }),
    );
    expect(caps.repos.map((r) => r.id)).toEqual([w.repoX.id]);

    // Allowed on X.
    for (const path of [
      `/api/v1/repos/${w.repoX.id}`,
      `/api/v1/repos/${w.repoX.id}/plans`,
      `/api/v1/plans/${w.planX.id}`,
      `/api/v1/changes/${w.changeX.id}`,
      `/api/v1/audit?subject=repo:${w.repoX.id}`,
    ]) {
      const res = await call(app, "GET", path, { token });
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      await res.text();
    }

    // Refused on Y, with a fix that says how to get access.
    for (const [method, path, body] of [
      ["GET", `/api/v1/repos/${w.repoY.id}`, undefined],
      ["GET", `/api/v1/repos/${w.repoY.id}/changes`, undefined],
      ["GET", `/api/v1/plans/${w.planY.id}`, undefined],
      ["GET", `/api/v1/changes/${w.changeY.id}`, undefined],
      ["GET", `/api/v1/changes/${w.changeY.id}/diff`, undefined],
      ["GET", `/api/v1/audit?subject=change:${w.changeY.id}`, undefined],
      ["GET", "/api/v1/audit", undefined],
      [
        "POST",
        "/api/v1/plans",
        { repoId: w.repoY.id, title: "t", intent: "i", acceptanceCriteria: ["a"] },
      ],
      ["POST", "/api/v1/changes", { repoId: w.repoY.id, title: "t", category: "feature" }],
      [
        "POST",
        "/api/v1/changes",
        { repoId: w.repoX.id, planId: w.planY.id, title: "t", category: "feature" },
      ],
      ["POST", `/api/v1/changes/${w.changeY.id}/request-review`, {}],
      ["POST", `/api/v1/changes/${w.changeY.id}/token`, {}],
    ] as const) {
      const res = await call(app, method, path, { token, ...(body ? { body } : {}) });
      const err = await expectError(res, 403, "repo-not-granted");
      expect(err.error.fix.explanation).toMatch(/approve a new session/);
    }
  });

  it("MCP: list_repos and whoami only show the granted repo; tools on another repo are refused", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const mcp = await mcpClient(app, w.mcp.access_token);
    try {
      const list = await mcp.tools.list_repos();
      if (list.isError) throw new Error(JSON.stringify(list.content));
      expect(list.structuredContent.repos.map((r) => r.id)).toEqual([w.repoX.id]);
      const calls = [
        () => mcp.tools.get_change_status({ changeId: w.changeY.id }),
        () => mcp.tools.get_evidence({ changeId: w.changeY.id }),
        () => mcp.tools.get_tour({ changeId: w.changeY.id }),
        () => mcp.tools.request_review({ changeId: w.changeY.id }),
        () => mcp.tools.list_issues_for_change({ changeId: w.changeY.id }),
        () => mcp.tools.refresh_push_token({ changeId: w.changeY.id }),
        () =>
          mcp.tools.create_plan({
            repoId: w.repoY.id,
            title: "Sneak into repo Y",
            intent: "Try to draft a plan on a repo this session was not granted.",
            acceptanceCriteria: ["refused"],
          }),
        () => mcp.tools.start_change({ repoId: w.repoY.id, title: "t", category: "feature" }),
        () =>
          mcp.tools.start_change({
            repoId: w.repoX.id,
            planId: w.planY.id,
            title: "t",
            category: "feature",
          }),
      ];
      const codes: string[] = [];
      for (const run of calls) {
        const r = await run();
        expect(r.isError).toBe(true);
        const err = parseToolError((r.content as { text: string }[])[0]!.text);
        codes.push(`${err?.error.code}: ${err?.error.message}`);
      }
      expect(codes.filter((c) => !c.startsWith("repo-not-granted"))).toEqual([]);
    } finally {
      await mcp.client.close();
    }
  });

  it("a session for all repos (an explicit null) sees every repo", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const repos = await seedRepos(2);
    const all = await connectClient(app, human.cookie, { repoIds: null, resource: API_RESOURCE });
    const list = await json<{ repos: { id: string }[] }>(
      await call(app, "GET", "/api/v1/repos", { token: all.access_token }),
    );
    expect(list.repos.map((r) => r.id)).toEqual(expect.arrayContaining(repos.map((r) => r.id)));
  });
});

describe("agents can never approve (every path)", () => {
  it("OAuth scope strings asking for approval-class scopes are refused (authorize, device, refresh)", async () => {
    const { app } = makeApp();
    mockCimd();
    for (const scope of ["plan:approve", "change:review", "policy:admin", "repo:admin"]) {
      const res = await call(
        app,
        "GET",
        `/api/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: CLIENT_ID,
          redirect_uri: "https://client.example/callback",
          code_challenge: "a".repeat(43),
          code_challenge_method: "S256",
          scope: `repo:read ${scope}`,
        })}`,
      );
      const loc = new URL(res.headers.get("location") ?? "");
      expect({ scope, error: loc.searchParams.get("error") }).toEqual({
        scope,
        error: "invalid_scope",
      });
      expect(loc.searchParams.get("error_description")).toMatch(/never hold/);

      const dc = await postForm(app, "/api/auth/device/code", {
        client_id: "gittifacts-cli",
        scope: `repo:read ${scope}`,
      });
      expect(dc.status).toBe(400);
      expect((await json<{ error: string }>(dc)).error).toBe("invalid_scope");
    }
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const t = await connectClient(app, human.cookie, { repoIds: [repo!.id] });
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: CLIENT_ID,
        scope: "repo:read plan:approve",
      }),
      400,
      "invalid_scope",
    );
  });

  it("the consent API refuses approval-class scopes in the body (code and device flows)", async () => {
    const { app } = makeApp();
    mockCimd();
    const human = await signUpHuman(app);
    const [repo] = await seedRepos(1);
    const id = await startAuthorize(app, { challenge: "a".repeat(43) });
    const dc = await json<{ user_code: string }>(
      await postForm(app, "/api/auth/device/code", { client_id: "gittifacts-cli" }),
    );
    for (const scope of ["plan:approve", "change:review", "policy:admin", "repo:admin"]) {
      const body = { scopes: ["repo:read", scope], repoIds: [repo!.id], sessionDays: 7 };
      const err = await expectError(
        await call(app, "POST", `/api/v1/oauth/requests/${id}/approve`, {
          cookie: human.cookie,
          body,
        }),
        403,
        "scope-not-allowed",
      );
      expect(err.error.message).toMatch(/never hold/);
      await expectError(
        await call(app, "POST", `/api/v1/oauth/device/${dc.user_code}/approve`, {
          cookie: human.cookie,
          body,
        }),
        403,
        "scope-not-allowed",
      );
    }
    // Nothing was approved by the failed attempts.
    const view = await json<{ consent: { status: string } }>(
      await call(app, "GET", `/api/v1/oauth/requests/${id}`, { cookie: human.cookie }),
    );
    expect(view.consent.status).toBe("pending");
  });

  it("an OAuth agent token cannot approve, reject, review, kill, administer or mint agents", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const token = w.api.access_token;
    for (const [method, path, body, code] of [
      // Human-only routes refuse agents before any scope check.
      ["POST", `/api/v1/plans/${w.planX.id}/approve`, {}, "forbidden"],
      ["POST", `/api/v1/plans/${w.planX.id}/reject`, { comment: "no" }, "forbidden"],
      [
        "POST",
        `/api/v1/changes/${w.changeX.id}/review`,
        { decision: "approve", headSha: w.changeX.headSha },
        "forbidden",
      ],
      ["POST", `/api/v1/changes/${w.changeX.id}/kill`, { reason: "x" }, "forbidden"],
      ["PATCH", `/api/v1/repos/${w.repoX.id}/lane0`, { enabled: true }, "forbidden"],
      ["POST", "/api/v1/repos", { name: "evil" }, "insufficient-scope"],
      ["POST", "/api/v1/principals/agents", { name: "child", scopes: ["repo:read"] }, "forbidden"],
    ] as const) {
      const res = await call(app, method, path, { token, body });
      await expectError(res, 403, code);
    }
  });

  it("an agent cannot approve OAuth or device requests (it cannot widen its own access)", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const token = w.api.access_token;
    const { challenge } = await pkce();
    const id = await startAuthorize(app, { challenge });
    const dc = await json<{ user_code: string; device_code: string }>(
      await postForm(app, "/api/auth/device/code", { client_id: "gittifacts-cli" }),
    );
    const body = { scopes: ["repo:read"], repoIds: [w.repoY.id], sessionDays: 90 };
    for (const [method, path, b] of [
      ["GET", `/api/v1/oauth/requests/${id}`, undefined],
      ["POST", `/api/v1/oauth/requests/${id}/approve`, body],
      ["GET", `/api/v1/oauth/device/${dc.user_code}`, undefined],
      ["POST", `/api/v1/oauth/device/${dc.user_code}/approve`, body],
      ["GET", "/api/v1/agent-sessions", undefined],
      ["POST", `/api/v1/agent-sessions/${w.human.principal.id}/revoke`, {}],
    ] as const) {
      await expectError(
        await call(app, method, path, { token, ...(b ? { body: b } : {}) }),
        403,
        "forbidden",
      );
    }
    // better-auth's own endpoints do not take an agent token as a session either.
    for (const path of ["/api/auth/device/approve", "/api/auth/device/token"]) {
      const res = await call(app, "POST", path, {
        token,
        body: {
          userCode: dc.user_code,
          device_code: dc.device_code,
          client_id: "gittifacts-cli",
          grant_type: DEVICE_GRANT,
        },
      });
      expect(res.status).toBe(404);
      await res.text();
    }
    const session = await call(app, "GET", "/api/auth/get-session", { token });
    expect(await session.json()).toBeNull();
  });

  it("MCP offers no tool that approves anything, and whoami says canApprove: false", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const mcp = await mcpClient(app, w.mcp.access_token);
    try {
      const names = (await mcp.listTools()).map((t) => t.name);
      expect(names.filter((n) => /approve|review_change|reject|kill|lane0|policy/.test(n))).toEqual(
        [],
      );
      const who = await mcp.tools.whoami();
      if (who.isError) throw new Error(JSON.stringify(who.content));
      expect(who.structuredContent.canApprove).toBe(false);
      for (const r of who.structuredContent.repos) {
        expect(r.actions).not.toContain("approve-plan");
        expect(r.actions).not.toContain("review-change");
      }
    } finally {
      await mcp.client.close();
    }
  });
});

describe("sessions + revoke", () => {
  it("lists sessions with client, scopes, repos, created, last used and expiry", async () => {
    const { app } = makeApp();
    const w = await world(app);
    await call(app, "GET", "/api/v1/me", { token: w.api.access_token }).then((r) => r.text());
    const { sessions } = await json<{ sessions: Record<string, unknown>[] }>(
      await call(app, "GET", "/api/v1/agent-sessions", { cookie: w.human.cookie }),
    );
    expect(sessions).toHaveLength(2);
    const apiSession = sessions.find((s) => (s.audience as string[]).includes(API_RESOURCE));
    expect(apiSession).toMatchObject({
      flow: "authorization_code",
      client: { id: CLIENT_ID, name: "Example MCP Client" },
      scopes: ["repo:read", "plan:create", "change:create"],
      repoIds: [w.repoX.id],
      repos: [{ id: w.repoX.id, name: w.repoX.name }],
      status: "active",
      activeTokens: 1,
    });
    expect(apiSession?.lastUsedAt).toEqual(expect.any(String));
    const days =
      (Date.parse(String(apiSession?.expiresAt)) - Date.parse(String(apiSession?.createdAt))) /
      86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it("one-click revoke kills access immediately (API, MCP, refresh) and is audit-logged", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const { sessions } = await json<{ sessions: { principalId: string; audience: string[] }[] }>(
      await call(app, "GET", "/api/v1/agent-sessions", { cookie: w.human.cookie }),
    );
    const mcpSession = sessions.find((s) => !s.audience.includes(API_RESOURCE))!;
    expect((await rawMcp(app, w.mcp.access_token)).status).toBe(200);

    const res = await call(app, "POST", `/api/v1/agent-sessions/${mcpSession.principalId}/revoke`, {
      cookie: w.human.cookie,
      headers: { "Idempotency-Key": "revoke-1" },
    });
    expect(res.status).toBe(200);
    const { session } = await json<{ session: { status: string; activeTokens: number } }>(res);
    expect(session).toMatchObject({ status: "revoked", activeTokens: 0 });

    const dead = await rawMcp(app, w.mcp.access_token);
    expect(dead.status).toBe(401);
    expect(dead.headers.get("www-authenticate")).toMatch(/invalid_token/);
    await dead.text();
    await expectOAuthError(
      await postForm(app, "/api/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: w.mcp.refresh_token,
        client_id: CLIENT_ID,
      }),
      400,
      "invalid_grant",
    );
    // The other session is untouched.
    const other = await call(app, "GET", "/api/v1/me", { token: w.api.access_token });
    expect(other.status).toBe(200);
    await other.text();

    const row = await env.DB.prepare("SELECT disabled_at FROM principals WHERE id = ?")
      .bind(mcpSession.principalId)
      .first<{ disabled_at: string | null }>();
    expect(row?.disabled_at).toEqual(expect.any(String));
    const audit = await env.DB.prepare(
      "SELECT action, principal_id FROM audit_events WHERE subject = ? ORDER BY seq",
    )
      .bind(`principal:${mcpSession.principalId}`)
      .all<{ action: string; principal_id: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      "agent-session.created",
      "agent-session.revoked",
    ]);
    expect(audit.results[1]?.principal_id).toBe(w.human.principal.id);

    // Idempotent replay and repeat revoke are both fine.
    const again = await call(
      app,
      "POST",
      `/api/v1/agent-sessions/${mcpSession.principalId}/revoke`,
      {
        cookie: w.human.cookie,
      },
    );
    expect(again.status).toBe(200);
    await again.text();
  });

  it("revoking via RFC 7009 with the refresh token ends the session; other humans can't revoke", async () => {
    const { app } = makeApp();
    const w = await world(app);
    const eve = await signUpHuman(app, "Eve");
    const { sessions } = await json<{ sessions: { principalId: string }[] }>(
      await call(app, "GET", "/api/v1/agent-sessions", { cookie: w.human.cookie }),
    );
    await expectError(
      await call(app, "POST", `/api/v1/agent-sessions/${sessions[0]!.principalId}/revoke`, {
        cookie: eve.cookie,
      }),
      404,
      "not-found",
    );
    const res = await postForm(app, "/api/oauth/revoke", { token: w.api.refresh_token });
    expect(res.status).toBe(200);
    await res.text();
    const dead = await call(app, "GET", "/api/v1/me", { token: w.api.access_token });
    expect(dead.status).toBe(401);
    await dead.text();
  });

  it("manual agents show up as sessions and revoke disables them too", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const created = await json<{ principal: { id: string }; token: string }>(
      await call(app, "POST", "/api/v1/principals/agents", {
        cookie: human.cookie,
        body: { name: "fleet-coder", scopes: ["repo:read"] },
      }),
    );
    const { sessions } = await json<{ sessions: Record<string, unknown>[] }>(
      await call(app, "GET", "/api/v1/agent-sessions", { cookie: human.cookie }),
    );
    expect(sessions[0]).toMatchObject({
      principalId: created.principal.id,
      flow: "manual",
      client: null,
      status: "active",
      repoIds: null,
    });
    const res = await call(app, "POST", `/api/v1/agent-sessions/${created.principal.id}/revoke`, {
      cookie: human.cookie,
    });
    expect(res.status).toBe(200);
    await res.text();
    const dead = await call(app, "GET", "/api/v1/me", { token: created.token });
    expect(dead.status).toBe(401);
    await dead.text();
  });
});
