/**
 * O3: credential-less create_project, the project token's reach, creation rate limits (IP, ASN,
 * global), per-token request limits and the kill switch — through the real app (HTTP + MCP),
 * D1, the AbuseLimiter / ProjectLedger DOs and the coordinator facade over fake Artifacts.
 */
import { env } from "cloudflare:workers";
import { ANONYMOUS_RECONNECT } from "@app/conventions";
import { createPlatformClient } from "@app/mcp/client";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { principals } from "../../src/db/schema.js";
import { store } from "../fixtures.js";
import { call, createAgent, json, ORIGIN, signUpHuman } from "../http.js";
import { resetIntegrationFakes } from "./fakes.js";
import { platformApp } from "./harness.js";
import {
  createUnclaimed,
  fetchWith,
  flagDown,
  flagOff,
  freshIp,
  request,
  resetSharedLimiters,
  rpc,
  toolResult,
} from "./unclaimed-helpers.js";

beforeEach(async () => {
  resetIntegrationFakes();
  await resetSharedLimiters([64_500, 65_100, 1, 2]);
});

type Envelope = { error: { code: string; message: string; fix: { explanation: string } } };

describe("credential-less create_project", () => {
  it("MCP: initialize, tools/list and create_project work without a token; the rest gets the OAuth 401", async () => {
    const app = platformApp();
    const from = { ip: freshIp(), asn: 64_500 };
    const init = await rpc(
      app,
      {
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "anon-agent", version: "1" },
        },
      },
      { from },
    );
    expect(init.status).toBe(200);
    expect(init.body?.result).toMatchObject({ serverInfo: expect.any(Object) });
    const list = await rpc(app, { id: 2, method: "tools/list", params: {} }, { from });
    const listed = (list.body?.result ?? {}) as { tools?: Array<{ name: string }> };
    const tools = (listed.tools ?? []).map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["create_project", "whoami", "start_change"]));

    const who = toolResult(
      (
        await rpc(
          app,
          { id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } },
          { from },
        )
      ).body,
    );
    expect(who).toMatchObject({
      ok: true,
      value: { principalId: "anonymous", repos: [], canApprove: false },
    });

    const created = toolResult(
      (
        await rpc(
          app,
          {
            id: 4,
            method: "tools/call",
            params: {
              name: "create_project",
              arguments: { name: "anon api" },
            },
          },
          { from },
        )
      ).body,
    );
    expect(created.ok, JSON.stringify(created.value)).toBe(true);
    expect(created.value).toMatchObject({
      name: "anon-api",
      token: expect.stringMatching(/^gtf_/),
      claimUrl: expect.stringMatching(new RegExp(`^${ORIGIN}/claim/gtc_[A-Za-z0-9_-]{43}$`)),
      remote: expect.objectContaining({ url: expect.stringContaining("task-") }),
    });
    // The first next step: reconnect with the token (onboarding eval m-20261002-073146-qzvw: an
    // agent kept its anonymous session and its next call got a 401).
    const steps = (created.value as { nextSteps: { title: string; why?: string; call?: string }[] })
      .nextSteps;
    expect(steps[0]).toMatchObject({
      title: `Reconnect to ${ORIGIN}/mcp with Authorization: Bearer <token>`,
      why: expect.stringContaining(ANONYMOUS_RECONNECT),
      call: "whoami({})",
    });
    const listedCreate = (listed.tools ?? []) as Array<{ name: string; description?: string }>;
    expect(listedCreate.find((t) => t.name === "create_project")?.description).toContain(
      ANONYMOUS_RECONNECT,
    );

    // Every other tool still needs a bearer: the OAuth challenge, not an anonymous answer.
    const other = await rpc(
      app,
      { id: 5, method: "tools/call", params: { name: "list_repos", arguments: {} } },
      { from },
    );
    expect(other.status).toBe(401);
    expect(other.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=/);
    const get = await request(app, "GET", "/mcp", {
      headers: { accept: "text/event-stream" },
      from,
    });
    expect(get.status).toBe(405);
  });

  it("a real MCP SDK client without credentials (what `gittifacts init` does) creates a project", async () => {
    const app = platformApp();
    // No token: the SDK's header ends up as a bare "Bearer", which carries no credentials.
    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, "", { fetch: fetchWith(app) });
    try {
      const tools = (await mcp.listTools()).map((t) => t.name);
      expect(tools).toContain("create_project");
      const created = await mcp.tools.create_project({
        name: "made by sdk",
        idempotencyKey: `cli_${crypto.randomUUID().slice(0, 16)}`,
      });
      if (created.isError) throw new Error(JSON.stringify(created.content));
      expect(created.structuredContent).toMatchObject({
        token: expect.stringMatching(/^gtf_/),
        claimUrl: expect.stringContaining("/claim/"),
      });
      // Anything else answers the OAuth 401, which the SDK raises.
      await expect(mcp.tools.list_repos({})).rejects.toThrow(/authentication required/);
    } finally {
      await mcp.client.close();
    }
  });

  it("HTTP: anonymous POST /api/v1/projects; credentials that don't verify never fall back", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app, {});
    expect(p.token).toMatch(/^gtf_/);
    expect(p.claimUrl).toContain("/claim/gtc_");
    const repo = await store().getRepo(p.projectId);
    expect(repo?.claim).toMatchObject({ status: "unclaimed", ownerId: null });
    const expires = Date.parse(repo?.claim.expiresAt ?? "");
    expect(expires - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    const bad = await request(app, "POST", "/api/v1/projects", {
      token: "gtf_not-a-real-token-0000000000000000000000000",
      body: {},
    });
    expect(bad.status).toBe(401);
    // nextSteps tell the agent how to keep it.
    expect(JSON.stringify(p.nextSteps)).toContain("claim");
  });

  it("idempotent: the same key returns the same project (fresh token), once rate-limited; reuse with another body is 409; short keys 400", async () => {
    const app = platformApp();
    const from = { ip: freshIp() };
    const key = crypto.randomUUID();
    const headers = { "idempotency-key": key };
    const a = await createUnclaimed(app, { name: "idem" }, { headers, from });
    const b = await createUnclaimed(app, { name: "idem" }, { headers, from });
    expect(b.projectId).toBe(a.projectId);
    expect(b.claimUrl).toBe(a.claimUrl);
    expect(b.token).not.toBe(a.token);
    expect(b.remote?.changeId).toBe(a.remote?.changeId);
    const reuse = await request(app, "POST", "/api/v1/projects", {
      headers,
      body: {},
      from,
    });
    expect(reuse.status).toBe(409);
    expect(((await reuse.json()) as Envelope).error.code).toBe("idempotency-key-reuse");
    const short = await request(app, "POST", "/api/v1/projects", {
      headers: { "idempotency-key": "k1" },
      body: {},
    });
    expect(short.status).toBe(400);
  });
});

