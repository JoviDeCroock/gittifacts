/**
 * Workspace lifecycle on the real Workspace / ProjectLedger DOs (in-memory machine): owner and
 * author checks, path rules, idle sleep with snapshot and resume, hard TTL, the daily quota.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseToolError } from "@app/mcp";
import { createPlatformClient, type PlatformClient } from "@app/mcp/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureWorkspaceRuntime } from "../../src/workspace/runtime.js";
import { call, createAgent, json, ORIGIN, signUpHuman, type TestApp } from "../http.js";
import { type IntegrationFakes, resetIntegrationFakes } from "./fakes.js";
import { fetchVia, platformApp } from "./harness.js";
import { fakeMachineFor, resetFakeWorkspaces } from "./workspace-fakes.js";

let fakes: IntegrationFakes;
let clock = Date.parse("2026-10-02T10:00:00.000Z");
let app: TestApp;
let clients: PlatformClient[] = [];

beforeEach(() => {
  fakes = resetIntegrationFakes();
  resetFakeWorkspaces();
  clock = Date.parse("2026-10-02T10:00:00.000Z");
  configureWorkspaceRuntime({ machine: (_c, name) => fakeMachineFor(name), now: () => clock });
  app = platformApp();
});

afterEach(async () => {
  configureWorkspaceRuntime({ machine: (_c, name) => fakeMachineFor(name) });
  for (const c of clients) await c.client.close();
  clients = [];
});

async function setup() {
  const human = await signUpHuman(app);
  const agent = await createAgent(app, human.cookie);
  const other = await createAgent(app, human.cookie);
  const created = await call(app, "POST", "/api/v1/repos", {
    cookie: human.cookie,
    body: { name: `wl-${Date.now().toString(36)}` },
  });
  const { repo } = await json<{ repo: { id: string; artifactsName: string } }>(created);
  fakes.git.seed(repo.artifactsName, { "README.md": "# hi\n" });
  const mcp = await createPlatformClient(`${ORIGIN}/mcp`, agent.token, { fetch: fetchVia(app) });
  const mcp2 = await createPlatformClient(`${ORIGIN}/mcp`, other.token, { fetch: fetchVia(app) });
  clients.push(mcp, mcp2);
  const started = await mcp.tools.start_change({ repoId: repo.id, title: "t", category: "fix" });
  if (started.isError) throw new Error(JSON.stringify(started.content));
  const changeId = started.structuredContent.change.id;
  const opened = await mcp.tools.open_workspace({ changeId });
  if (opened.isError) throw new Error(JSON.stringify(opened.content));
  return { repo, mcp, mcp2, changeId, workspaceId: opened.structuredContent.workspaceId };
}

function codeOf(r: { isError?: boolean; content?: unknown }): string | undefined {
  expect(r.isError).toBe(true);
  return parseToolError((r.content as Array<{ text: string }>)[0]?.text ?? "")?.error.code;
}

describe("workspace lifecycle", () => {
  it("only the change's author may open or use it", async () => {
    const { mcp2, changeId, workspaceId } = await setup();
    expect(codeOf(await mcp2.tools.open_workspace({ changeId }))).toBe("forbidden");
    expect(codeOf(await mcp2.tools.ws_exec({ workspaceId, command: "ls" }))).toBe("forbidden");
    expect(codeOf(await mcp2.tools.ws_read({ workspaceId, path: "README.md" }))).toBe("forbidden");
  });

  it("rejects paths outside the checkout and inside .git", async () => {
    const { mcp, workspaceId } = await setup();
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config"]) {
      expect(codeOf(await mcp.tools.ws_read({ workspaceId, path }))).toBe("invalid-input");
      expect(codeOf(await mcp.tools.ws_write({ workspaceId, path, content: "x" }))).toBe(
        "invalid-input",
      );
    }
    expect(codeOf(await mcp.tools.ws_exec({ workspaceId, command: "ls", cwd: "../.." }))).toBe(
      "invalid-input",
    );
  });

  it("sleeps when idle (snapshot + stop) and resumes with its files", async () => {
    const { mcp, workspaceId } = await setup();
    const w = await mcp.tools.ws_write({ workspaceId, path: "notes.txt", content: "kept\n" });
    expect(w.isError).toBeFalsy();
    clock += 11 * 60_000;
    const stub = env.WORKSPACE.getByName(workspaceId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const machine = fakeMachineFor(workspaceId);
    expect(machine.running).toBe(false);
    const read = await mcp.tools.ws_read({ workspaceId, path: "notes.txt" });
    if (read.isError) throw new Error(JSON.stringify(read.content));
    expect(read.structuredContent.content).toBe("kept\n");
    expect(machine.boots.at(-1)?.from.kind).toBe("sleep-snapshot");
  });

  it("expires at its hard TTL and says how to start again", async () => {
    const { mcp, changeId, workspaceId } = await setup();
    clock += 2 * 60 * 60_000 + 1000;
    await runDurableObjectAlarm(env.WORKSPACE.getByName(workspaceId));
    const r = await mcp.tools.ws_exec({ workspaceId, command: "ls" });
    expect(codeOf(r)).toBe("invalid-state");
    const fix = parseToolError((r.content as Array<{ text: string }>)[0]?.text ?? "")?.error.fix;
    expect(fix?.call).toBe(`open_workspace({ changeId: "${changeId}" })`);
    const reopened = await mcp.tools.open_workspace({ changeId });
    if (reopened.isError) throw new Error(JSON.stringify(reopened.content));
    expect(reopened.structuredContent.status).toBe("ready");
  });

  it("stops at the project's daily quota", async () => {
    const { repo, mcp, workspaceId } = await setup();
    await env.PROJECT_LEDGER.getByName(repo.id).recordUsage({
      workspaceId,
      cpuSeconds: 10 * 60 * 60,
      containerSeconds: 10 * 60 * 60,
      atMs: clock,
    });
    expect(codeOf(await mcp.tools.ws_exec({ workspaceId, command: "ls" }))).toBe("quota-exceeded");
  });
});
