/** Remote-workspace and import-detection tools (src/tools/workspace.ts, src/tools/import.ts). */
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createPlatformClient, type PlatformClient } from "../src/client.js";
import { parseToolError } from "../src/index.js";
import { fakeBackend } from "./support/fake-backend.js";
import { bearerFor, serveMcp } from "./support/http-server.js";

const backend = fakeBackend();
let server: Awaited<ReturnType<typeof serveMcp>>;
let mcp: PlatformClient;
let readOnly: PlatformClient;

beforeAll(async () => {
  server = await serveMcp(backend);
  mcp = await createPlatformClient(server.url, bearerFor("ag_1"));
  readOnly = await createPlatformClient(server.url, bearerFor("ag_ro", ["repo:read"]));
});

afterAll(async () => {
  await mcp.client.close();
  await readOnly.client.close();
  await server.close();
});

function errorOf(result: { isError?: boolean; content?: unknown }) {
  expect(result.isError).toBe(true);
  const content = result.content as { type: string; text: string }[];
  return parseToolError(content[0]!.text);
}

describe("workspace tools", () => {
  it("open_workspace returns the workspace, its tools as ready calls and next steps", async () => {
    const r = await mcp.tools.open_workspace({ changeId: "chg_1", idempotencyKey: "k1" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    const ws = r.structuredContent;
    expectTypeOf(ws.status).toEqualTypeOf<
      "starting" | "ready" | "sleeping" | "closed" | "expired"
    >();
    expect(ws).toMatchObject({ workspaceId: "ws-chg_1", changeId: "chg_1", status: "ready" });
    expect(ws.tools.map((t) => t.name)).toEqual([
      "ws_exec",
      "ws_read",
      "ws_write",
      "ws_diff",
      "ws_commit_push",
      "close_workspace",
    ]);
    expect(ws.tools[0]?.call).toBe('ws_exec({ workspaceId: "ws-chg_1", command: "pnpm test" })');
    expect(ws.nextSteps.length).toBeGreaterThan(0);
    expect(backend.calls).toContain("openWorkspace:chg_1:k1");
  });

  it("scope-checks every tool: a read-only agent can read and diff but not exec, write or push", async () => {
    const read = await readOnly.tools.ws_read({ workspaceId: "ws-chg_1", path: "package.json" });
    expect(read.isError).toBeFalsy();
    for (const r of [
      await readOnly.tools.open_workspace({ changeId: "chg_1" }),
      await readOnly.tools.ws_exec({ workspaceId: "ws-chg_1", command: "ls" }),
      await readOnly.tools.ws_write({ workspaceId: "ws-chg_1", path: "a", content: "x" }),
      await readOnly.tools.ws_commit_push({ workspaceId: "ws-chg_1", message: "m" }),
      await readOnly.tools.close_workspace({ workspaceId: "ws-chg_1" }),
      await readOnly.tools.propose_platform_config({ repoId: "repo_1" }),
    ]) {
      expect(errorOf(r)?.error.code).toBe("insufficient-scope");
    }
  });

  it("ws_write needs exactly one of content and patch", async () => {
    const both = await mcp.tools.ws_write({
      workspaceId: "ws-chg_1",
      path: "a.ts",
      content: "x",
      patch: "--- a\n+++ b\n",
    });
    expect(errorOf(both)?.error.code).toBe("invalid-request");
    const neither = await mcp.tools.ws_write({ workspaceId: "ws-chg_1", path: "a.ts" });
    expect(errorOf(neither)?.error.code).toBe("invalid-request");
    const ok = await mcp.tools.ws_write({ workspaceId: "ws-chg_1", path: "a.ts", content: "x" });
    if (ok.isError) throw new Error(JSON.stringify(ok.content));
    expect(ok.structuredContent).toMatchObject({ path: "a.ts", mode: "content" });
  });

  it("rejects malformed workspace ids and line ranges before the backend", async () => {
    const bad = await mcp.tools.ws_read({ workspaceId: "nope", path: "a" });
    expect(bad.isError).toBe(true);
    const range = await mcp.tools.ws_read({
      workspaceId: "ws-chg_1",
      path: "a",
      startLine: 5,
      endLine: 2,
    });
    expect(errorOf(range)?.error.code).toBe("invalid-request");
  });

  it("ws_exec and ws_commit_push shape results with next steps", async () => {
    const ex = await mcp.tools.ws_exec({
      workspaceId: "ws-chg_1",
      command: "pnpm test",
      timeoutSec: 30,
    });
    if (ex.isError) throw new Error(JSON.stringify(ex.content));
    expect(ex.structuredContent).toMatchObject({ exitCode: 0, stdout: "ok\n", timedOut: false });
    expect(backend.calls).toContain("wsExec:pnpm test:30");

    const pushed = await mcp.tools.ws_commit_push({ workspaceId: "ws-chg_1", message: "fix" });
    if (pushed.isError) throw new Error(JSON.stringify(pushed.content));
    expect(pushed.structuredContent.nextSteps[0]?.call).toBe(
      'wait_for_change({ changeId: "chg_1", until: "evidence_ready" })',
    );
  });
});

describe("propose_platform_config", () => {
  it("returns the plan, the change and the detection with next steps for a human", async () => {
    const r = await mcp.tools.propose_platform_config({ repoId: "repo_1", idempotencyKey: "p" });
    if (r.isError) throw new Error(JSON.stringify(r.content));
    expect(r.structuredContent).toMatchObject({
      status: "proposed",
      planId: "plan_9",
      changeId: "chg_9",
      detection: { packageManager: "pnpm", testRunner: "vitest" },
    });
    expect(r.structuredContent.nextSteps.map((s) => s.call)).toContain(
      'wait_for_change({ changeId: "chg_9", until: "tour_ready" })',
    );
    expect(backend.calls).toContain("proposePlatformConfig:repo_1:false:p");
  });
});