describe("the unclaimed project's token", () => {
  it("is an ownerless agent with agent scopes, limited to its one repo", async () => {
    const app = platformApp();
    const human = await signUpHuman(app);
    const other = await call(app, "POST", "/api/v1/repos", {
      cookie: human.cookie,
      body: { name: `theirs-${Date.now().toString(36)}` },
    });
    const { repo: theirs } = await json<{ repo: { id: string } }>(other);
    const p = await createUnclaimed(app);
    const token = p.token as string;

    const caps = await request(app, "GET", "/api/v1/capabilities", { token });
    const c = await json<{
      principal: {
        id: string;
        kind: string;
        ownerId: string | null;
        scopes: string[];
        repoIds: string[];
      };
      repos: Array<{ id: string; claim: { status: string } }>;
      quotas: { enforced: boolean; ciMinutesPerDay: number };
    }>(caps);
    expect(c.principal).toMatchObject({ kind: "agent", ownerId: null, repoIds: [p.projectId] });
    expect(c.principal.scopes.sort()).toEqual(["change:create", "plan:create", "repo:read"]);
    expect(c.repos.map((r) => r.id)).toEqual([p.projectId]);
    expect(c.quotas).toMatchObject({ enforced: true, ciMinutesPerDay: 60 });

    const mcp = await createPlatformClient(`${ORIGIN}/mcp`, token, { fetch: fetchWith(app) });
    try {
      const denied = await mcp.tools.start_change({
        repoId: theirs.id,
        title: "Sneak in",
        category: "fix",
      });
      expect(denied.isError).toBe(true);
      // Another person's repo is not even there for an unclaimed project's agent.
      expect(JSON.stringify(denied.content)).toContain("not-found");
      const again = await mcp.tools.create_project({ template: "workers-api" });
      expect(again.isError).toBe(true);
      expect(JSON.stringify(again.content)).toContain("repo-not-granted");
      const repos = await mcp.tools.list_repos({});
      if (repos.isError) throw new Error(JSON.stringify(repos.content));
      const listed = repos.structuredContent as { repos: Array<{ id: string }> };
      expect(listed.repos.map((r) => r.id)).toEqual([p.projectId]);
    } finally {
      await mcp.client.close();
    }
    // HTTP too, and it can never approve anything.
    const http = await request(app, "GET", `/api/v1/repos/${theirs.id}`, { token });
    expect(http.status).toBe(404);
    const me = await json<{ principal: { id: string } }>(
      await request(app, "GET", "/api/v1/capabilities", { token }),
    );
    const row = await store()
      .db.select()
      .from(principals)
      .where(eq(principals.id, me.principal.id))
      .get();
    expect(row?.scopes).not.toContain("plan:approve");
  });
});

