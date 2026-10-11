import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseToolError } from "@app/mcp";
import { createPlatformClient } from "@app/mcp/client";
import { describe, expect, it } from "vitest";
import { changeFixture, classificationFixture, HEAD_SHA, repoFixture, store } from "./fixtures.js";
import {
  call,
  createAgent,
  expectError,
  json,
  makeApp,
  ORIGIN,
  signUpHuman,
  type TestApp,
} from "./http.js";

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
  // The human owns the repo (an owner member via insertRepo); its agent acts with that role.
  const repo = repoFixture({
    claim: { status: "claimed", ownerId: human.principal.id, expiresAt: null },
  });
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
      // The page to hand a person, and the reviews (none yet).
      expect(r.structuredContent.url).toBe(`${ORIGIN}/changes/${change.id}`);
      expect(r.structuredContent.reviews).toEqual([]);
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

  it("request_review records the request (no claim that anyone was notified); a read-only agent cannot start changes", async () => {
    const { app, human, mcp, change } = await setup();
    try {
      const r = await mcp.tools.request_review({
        changeId: change.id,
        message: "ready for a look",
      });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      expect(r.structuredContent.requested).toBe(true);
      expect(r.structuredContent).not.toHaveProperty("notified");
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
    // A tool that needs a token (O3: tools/list, create_project and whoami work without one).
    const rpc = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_repos", arguments: {} },
    };
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

describe("list_changes over MCP", () => {
  it("lists a repo's changes with their pages, by status and only the caller's", async () => {
    const { app, human, agent, repo, change, mcp } = await setup();
    const other = await createAgent(app, human.cookie);
    const otherMcp = await createPlatformClient(`${ORIGIN}/mcp`, other.token, {
      fetch: fetchVia(app),
    });
    try {
      const all = await mcp.tools.list_changes({ repoId: repo.id });
      if (all.isError) throw new Error(JSON.stringify(all.content));
      expect(all.structuredContent.changes).toEqual([
        expect.objectContaining({
          id: change.id,
          status: "awaiting-review",
          lane: 1,
          authorId: agent.principal.id,
          authorKind: "agent",
          url: `${ORIGIN}/changes/${change.id}`,
        }),
      ]);
      const ids = async (
        client: typeof mcp,
        args: Parameters<typeof mcp.tools.list_changes>[0],
      ) => {
        const r = await client.tools.list_changes(args);
        if (r.isError) throw new Error(JSON.stringify(r.content));
        return r.structuredContent.changes.map((c) => c.id);
      };
      expect([
        await ids(mcp, { repoId: repo.id, status: "awaiting-review" }),
        await ids(mcp, { repoId: repo.id, status: "merged" }),
        await ids(mcp, { repoId: repo.id, mine: true }),
        await ids(otherMcp, { repoId: repo.id, mine: true }),
      ]).toEqual([[change.id], [], [change.id], []]);
      // A repo the caller cannot see answers like one that does not exist.
      const unknown = errorOf(await mcp.tools.list_changes({ repoId: "repo_nope" }));
      expect(unknown?.error.code).toBe("not-found");
    } finally {
      await mcp.client.close();
      await otherMcp.client.close();
    }
  });
});

describe("plans over MCP: get_plan, list_plans, withdraw_plan", () => {
  const draft = (repoId: string, title: string) => ({
    repoId,
    title,
    intent: "Return the current time as JSON for the status page.",
    acceptanceCriteria: ["GET /time returns { now: <ISO> }"],
    scopePaths: ["src/**"],
  });

  it("an agent drafts a plan, a human approves it over HTTP, the agent sees it approved", async () => {
    const { app, human, agent, repo, mcp } = await setup();
    try {
      const created = await mcp.tools.create_plan(draft(repo.id, "Add /time endpoint"));
      if (created.isError) throw new Error(JSON.stringify(created.content));
      const planId = created.structuredContent.plan.id;
      const page = `${ORIGIN}/plans/${planId}`;
      expect(created.structuredContent.url).toBe(page);
      expect(created.structuredContent.nextSteps[0]?.title).toContain(page);

      const drafted = await mcp.tools.get_plan({ planId });
      if (drafted.isError) throw new Error(JSON.stringify(drafted.content));
      expect(drafted.structuredContent).toMatchObject({
        plan: { id: planId, status: "draft", scopePaths: ["src/**"], url: page },
        author: { id: agent.principal.id, kind: "agent" },
        approver: null,
        changes: [],
        url: page,
      });
      expect(drafted.structuredContent.nextSteps.map((n) => n.call?.split("(")[0])).toEqual([
        undefined,
        "get_plan",
        "withdraw_plan",
      ]);

      // The agent can't approve its plan; the refusal names the page where a person does.
      const refused = await expectError(
        await call(app, "POST", `/api/v1/plans/${planId}/approve`, {
          token: agent.token,
          body: {},
        }),
        403,
        "forbidden",
      );
      expect(refused.error.fix.call).toBe(`get_plan({ planId: "${planId}" })`);
      expect(refused.error.fix.explanation).toContain(page);

      const approved = await call(app, "POST", `/api/v1/plans/${planId}/approve`, {
        cookie: human.cookie,
        body: {},
      });
      expect(approved.status).toBe(200);
      const after = await mcp.tools.get_plan({ planId });
      if (after.isError) throw new Error(JSON.stringify(after.content));
      expect(after.structuredContent.plan.status).toBe("approved");
      expect(after.structuredContent.approver).toMatchObject({
        id: human.principal.id,
        kind: "human",
      });
      expect(after.structuredContent.nextSteps[0]?.call).toBe(
        `start_change({ repoId: "${repo.id}", planId: "${planId}", title: "Add /time endpoint", category: "feature" })`,
      );

      const approvedOnly = await mcp.tools.list_plans({ repoId: repo.id, status: "approved" });
      if (approvedOnly.isError) throw new Error(JSON.stringify(approvedOnly.content));
      expect(approvedOnly.structuredContent.plans).toEqual([
        expect.objectContaining({ id: planId, status: "approved", url: page }),
      ]);
      const drafts = await mcp.tools.list_plans({ repoId: repo.id, status: "draft" });
      if (drafts.isError) throw new Error(JSON.stringify(drafts.content));
      expect(drafts.structuredContent.plans).toEqual([]);
    } finally {
      await mcp.client.close();
    }
  });

  it("an agent withdraws its own draft, never another principal's", async () => {
    const { app, human, agent, repo, mcp } = await setup();
    const other = await createAgent(app, human.cookie);
    const otherMcp = await createPlatformClient(`${ORIGIN}/mcp`, other.token, {
      fetch: fetchVia(app),
    });
    try {
      const created = await mcp.tools.create_plan(draft(repo.id, "Add /time endpoint"));
      if (created.isError) throw new Error(JSON.stringify(created.content));
      const planId = created.structuredContent.plan.id;

      // Another agent (same owner, same role) can't withdraw it: not over MCP, not over HTTP.
      const viaMcp = errorOf(await otherMcp.tools.withdraw_plan({ planId, reason: "mine now" }));
      expect(viaMcp?.error.code).toBe("forbidden");
      await expectError(
        await call(app, "POST", `/api/v1/plans/${planId}/withdraw`, {
          token: other.token,
          body: {},
        }),
        403,
        "forbidden",
      );
      // Nor reject it: that is a person's call; the refusal offers withdraw for one's own drafts.
      const reject = await expectError(
        await call(app, "POST", `/api/v1/plans/${planId}/reject`, {
          token: other.token,
          body: { comment: "no" },
        }),
        403,
        "forbidden",
      );
      expect(reject.error.fix.call).toBe(`withdraw_plan({ planId: "${planId}", reason: "<why>" })`);
      const mine = await otherMcp.tools.list_plans({ repoId: repo.id, mine: true });
      if (mine.isError) throw new Error(JSON.stringify(mine.content));
      expect(mine.structuredContent.plans).toEqual([]);

      // Its author can, once.
      const withdrawn = await mcp.tools.withdraw_plan({
        planId,
        reason: "superseded by a smaller one",
      });
      if (withdrawn.isError) throw new Error(JSON.stringify(withdrawn.content));
      expect(withdrawn.structuredContent.plan).toMatchObject({
        id: planId,
        status: "rejected",
        rejectionReason: "superseded by a smaller one",
      });
      expect(withdrawn.structuredContent.nextSteps[0]?.title).toMatch(/^Withdrawn by its author/);
      const again = errorOf(await mcp.tools.withdraw_plan({ planId }));
      expect(again?.error.code).toBe("invalid-state");
      const read = await json<{ plan: { status: string; rejectedBy: string } }>(
        await call(app, "GET", `/api/v1/plans/${planId}`, { cookie: human.cookie }),
      );
      expect(read.plan).toMatchObject({ status: "rejected", rejectedBy: agent.principal.id });

      // Over HTTP too: an agent author withdraws its draft with POST /withdraw (200).
      const second = await mcp.tools.create_plan(draft(repo.id, "Add /date endpoint"));
      if (second.isError) throw new Error(JSON.stringify(second.content));
      const res = await call(
        app,
        "POST",
        `/api/v1/plans/${second.structuredContent.plan.id}/withdraw`,
        {
          token: agent.token,
          body: { reason: "not needed" },
        },
      );
      expect(res.status).toBe(200);
      expect((await json<{ plan: { status: string } }>(res)).plan.status).toBe("rejected");
    } finally {
      await mcp.client.close();
      await otherMcp.client.close();
    }
  });
});
