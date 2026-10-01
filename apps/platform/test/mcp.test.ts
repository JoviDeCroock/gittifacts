import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseToolError } from "@app/mcp";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it } from "vitest";
import { changeFixture, classificationFixture, HEAD_SHA, repoFixture, store } from "./fixtures.js";
import { call, createAgent, json, makeApp, ORIGIN, signUpHuman, type TestApp } from "./http.js";

function fetchVia(app: TestApp) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(input, init), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

async function setup() {
  const { app } = makeApp();
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const s = store();
  const repo = repoFixture();
  await s.insertRepo(repo);
  const change = changeFixture(repo.id, agent.principal.id);
  await s.insertChange(change);
  await s.putClassification(change.id, HEAD_SHA, classificationFixture());
  const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
  return { app, human, agent, repo, change, mcp };
}

function errorOf(result: { isError?: boolean; content?: unknown }) {
  expect(result.isError).toBe(true);
  return parseToolError((result.content as { text: string }[])[0]!.text);
}

describe("POST /mcp", () => {
  it("lists the tools and answers get_change_status for an agent token", async () => {
    const { mcp, change } = await setup();
    try {
      const tools = await mcp.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "create_plan",
          "start_change",
          "get_change_status",
          "request_review",
          "whoami",
        ]),
      );
      const r = await mcp.tools.get_change_status({ changeId: change.id });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      expect(r.structuredContent.change).toMatchObject({
        id: change.id,
        status: "awaiting-review",
        lane: 1,
      });
      expect(r.structuredContent.classification).toMatchObject({
        lane: 1,
        computedLane: 1,
        blocked: false,
      });
      expect(r.structuredContent.nextSteps.length).toBeGreaterThan(0);
    } finally {
      await mcp.client.close();
    }
  });

  it("whoami reports the agent, its scopes and that it can never approve", async () => {
    const { mcp, agent, repo } = await setup();
    try {
      const r = await mcp.tools.whoami();
      if (r.isError) throw new Error(JSON.stringify(r.content));
      expect(r.structuredContent).toMatchObject({
        principalId: agent.principal.id,
        kind: "agent",
        canApprove: false,
      });
      const mine = r.structuredContent.repos.find((x) => x.id === repo.id);
      expect(mine?.actions).toEqual(["read", "create-plan", "start-change"]);
      expect(mine?.claim.status).toBe("claimed");
    } finally {
      await mcp.client.close();
    }
  });

  it("create_plan goes through the same service as HTTP, idempotently", async () => {
    const { app, mcp, repo, agent } = await setup();
    try {
      const args = {
        repoId: repo.id,
        title: "Add /time endpoint",
        intent: "Return the current time as JSON for the status page.",
        acceptanceCriteria: ["GET /time returns { now: <ISO> }"],
        idempotencyKey: "mcp-plan-1",
      };
      const a = await mcp.tools.create_plan(args);
      const b = await mcp.tools.create_plan(args);
      if (a.isError || b.isError) throw new Error("create_plan failed");
      expect(b.structuredContent.plan.id).toBe(a.structuredContent.plan.id);
      expect(a.structuredContent.plan).toMatchObject({
        status: "draft",
        authorId: agent.principal.id,
      });
      const plans = await json<{ plans: unknown[] }>(
        await call(app, "GET", `/api/v1/repos/${repo.id}/plans`, { token: agent.token }),
      );
      expect(plans.plans).toHaveLength(1);
    } finally {
      await mcp.client.close();
    }
  });

  it("tool errors carry the platform envelope with a fix", async () => {
    const { mcp, change } = await setup();
    try {
      const notReady = errorOf(await mcp.tools.get_evidence({ changeId: change.id }));
      expect(notReady?.error).toMatchObject({
        code: "not-found",
        fix: { call: `get_change_status({ changeId: "${change.id}" })` },
      });
      const lifecycle = errorOf(await mcp.tools.refresh_push_token({ changeId: change.id }));
      expect(lifecycle?.error.code).toBe("upstream");
      expect(lifecycle?.error.fix.explanation.length).toBeGreaterThan(0);
    } finally {
      await mcp.client.close();
    }
  });

  it("request_review notifies a human; a read-only agent cannot start changes", async () => {
    const { app, human, mcp, change } = await setup();
    try {
      const r = await mcp.tools.request_review({
        changeId: change.id,
        message: "ready for a look",
      });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      expect(r.structuredContent.notified).toBe(true);
    } finally {
      await mcp.client.close();
    }
    const reader = await createAgent(app, human.cookie, ["repo:read"]);
    const ro = await createPlatformClient(`${ORIGIN}/mcp`, reader.token, { fetch: fetchVia(app) });
    try {
      const denied = errorOf(
        await ro.tools.start_change({ repoId: "r", title: "t", category: "fix" }),
      );
      expect(denied?.error.code).toBe("insufficient-scope");
    } finally {
      await ro.client.close();
    }
  });

  it("rejects missing/human/invalid bearer tokens and foreign origins", async () => {
    const { app, human, agent } = await setup();
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const headers = {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    };
    const none = await call(app, "POST", "/mcp", {
      body: rpc,
      headers: { ...headers, origin: ORIGIN },
    });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    await none.text();
    // A human session cookie is not an agent token.
    const viaCookie = await call(app, "POST", "/mcp", { body: rpc, cookie: human.cookie, headers });
    expect(viaCookie.status).toBe(401);
    await viaCookie.text();
    const foreign = await call(app, "POST", "/mcp", {
      body: rpc,
      token: agent.token,
      headers: { ...headers, origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    await foreign.text();
  });
});
