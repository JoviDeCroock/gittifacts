import type { PlatformIntrospection } from "@app/mcp";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  bundledCommands,
  commandName,
  deriveCommand,
  findCommand,
  kebab,
  usageOf,
} from "../src/tools/commands.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import { toWireTool } from "../src/tools/schema.js";

const byName = (name: string) => {
  const c = findCommand(name);
  if (!c) throw new Error(`no command ${name}`);
  return c;
};

describe("command table generated from the MCP tool definitions", () => {
  it("has exactly one command per @app/mcp tool, named with dashes", () => {
    const tools = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(tools).toEqual([
      "close_workspace",
      "create_plan",
      "create_project",
      "get_change_status",
      "get_evidence",
      "get_tour",
      "list_issues_for_change",
      "list_repos",
      "open_workspace",
      "propose_platform_config",
      "refresh_push_token",
      "request_review",
      "start_change",
      "wait_for_change",
      "whoami",
      "ws_commit_push",
      "ws_diff",
      "ws_exec",
      "ws_read",
      "ws_write",
    ]);
    expect(
      bundledCommands()
        .map((c) => c.command)
        .sort(),
    ).toEqual(tools.map(commandName).sort());
    for (const c of bundledCommands()) {
      expect(c.tool).toBe(c.command.replaceAll("-", "_"));
      expect(c.description.length, c.command).toBeGreaterThan(20);
      expect(c.source).toBe("bundled");
    }
  });

  it("matches the typed introspection contract", () => {
    type Names = keyof PlatformIntrospection["tools"];
    const names = TOOL_DEFINITIONS.map((t) => t.name) as Names[];
    expectTypeOf(names).toEqualTypeOf<Names[]>();
    // every type-level tool name is in the runtime table
    const all: Record<Names, true> = {
      whoami: true,
      list_repos: true,
      create_plan: true,
      start_change: true,
      get_change_status: true,
      get_evidence: true,
      get_tour: true,
      request_review: true,
      list_issues_for_change: true,
      refresh_push_token: true,
      wait_for_change: true,
      create_project: true,
      open_workspace: true,
      ws_exec: true,
      ws_read: true,
      ws_write: true,
      ws_diff: true,
      ws_commit_push: true,
      close_workspace: true,
      propose_platform_config: true,
    };
    expect(new Set(names)).toEqual(new Set(Object.keys(all)));
  });

  it("derives flags from top-level input properties", () => {
    const status = byName("get-change-status");
    expect(status.flags).toEqual([
      expect.objectContaining({
        flag: "--change-id",
        property: "changeId",
        kind: "string",
        required: true,
      }),
    ]);
    expect(status.positional).toBe("changeId");
    expect(status.mutating).toBe(false);

    const plan = byName("create_plan");
    expect(plan.mutating).toBe(true);
    expect(plan.idempotencyArg).toBe(true);
    expect(plan.flags.map((f) => f.flag)).not.toContain("--idempotency-key");
    const flag = (p: string) => plan.flags.find((f) => f.property === p);
    expect(flag("acceptanceCriteria")).toMatchObject({
      kind: "string",
      list: true,
      required: true,
    });
    expect(flag("riskDeclarations")).toMatchObject({ kind: "json", list: false, required: false });
    expect(flag("intent")?.description).toMatch(/problem/);
    expect(plan.positional).toBeNull();

    const start = byName("start-change");
    expect(start.flags.find((f) => f.property === "category")).toMatchObject({
      kind: "enum",
      values: ["fix", "feature", "refactor", "dependency", "transform", "revert", "docs", "chore"],
    });

    const wait = byName("wait-for-change");
    expect(wait.flags.find((f) => f.property === "until")?.values).toEqual([
      "evidence_ready",
      "lane_assigned",
      "tour_ready",
      "merged",
      "reverted",
    ]);
    expect(wait.flags.find((f) => f.property === "timeoutSec")).toMatchObject({
      flag: "--timeout-sec",
      kind: "integer",
    });
    expect(byName("refresh-push-token")).toMatchObject({ mutating: true, idempotencyArg: false });
  });

  it("turns a tool it has never seen into a command (live tools/list)", () => {
    const wire = toWireTool({
      name: "open_workspace",
      title: "Open a workspace",
      description: "Start a sandbox for a change.",
      inputSchema: {
        type: "object",
        properties: {
          changeId: { type: "string" },
          ttlMinutes: { type: "integer" },
          warm: { type: "boolean" },
          env: { type: "object" },
          lanes: { type: "array", items: { enum: [0, 1, 2] } },
        },
        required: ["changeId"],
      },
      annotations: { readOnlyHint: false },
    });
    expect(wire).not.toBeNull();
    const c = deriveCommand(wire!, "server");
    expect(c.command).toBe("open-workspace");
    expect(c.source).toBe("server");
    expect(c.flags.map((f) => [f.flag, f.kind, f.list])).toEqual([
      ["--change-id", "string", false],
      ["--ttl-minutes", "integer", false],
      ["--warm", "boolean", false],
      ["--env", "json", false],
      ["--lanes", "enum", true],
    ]);
    expect(usageOf(c)).toBe(
      "gittifacts open-workspace <changeId> [--ttl-minutes <integer>] [--warm] [--env <json>] [--lanes <0|1|2>...] [--idempotency-key <key>]",
    );
  });

  it("rejects malformed tools/list entries", () => {
    expect(toWireTool(null)).toBeNull();
    expect(toWireTool({ name: "" })).toBeNull();
    expect(toWireTool({ name: "x" })?.inputSchema).toEqual({ type: "object" });
  });

  it("kebab-cases property names", () => {
    expect(kebab("changeId")).toBe("change-id");
    expect(kebab("timeout_sec")).toBe("timeout-sec");
    expect(kebab("agentTraceId")).toBe("agent-trace-id");
    expect(kebab("URLPath")).toBe("url-path");
  });
});
