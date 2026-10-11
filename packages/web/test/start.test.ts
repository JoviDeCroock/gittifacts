import { describe, expect, it } from "vitest";
import { agentPrompt, cloneCommand, mcpSnippet } from "../src/lib/start.js";

const O = "https://gf.example";

describe("what a person pastes to start", () => {
  it("hands an intent to the agent through /start", () => {
    expect(agentPrompt(O, "repo_1", "  Show tax per line.\n")).toBe("Use https://gf.example/start. In repo repo_1, draft a plan for: Show tax per line.");
  });

  it("clones with the CLI the host serves", () => {
    expect(cloneCommand(O, "repo_1")).toBe("npx -y https://gf.example/cli/v2/gittifacts.tgz clone repo_1");
  });

  it("sets up each MCP client the way get-started/agents.md shows, with the token when there is one", () => {
    expect(mcpSnippet("claude", O)).toBe("claude mcp add --transport http gittifacts https://gf.example/mcp");
    expect(mcpSnippet("claude", O, "gtf_x")).toBe('claude mcp add --transport http gittifacts https://gf.example/mcp --header "Authorization: Bearer gtf_x"');
    expect(JSON.parse(mcpSnippet("json", O))).toEqual({ mcpServers: { gittifacts: { type: "http", url: "https://gf.example/mcp" } } });
    expect(JSON.parse(mcpSnippet("json", O, "gtf_x"))).toEqual({ mcpServers: { gittifacts: { type: "http", url: "https://gf.example/mcp", headers: { Authorization: "Bearer gtf_x" } } } });
    expect(mcpSnippet("other", O)).toBe("https://gf.example/mcp");
    expect(mcpSnippet("other", O, "gtf_x")).toContain("Authorization: Bearer gtf_x");
  });
});
