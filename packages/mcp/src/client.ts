/**
 * Typed client for the gittifacts MCP server (`@app/mcp/client`). Types come from the tool
 * definitions (`IntrospectionOf`), so a tool name, its arguments and its `structuredContent` are
 * checked at compile time. Kept in its own entry so the server bundle never pulls client code.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { initMcpTada } from "mcp-tada";
import type { PlatformIntrospection } from "./tools.js";

export interface PlatformClientOptions {
  /** Custom fetch (e.g. a Worker's `app.fetch` in tests, or a service binding). */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  clientName?: string;
}

export async function createPlatformClient(
  url: string | URL,
  token: string,
  opts: PlatformClientOptions = {},
) {
  const client = new Client({ name: opts.clientName ?? "gittifacts-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  await client.connect(transport);
  return initMcpTada<PlatformIntrospection>().typed(client);
}

export type PlatformClient = Awaited<ReturnType<typeof createPlatformClient>>;
