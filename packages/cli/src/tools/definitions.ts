/**
 * The MCP tools this CLI was built against, read from `@app/mcp`'s `buildTools`: the very objects
 * the server registers, so the command table can't drift from the server's tool definitions.
 *
 * `build.mjs` evaluates this module once and inlines its result as JSON, so the published bundle
 * carries no `@app/mcp` code. Tests and the typechecker import it directly.
 */
import { buildTools, type McpBackend, type ToolName } from "@app/mcp";
import type { WireTool } from "./schema.js";

/** Handlers never run here: only names, descriptions and schemas are read. */
const inertBackend = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error("tool handlers are not callable from the CLI")) },
) as McpBackend;

export const TOOL_DEFINITIONS: readonly WireTool[] = Object.values(buildTools(inertBackend)).map(
  (t) => ({
    name: t.name satisfies ToolName,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }),
);
