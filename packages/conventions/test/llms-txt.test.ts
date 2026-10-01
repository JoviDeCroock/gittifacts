import { describe, expect, it } from "vitest";
import { llmsTxt } from "../src/index.js";
import { HOST, MCP_URL } from "./helpers.js";

describe("llmsTxt", () => {
  const text = llmsTxt({ host: HOST, mcpUrl: MCP_URL, openapiUrl: `${HOST}/openapi.json` });
  const lines = text.split("\n");

  it("follows the llms.txt structure: H1, blockquote, then H2 link sections", () => {
    expect(lines[0]).toBe("# gittifacts");
    expect(lines.find((l) => l !== "" && !l.startsWith("#"))?.startsWith("> ")).toBe(true);
    expect(lines.filter((l) => l.startsWith("# "))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("## "))).toEqual(["## Start", "## Discovery", "## Optional"]);
  });

  it("formats every list item as [name](absolute url): note", () => {
    const items = lines.filter((l) => l.startsWith("- "));
    expect(items.length).toBeGreaterThanOrEqual(7);
    for (const item of items) expect(item).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\): \S/);
  });

  it("points at /start, MCP, OpenAPI and the discovery documents", () => {
    for (const url of [`${HOST}/start`, MCP_URL, `${HOST}/openapi.json`, `${MCP_URL}/server-card`, `${HOST}/.well-known/ai-catalog.json`, `${HOST}/.well-known/oauth-protected-resource/mcp`]) {
      expect(text).toContain(`](${url})`);
    }
  });
});
