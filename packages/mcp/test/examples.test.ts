/**
 * `search_tools` hands agents an example call per tool. Each one must parse in the
 * `tool_name({ ... })` notation and validate against that tool's input schema with the validator
 * the server itself runs (enums included; string patterns are not checked, so "<placeholders>"
 * stand in for ids).
 */
import { validate } from "mcp-tada-server";
import { describe, expect, it } from "vitest";
import { parseCall } from "../../conventions/src/calls.js";
import { buildTools, exampleCall, type McpBackend } from "../src/index.js";
import { TOOL_EXAMPLES } from "../src/tools/queue.js";

const inert = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error("handlers are never called here")) },
) as McpBackend;
const tools = Object.values(buildTools(inert)) as {
  name: string;
  inputSchema: Record<string, unknown>;
}[];

describe("search_tools examples", () => {
  it("name real tools", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const name of Object.keys(TOOL_EXAMPLES)) expect(names, name).toContain(name);
  });

  it.each(tools.map((t) => [t.name, t] as const))("%s: parses and validates", (name, tool) => {
    const example = exampleCall(name, tool.inputSchema);
    const parsed = parseCall(example);
    expect(parsed, example).not.toBeNull();
    expect(parsed?.tool).toBe(name);
    expect(validate(tool.inputSchema, parsed?.args), example).toEqual([]);
  });

  it("catches a wrong enum value", () => {
    const create = tools.find((t) => t.name === "create_project");
    expect(create).toBeDefined();
    const errors = validate(create?.inputSchema ?? {}, { template: "worker-api" });
    expect(errors.length).toBeGreaterThan(0);
  });
});
