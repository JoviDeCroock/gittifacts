/**
 * The real MCP server from @app/mcp (`createMcpServer` over a fake `McpBackend`) on a local port,
 * reusing @app/mcp's own test support: bearer tokens are `<principalId>|<scope,scope>`.
 */
import { mockMcpTada } from "mcp-tada/testing";
import { fakeBackend } from "../../../mcp/test/support/fake-backend.js";
import { bearerFor, serveMcp } from "../../../mcp/test/support/http-server.js";
import type { CliIntrospection, Connector, McpConnection } from "../../src/mcp.js";
import type { MockHandlers } from "mcp-tada/testing";

export { bearerFor, fakeBackend, serveMcp };

export function hostOf(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

/** A connector backed by mcp-tada's in-memory mock (tools the real server doesn't have yet). */
export function mockConnector(
  handlers: MockHandlers<CliIntrospection>,
  opts: { listTools?: () => Promise<{ name: string; inputSchema: Record<string, unknown> }[]> } = {},
): Connector & { connections: { token: string | null; headers: Record<string, string> }[] } {
  const connections: { token: string | null; headers: Record<string, string> }[] = [];
  const connect = async (o: Parameters<Connector>[0]): Promise<McpConnection> => {
    connections.push({ token: o.token, headers: { ...o.headers } });
    const mock = mockMcpTada<CliIntrospection>(handlers);
    const mcp = opts.listTools
      ? Object.assign(Object.create(null) as object, mock, { listTools: opts.listTools })
      : mock;
    return { mcp: mcp as typeof mock, close: async () => {} };
  };
  return Object.assign(connect, { connections });
}
