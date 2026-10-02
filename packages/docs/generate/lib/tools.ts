/**
 * The MCP tool definitions exactly as the server registers them (`buildTools()` from @app/mcp),
 * read with an inert backend: only names, descriptions and schemas are used, handlers never run.
 * Shared by the MCP reference generator and the sample checks.
 */
import { buildTools, type McpBackend } from "@app/mcp";

export interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

const inert = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error("docs: tool handlers are never called")) },
) as McpBackend;

let cache: ToolDef[] | null = null;

export function mcpTools(): ToolDef[] {
  cache ??= Object.values(buildTools(inert)).map((t) => ({
    name: t.name,
    ...(t.title === undefined ? {} : { title: t.title }),
    ...(t.description === undefined ? {} : { description: t.description }),
    inputSchema: t.inputSchema,
    ...(t.outputSchema === undefined ? {} : { outputSchema: t.outputSchema }),
    ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
  }));
  return cache;
}
