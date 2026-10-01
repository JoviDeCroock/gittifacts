/**
 * The real MCP server from @app/mcp (`createMcpServer` over a fake `McpBackend`) on a local port,
 * reusing @app/mcp's own test support: bearer tokens are `<principalId>|<scope,scope>`.
 */

import type { MockHandlers } from "mcp-tada/testing";
import { mockMcpTada } from "mcp-tada/testing";
import { fakeBackend } from "../../../mcp/test/support/fake-backend.js";
import { bearerFor, serveMcp } from "../../../mcp/test/support/http-server.js";
import {
  type AnyToolResult,
  type CliIntrospection,
  type Connector,
  callAnyTool,
  type McpConnection,
  type RequestOptions,
} from "../../src/mcp.js";

export { bearerFor, fakeBackend, serveMcp };

export function hostOf(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

type WireTool = { name: string; inputSchema: Record<string, unknown> };

/**
 * A connector backed by mcp-tada's in-memory mock. `untyped` answers tools the platform's
 * definitions don't have yet (e.g. `create_project`), the way a newer server would.
 */
export function mockConnector(
  handlers: MockHandlers<CliIntrospection>,
  opts: {
    listTools?: () => Promise<WireTool[]>;
    untyped?: Record<string, (args: Record<string, unknown>) => unknown>;
  } = {},
): Connector & { connections: { token: string | null; headers: Record<string, string> }[] } {
  const connections: { token: string | null; headers: Record<string, string> }[] = [];
  const untyped = opts.untyped ?? {};
  const connect = async (o: Parameters<Connector>[0]): Promise<McpConnection> => {
    connections.push({ token: o.token, headers: { ...o.headers } });
    const mock = mockMcpTada<CliIntrospection>(handlers);
    const callTool = async (
      name: string,
      args: Record<string, unknown> = {},
      options?: RequestOptions,
    ): Promise<AnyToolResult> => {
      const handler = untyped[name];
      if (!handler) return callAnyTool(mock, name, args, options);
      const value = await handler(args);
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    };
    const listTools =
      opts.listTools ??
      (async () => [
        ...(await mock.listTools()),
        ...Object.keys(untyped).map((name) => ({ name, inputSchema: { type: "object" } })),
      ]);
    const mcp = Object.assign(Object.create(null) as object, mock, { callTool, listTools });
    return { mcp: mcp as typeof mock, close: async () => {} };
  };
  return Object.assign(connect, { connections });
}
