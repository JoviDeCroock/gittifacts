/**
 * The exact text a person pastes to start something: the prompt that hands an intent to their
 * agent, the clone command, and the MCP client setup (docs: get-started/agents.md). Pure, so the
 * shapes are unit-tested against what the CLI, /start and the MCP clients accept.
 */

/** "Use <origin>/start. In repo <id>, draft a plan for: <intent>". */
export function agentPrompt(origin: string, repoId: string, intent: string): string {
  return `Use ${origin}/start. In repo ${repoId}, draft a plan for: ${intent.trim()}`;
}

/** The CLI's clone, from the tarball this host serves (`gittifacts clone <repoId>`). */
export function cloneCommand(origin: string, repoId: string): string {
  return `npx -y ${origin}/cli/v2/gittifacts.tgz clone ${repoId}`;
}

export type McpClient = "claude" | "json" | "other";

/** One client's setup; with a hand-made token, its Authorization header filled in. */
export function mcpSnippet(client: McpClient, origin: string, token?: string): string {
  const url = `${origin}/mcp`;
  switch (client) {
    case "claude":
      return `claude mcp add --transport http gittifacts ${url}${token ? ` --header "Authorization: Bearer ${token}"` : ""}`;
    case "json": {
      const server: Record<string, unknown> = { type: "http", url };
      if (token) server.headers = { Authorization: `Bearer ${token}` };
      return JSON.stringify({ mcpServers: { gittifacts: server } }, null, 2);
    }
    case "other":
      return token ? `URL: ${url}\nHeader: Authorization: Bearer ${token}` : url;
  }
}