describe("creation rate limits: per IP, per network (ASN), platform-wide", () => {
  const tight = (creation: Record<string, unknown>) => ({
    UNCLAIMED_LIMITS: JSON.stringify({ creation }),
  });

  it("per IP: the third project in an hour from one address is 429 rate-limited with Retry-After", async () => {
    const app = platformApp();
    const env = tight({ ipHour: { capacity: 2, periodSec: 3600 } });
    const from = { ip: freshIp() };
    await createUnclaimed(app, {}, { env, from });
    await createUnclaimed(app, {}, { env, from });
    const third = await request(app, "POST", "/api/v1/projects", {
      env,
      from,
      body: {},
    });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await json<Envelope & { error: { details: { scope: string } } }>(third);
    expect(body.error).toMatchObject({ code: "rate-limited", details: { scope: "ip" } });
    // Another address is unaffected.
    await createUnclaimed(app, {}, { env });
  });

  it("per ASN: many addresses in one network share its bucket", async () => {
    const app = platformApp();
    const env = tight({ asnHour: { capacity: 2, periodSec: 3600 } });
    const asn = 65_100;
    await createUnclaimed(app, {}, { env, from: { ip: freshIp(), asn } });
    await createUnclaimed(app, {}, { env, from: { ip: freshIp(), asn } });
    const third = await request(app, "POST", "/api/v1/projects", {
      env,
      from: { ip: freshIp(), asn },
      body: {},
    });
    expect(third.status).toBe(429);
    expect((await json<{ error: { details: { scope: string } } }>(third)).error.details.scope).toBe(
      "asn",
    );
  });

  it("global: a platform-wide cap across addresses and networks (also over MCP)", async () => {
    const app = platformApp();
    const env = tight({ globalHour: { capacity: 1, periodSec: 3600 } });
    await createUnclaimed(app, {}, { env, from: { ip: freshIp(), asn: 1 } });
    const r = await rpc(
      app,
      {
        id: 1,
        method: "tools/call",
        params: { name: "create_project", arguments: {} },
      },
      { env, from: { ip: freshIp(), asn: 2 } },
    );
    const out = toolResult(r.body);
    expect(out.ok).toBe(false);
    expect(out.value).toMatchObject({
      error: { code: "rate-limited", details: { scope: "global" } },
    });
  });
});

