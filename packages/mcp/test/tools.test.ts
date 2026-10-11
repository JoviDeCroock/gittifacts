import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createPlatformClient, type PlatformClient } from "../src/client.js";
import { parseToolError } from "../src/index.js";
import type { CHANGE_STATUSES } from "../src/schemas.js";
import { fakeBackend } from "./support/fake-backend.js";
import { bearerFor, serveMcp } from "./support/http-server.js";

const backend = fakeBackend();
let server: Awaited<ReturnType<typeof serveMcp>>;
let mcp: PlatformClient;

beforeAll(async () => {
  server = await serveMcp(backend);
  mcp = await createPlatformClient(server.url, bearerFor("ag_1"));
});

afterAll(async () => {
  await mcp.client.close();
  await server.close();
});

function errorOf(result: { isError?: boolean; content?: unknown }) {
  expect(result.isError).toBe(true);
  const content = result.content as { type: string; text: string }[];
  return parseToolError(content[0]!.text);
}

describe("gittifacts MCP tools", () => {
  it("lists every tool with input and output schemas", async () => {
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_change",
      "close_workspace",
      "compare_attempts",
      "create_plan",
      "create_project",
      "dequeue",
      "enqueue",
      "get_change_status",
      "get_evidence",
      "get_plan",
      "get_qa",
      "get_rollout",
      "get_tour",
      "list_audit_events",
      "list_changes",
      "list_issues_for_change",
      "list_members",
      "list_plans",
      "list_repos",
      "open_workspace",
      "propose_platform_config",
      "queue_overview",
      "queue_status",
      "refresh_push_token",
      "reprioritize",
      "request_qa",
      "request_review",
      "rerun_ci",
      "search_tools",
      "start_change",
      "wait_for_change",
      "wait_for_merge",
      "whoami",
      "withdraw_plan",
      "ws_commit_push",
      "ws_diff",
      "ws_exec",
      "ws_read",
      "ws_write",
    ]);
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(20);
      expect(t.outputSchema, t.name).toBeDefined();
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).not.toContain("create_plan");
    expect(readOnly).toContain("get_change_status");
  });

  it("get_change_status returns typed structured content with next steps", async () => {
    const r = await mcp.tools.get_change_status({ changeId: "chg_1" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expectTypeOf(r.structuredContent.change.status).toEqualTypeOf<
      (typeof CHANGE_STATUSES)[number]
    >();
    expectTypeOf(r.structuredContent.change.lane).toEqualTypeOf<0 | 1 | 2 | null>();
    expect(r.structuredContent.change).toMatchObject({
      id: "chg_1",
      status: "awaiting-review",
      lane: 1,
      category: "feature",
    });
    expect(r.structuredContent.runs[0]?.steps[0]).toEqual({
      name: "test",
      kind: "user",
      status: "passed",
      logRef: null,
    });
    expect(r.structuredContent.classification).toMatchObject({ lane: 1, blocked: false });
    expect(r.structuredContent.nextSteps.map((s) => s.call)).toContain(
      'request_review({ changeId: "chg_1" })',
    );
  });

  it("create_project returns the project, a first-change push grant and next steps", async () => {
    const r = await mcp.tools.create_project({
      template: "workers-api",
      name: "my-api",
      idempotencyKey: "p1",
    });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expectTypeOf(r.structuredContent.previewUrl).toEqualTypeOf<string | null>();
    expect(r.structuredContent).toMatchObject({
      repoId: "repo_1",
      projectId: "repo_1",
      template: "workers-api",
      bootstrapChangeId: "bs-repo_1",
      token: null,
      remote: { changeId: "chg_2", branch: "main" },
    });
    expect(r.structuredContent.nextSteps[0]?.call).toMatch(/^wait_for_change\(/);
    expect(r.structuredContent.nextSteps[1]?.command).toBe("git push");
    expect(backend.calls).toContain("createProject:p1");
    // Both a template and an import is a validation error with a fix.
    const both = errorOf(
      await mcp.tools.create_project({ template: "workers-api", from: "https://github.com/o/r" }),
    );
    expect(both?.error.code).toBe("invalid-request");
    // It needs change:create (and repo:read) until unclaimed creation exists (O3).
    const readOnly = await createPlatformClient(server.url, bearerFor("ag_3", ["repo:read"]));
    try {
      const denied = errorOf(await readOnly.tools.create_project({ template: "workers-api" }));
      expect(denied?.error.code).toBe("insufficient-scope");
    } finally {
      await readOnly.client.close();
    }
  });

  it("create_plan validates, forwards the idempotency key and suggests the next call", async () => {
    const r = await mcp.tools.create_plan({
      repoId: "repo_1",
      title: "Rate limit logins",
      intent: "Stop credential stuffing on /login.",
      acceptanceCriteria: ["6th attempt in a minute gets 429"],
      idempotencyKey: "k1",
    });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent.plan).toMatchObject({
      id: "plan_1",
      status: "draft",
      authorId: "ag_1",
      scopePaths: [],
    });
    expect(backend.calls).toContain("createPlan:k1");
    expect(r.structuredContent.url).toBe("https://gittifacts.test/plans/plan_1");
    expect(r.structuredContent.nextSteps[0]?.title).toContain(r.structuredContent.url);
    expect(r.structuredContent.nextSteps[1]?.call).toBe('get_plan({ planId: "plan_1" })');
    expect(r.structuredContent.nextSteps[2]?.call).toMatch(/^start_change\(/);
  });

  it("returns the platform error envelope (with fix) as JSON in an isError result", async () => {
    const missing = errorOf(await mcp.tools.get_change_status({ changeId: "nope" }));
    expect(missing).toEqual({
      error: {
        code: "not-found",
        message: "change nope not found",
        fix: { explanation: "List what exists.", call: "list_repos({})" },
      },
    });
    const semantic = errorOf(
      await mcp.tools.create_plan({
        repoId: "repo_1",
        title: "Hi",
        intent: "short",
        acceptanceCriteria: ["x"],
      }),
    );
    expect(semantic?.error.code).toBe("invalid-request");
    expect(semantic?.error.fix.explanation).toMatch(/details/);
  });

  it("enforces scopes per tool and refuses calls without a bearer principal", async () => {
    const readOnly = await createPlatformClient(server.url, bearerFor("ag_2", ["repo:read"]));
    try {
      const denied = errorOf(
        await readOnly.tools.start_change({ repoId: "repo_1", title: "x", category: "fix" }),
      );
      expect(denied?.error).toMatchObject({
        code: "insufficient-scope",
        details: { missing: ["change:create"] },
      });
      const ok = await readOnly.tools.get_tour({ changeId: "chg_1" });
      expect(ok.isError).toBeFalsy();
    } finally {
      await readOnly.client.close();
    }
    const anonymous = await createPlatformClient(server.url, "");
    try {
      const err = errorOf(await anonymous.tools.whoami());
      expect(err?.error.code).toBe("unauthorized");
    } finally {
      await anonymous.client.close();
    }
  });

  it("rerun_ci re-runs on the same head and forwards the reason and idempotency key", async () => {
    const r = await mcp.tools.rerun_ci({
      changeId: "chg_1",
      reason: "flaky",
      idempotencyKey: "k1",
    });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent).toMatchObject({
      headSha: "b".repeat(40),
      change: { id: "chg_1", status: "running", lane: null },
    });
    expect(r.structuredContent.nextSteps[0]?.call).toMatch(/until: "evidence_ready"/);
    expect(backend.calls).toContain("rerunCi:chg_1:flaky:k1");
    expect(errorOf(await mcp.tools.rerun_ci({ changeId: "chg_9" }))?.error.code).toBeDefined();
  });

  it("compare_attempts ranks a plan's attempts, links each, and tells the caller its next step", async () => {
    const r = await mcp.tools.compare_attempts({ planId: "plan_1" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    const out = r.structuredContent;
    expect(out.attempts.map((a) => [a.rank, a.changeId, a.recommended])).toEqual([
      [1, "chg_1", true],
      [2, "chg_2", false],
    ]);
    expect(out.attempts[1]?.reasons).toContain("scope drift");
    expect(out.attempts[0]?.url).toBe("https://gittifacts.test/changes/chg_1");
    expect(out.url).toBe("https://gittifacts.test/plans/plan_1");
    expect(out.recommended).toMatchObject({ changeId: "chg_1", provisional: false });
    // The caller (ag_1) wrote the recommended attempt: ask a person to pick it.
    expect(out.nextSteps[0]?.call).toBe('request_review({ changeId: "chg_1" })');
  });

  it("close_change abandons with a reason; it is marked destructive", async () => {
    const r = await mcp.tools.close_change({ changeId: "chg_1", reason: "superseded" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent.change.status).toBe("abandoned");
    expect(backend.calls).toContain("closeChange:chg_1:superseded:-");
    const tool = (await mcp.listTools()).find((t) => t.name === "close_change");
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it("get_change_status carries previewUrl (null when the backend knows none)", async () => {
    const r = await mcp.tools.get_change_status({ changeId: "chg_1" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent.previewUrl).toBeNull();
  });

  it("request_review records the request, says nobody is messaged, and never approves", async () => {
    const r = await mcp.tools.request_review({ changeId: "chg_1", message: "please look" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent).toMatchObject({
      changeId: "chg_1",
      requested: true,
      status: "awaiting-review",
    });
    expect(r.structuredContent).not.toHaveProperty("notified");
    expect(r.structuredContent.nextSteps[0]?.title).toBe(
      "Hand a person the change's page: https://gittifacts.test/changes/chg_1",
    );
  });
});
