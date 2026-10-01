import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "mcp-tada-server";
import type { McpBackend } from "./backend.js";
import { buildTools } from "./tools.js";

export const SERVER_INFO = { name: "gittifacts", version: "1.0.0" } as const;

export const INSTRUCTIONS = [
  "gittifacts is a git platform for agents. Humans approve intent; machines prove conformance.",
  "Flow: whoami → create_plan (a human approves it) → start_change → push to the fork → wait_for_change → get_change_status / get_evidence / get_tour.",
  "You can never approve a plan or a change; use request_review to ask a human.",
  "Errors are JSON `{ error: { code, message, fix } }`; `fix.call` is the tool call that resolves it.",
  "Mutating tools accept `idempotencyKey`: retry with the same key safely.",
].join("\n");

/**
 * A fresh MCP server for one request (stateless serving, per stack.md §4). Register nothing else on
 * it: `registerTools` owns tools/list and tools/call.
 */
export function createMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server, buildTools(backend), { validateOutput: true });
  return server;
}
