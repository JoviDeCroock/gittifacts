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
      "create_plan",
      "get_change_status",
      "get_evidence",
      "get_tour",
      "list_issues_for_change",
      "list_repos",
      "refresh_push_token",
      "request_review",
      "start_change",
      "wait_for_change",
      "whoami",
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
    expect(r.structuredContent.nextSteps[1]?.call).toMatch(/^start_change\(/);
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

  it("request_review notifies and never approves", async () => {
    const r = await mcp.tools.request_review({ changeId: "chg_1", message: "please look" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent).toMatchObject({
      changeId: "chg_1",
      notified: true,
      status: "awaiting-review",
    });
  });
});
