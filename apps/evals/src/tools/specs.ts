/**
 * The agent's generic tools. Descriptions say what each tool does, never anything about the
 * platform under test: the agent must discover the platform (and its MCP URL) from /start.
 */
import type { ToolSpec } from "../agent/protocol.js";
import type { ToolName } from "../tasks.js";

export const RESULT_MAX_CHARS = 12_000;
export const LIST_TOOLS_MAX_CHARS = 24_000;
export const SHELL_DEFAULT_TIMEOUT_SEC = 120;
export const SHELL_MAX_TIMEOUT_SEC = 600;

const SPECS: Record<ToolName, ToolSpec> = {
  http_fetch: {
    name: "http_fetch",
    description: `Send an HTTP request to any URL. Returns the status, the main response headers and the body (bodies over ${RESULT_MAX_CHARS} characters are truncated). Follows redirects.`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
          description: "Default GET.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Request headers.",
        },
        body: { type: "string", description: "Request body (e.g. JSON text)." },
      },
      required: ["url"],
    },
  },
  mcp_connect: {
    name: "mcp_connect",
    description:
      "Connect to a Model Context Protocol (MCP) server over streamable HTTP. Replaces any current connection. With `token`, every request sends `Authorization: Bearer <token>`.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The MCP server URL." },
        token: { type: "string", description: "Optional bearer token." },
      },
      required: ["url"],
    },
  },
  mcp_list_tools: {
    name: "mcp_list_tools",
    description:
      "List the tools of the connected MCP server: names, descriptions and input schemas.",
    parameters: { type: "object", properties: {} },
  },
  mcp_call: {
    name: "mcp_call",
    description:
      "Call a tool on the connected MCP server. Returns its text content and structured content.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name." },
        arguments: { type: "object", description: "Tool arguments." },
      },
      required: ["name"],
    },
  },
  shell: {
    name: "shell",
    description: `Run a command with sh -c in your own Linux sandbox (git, node 22, npm, pnpm, wrangler; internet access). Every call starts in /workspace; files persist between calls, but cd and exported variables do not. Returns the exit code and the combined stdout/stderr (truncated to ${RESULT_MAX_CHARS} characters). timeout_sec defaults to ${SHELL_DEFAULT_TIMEOUT_SEC} (max ${SHELL_MAX_TIMEOUT_SEC}).`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command." },
        timeout_sec: { type: "integer", minimum: 1, maximum: SHELL_MAX_TIMEOUT_SEC },
      },
      required: ["command"],
    },
  },
};

export function toolSpecs(names: readonly ToolName[]): ToolSpec[] {
  return names.map((n) => SPECS[n]);
}