describe("per-token request limits (UNCLAIMED_TOKEN_LIMITER)", () => {
  it("refuses an unclaimed token over its limit on HTTP and MCP, and fails closed without the binding", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app);
    const token = p.token as string;
    const limited = { UNCLAIMED_TOKEN_LIMITER: { limit: async () => ({ success: false }) } };
    const http = await request(app, "GET", "/api/v1/capabilities", { token, env: limited });
    expect(http.status).toBe(429);
    expect(((await http.json()) as Envelope).error.code).toBe("rate-limited");
    const mcp = await rpc(
      app,
      { id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } },
      { token, env: limited },
    );
    expect(mcp.status).toBe(429);
    const unbound = await request(app, "GET", "/api/v1/capabilities", {
      token,
      env: { UNCLAIMED_TOKEN_LIMITER: undefined },
    });
    expect(unbound.status).toBe(429);
    // A claimed agent's token is never limited here.
    const human = await signUpHuman(app);
    const agent = await createAgent(app, human.cookie);
    const fine = await request(app, "GET", "/api/v1/capabilities", {
      token: agent.token,
      env: limited,
    });
    expect(fine.status).toBe(200);
  });

  it("the real binding (120/min per token) answers 429 once the minute's budget is spent", async () => {
    const app = platformApp();
    const p = await createUnclaimed(app);
    let status = 200;
    for (let i = 0; i < 130 && status === 200; i++) {
      const res = await request(app, "GET", "/api/v1/me", { token: p.token as string });
      status = res.status;
      await res.body?.cancel();
    }
    expect(status).toBe(429);
  });
});

describe("kill switch", () => {
  const create = (app: ReturnType<typeof platformApp>, over: Record<string, unknown>) =>
    request(app, "POST", "/api/v1/projects", { env: over, body: {} });

  it("Flagship off, or unreachable (fail closed) → 503 creation-disabled with a fix; authenticated creation still works", async () => {
    const app = platformApp();
    for (const FLAGS of [flagOff, flagDown, undefined]) {
      const res = await create(app, { FLAGS });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Envelope;
      expect(body.error.code).toBe("creation-disabled");
      expect(body.error.fix.explanation).toMatch(/OAuth|token/);
    }
    const mcp = await rpc(
      app,
      { id: 1, method: "tools/call", params: { name: "create_project", arguments: {} } },
      { env: { FLAGS: flagOff } },
    );
    expect(toolResult(mcp.body).value).toMatchObject({ error: { code: "creation-disabled" } });
    const start = await request(app, "GET", "/start", { env: { FLAGS: flagOff } });
    expect(await start.text()).toMatch(/switched off|Disabled/i);
    const human = await signUpHuman(app);
    const claimed = await request(app, "POST", "/api/v1/projects", {
      cookie: human.cookie,
      env: { FLAGS: flagOff },
      body: {},
    });
    expect(claimed.status).toBe(201);
  });

  it("the admin override (D1) stops creation even when the flag is on, and bridges an unreachable flag", async () => {
    const app = platformApp();
    const admin = await signUpHuman(app, "Admin");
    const someone = await signUpHuman(app, "Someone");
    // By principal id; an e-mail would not do (e-mail sign-up is unverified).
    const admins = { PLATFORM_ADMINS: `hu_nobody, ${admin.principal.id}` };
    const put = (cookie: string, mode: string, over: Record<string, unknown> = admins) =>
      request(app, "PUT", "/api/v1/admin/unclaimed-creation", {
        cookie,
        env: over,
        body: { mode },
      });
    expect((await put(someone.cookie, "off")).status).toBe(403);
    expect((await put(admin.cookie, "off", {})).status).toBe(403);

    const off = await put(admin.cookie, "off");
    expect(await off.json()).toMatchObject({ enabled: false, source: "override", override: "off" });
    expect((await create(app, {})).status).toBe(503);

    expect((await put(admin.cookie, "on")).status).toBe(200);
    expect((await create(app, { FLAGS: flagDown })).status).toBe(201);
    expect((await create(app, { FLAGS: flagOff })).status).toBe(503);

    expect((await put(admin.cookie, "flag")).status).toBe(200);
    expect((await create(app, { FLAGS: flagDown })).status).toBe(503);
    expect((await create(app, {})).status).toBe(201);
    expect(env.ABUSE_LIMITER).toBeDefined();
  });
});
