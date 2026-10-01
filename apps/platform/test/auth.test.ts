import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_HUMAN_SCOPES } from "../src/auth/principals.js";
import { call, createAgent, expectError, json, makeApp, signUpHuman } from "./http.js";

describe("auth: humans", () => {
  it("signs up with email + password and gets a human principal with default scopes", async () => {
    const { app } = makeApp();
    const { cookie, principal } = await signUpHuman(app, "Grace");
    expect(principal).toMatchObject({ kind: "human", name: "Grace", ownerId: null });
    expect([...principal.scopes].sort()).toEqual([...DEFAULT_HUMAN_SCOPES].sort());
    // Same principal on the next request (created once).
    const again = await json<{ principal: { id: string }; user: { email: string } }>(
      await call(app, "GET", "/api/v1/me", { cookie }),
    );
    expect(again.principal.id).toBe(principal.id);
    expect(again.user.email).toMatch(/@example.com$/);
  });

  it("rejects anonymous requests with a fix hint", async () => {
    const { app } = makeApp();
    const body = await expectError(await call(app, "GET", "/api/v1/me"), 401, "unauthorized");
    expect(body.error.fix.explanation).toMatch(/Bearer/);
  });
});

describe("auth: agents", () => {
  it("a human creates an agent; its bearer token resolves to the agent principal", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const { token, principal } = await createAgent(app, human.cookie, [
      "repo:read",
      "change:create",
    ]);
    expect(token).toMatch(/^gtf_[A-Za-z0-9_-]{43}$/);
    expect(principal).toMatchObject({
      kind: "agent",
      ownerId: human.principal.id,
      scopes: ["repo:read", "change:create"],
    });

    const me = await json<{ principal: { id: string; kind: string }; user: unknown }>(
      await call(app, "GET", "/api/v1/me", { token }),
    );
    expect(me).toEqual({
      principal: expect.objectContaining({ id: principal.id, kind: "agent" }),
      user: null,
    });

    // Only the hash is stored.
    const row = await env.DB.prepare(
      "SELECT token_hash, prefix FROM agent_tokens WHERE principal_id = ?",
    )
      .bind(principal.id)
      .first<{ token_hash: string; prefix: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toContain(token.slice(4));
    expect(token.startsWith(row!.prefix)).toBe(true);

    const list = await json<{ principals: { id: string }[] }>(
      await call(app, "GET", "/api/v1/principals", { cookie: human.cookie }),
    );
    expect(list.principals.map((p) => p.id)).toEqual([human.principal.id, principal.id]);
  });

  it("agents can never be granted approval, review or policy scopes", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    for (const scope of ["plan:approve", "change:review", "policy:admin", "repo:admin"]) {
      const res = await call(app, "POST", "/api/v1/principals/agents", {
        cookie: human.cookie,
        body: { name: "sneaky", scopes: ["repo:read", scope] },
      });
      await expectError(res, 403, "scope-not-allowed");
    }
  });

  it("agents cannot create agents", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const { token } = await createAgent(app, human.cookie);
    const res = await call(app, "POST", "/api/v1/principals/agents", {
      token,
      body: { name: "child", scopes: ["repo:read"] },
    });
    await expectError(res, 403, "forbidden");
  });

  it("rejects unknown, malformed and revoked tokens", async () => {
    const { app } = makeApp();
    await expectError(
      await call(app, "GET", "/api/v1/me", { token: `gtf_${"x".repeat(43)}` }),
      401,
      "unauthorized",
    );
    await expectError(
      await call(app, "GET", "/api/v1/me", { token: "gtf_short" }),
      401,
      "unauthorized",
    );

    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    expect((await call(app, "GET", "/api/v1/me", { token: agent.token })).status).toBe(200);
    const revoked = await json<{ revoked: number }>(
      await call(app, "DELETE", `/api/v1/principals/${agent.principal.id}/tokens`, {
        cookie: human.cookie,
      }),
    );
    expect(revoked.revoked).toBe(1);
    await expectError(
      await call(app, "GET", "/api/v1/me", { token: agent.token }),
      401,
      "unauthorized",
    );
  });

  it("only the owner (or the agent itself) can revoke an agent's tokens", async () => {
    const { app } = makeApp();
    const owner = await signUpHuman(app);
    const stranger = await signUpHuman(app);
    const agent = await createAgent(app, owner.cookie);
    await expectError(
      await call(app, "DELETE", `/api/v1/principals/${agent.principal.id}/tokens`, {
        cookie: stranger.cookie,
      }),
      403,
      "forbidden",
    );
  });

  it("enforces route scopes for agents (insufficient-scope)", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const readOnly = await createAgent(app, human.cookie, ["repo:read"]);
    const res = await call(app, "POST", "/api/v1/plans", {
      token: readOnly.token,
      body: {
        repoId: "r1",
        title: "Plan",
        intent: "Do a thing properly.",
        acceptanceCriteria: ["it works"],
      },
    });
    const body = await expectError(res, 403, "insufficient-scope");
    expect(body.error.details).toMatchObject({ missing: ["plan:create"] });
  });

  it("whoami/capabilities lists scopes, repos with claim status and quotas", async () => {
    const { app } = makeApp();
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const caps = await json<{
      principal: { id: string };
      scopes: string[];
      canApprove: boolean;
      quotas: { enforced: boolean };
    }>(await call(app, "GET", "/api/v1/capabilities", { token: agent.token }));
    expect(caps).toMatchObject({
      principal: { id: agent.principal.id },
      canApprove: false,
      quotas: { enforced: false },
    });
    expect(caps.scopes).toEqual(["repo:read", "plan:create", "change:create"]);
    const humanCaps = await json<{ canApprove: boolean }>(
      await call(app, "GET", "/api/v1/capabilities", { cookie: human.cookie }),
    );
    expect(humanCaps.canApprove).toBe(true);
  });
});
