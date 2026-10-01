/**
 * The MCP connection: the SDK v2 `Client` over streamable HTTP at `<host>/mcp`, wrapped by
 * mcp-tada so calls are typed from the tool definitions (`@app/mcp`'s `PlatformIntrospection`).
 */
import type { PlatformIntrospection } from "@app/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  type ContentBlock,
  initMcpTada,
  type RequestOptions,
  type Tool,
  type TypedClient,
} from "mcp-tada";
import { CLI_VERSION } from "./version.js";

/**
 * Typed from the tool definitions. Tools the platform is still adding (e.g. `create_project`) are
 * called by name through `callAnyTool` and their results validated at runtime, so this CLI keeps
 * compiling whatever schema they land with.
 */
export type CliIntrospection = PlatformIntrospection;
export type PlatformMcp = TypedClient<CliIntrospection>;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectOptions {
  mcpUrl: string;
  token: string | null;
  /** Extra headers on every request (e.g. `Idempotency-Key` for a mutating command). */
  headers?: Record<string, string>;
  fetch?: FetchLike | undefined;
}

export interface McpConnection {
  mcp: PlatformMcp;
  close(): Promise<void>;
}

export type Connector = (opts: ConnectOptions) => Promise<McpConnection>;

export const connectMcp: Connector = async (opts) => {
  const client = new Client({ name: "gittifacts-cli", version: CLI_VERSION });
  const headers: Record<string, string> = {
    "x-gittifacts-client": `gittifacts-cli/${CLI_VERSION}`,
    ...opts.headers,
  };
  // Unauthenticated calls are allowed (unclaimed projects): no token, no header.
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const transport = new StreamableHTTPClientTransport(new URL(opts.mcpUrl), {
    requestInit: { headers },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  await client.connect(transport);
  return {
    mcp: initMcpTada<CliIntrospection>().typed(client),
    close: () => client.close(),
  };
};

/** A tool result before narrowing (any tool, including ones newer than this build). */
export interface AnyToolResult {
  content: ContentBlock[];
  isError?: boolean | undefined;
  structuredContent?: unknown;
}

type DynamicCall = (
  name: string,
  args: Record<string, unknown>,
  options?: RequestOptions,
) => Promise<AnyToolResult>;

/**
 * Calls a tool by its runtime name. Generated commands dispatch on names that may only exist on
 * the live server, so the compile-time name narrowing of `callTool` is widened here, once; mcp-tada
 * forwards any name to `tools/call` unchanged.
 */
export function callAnyTool(
  mcp: PlatformMcp,
  name: string,
  args: Record<string, unknown>,
  options?: RequestOptions,
): Promise<AnyToolResult> {
  const call = mcp.callTool as unknown as DynamicCall;
  return call(name, args, options);
}

export type { RequestOptions, Tool };
