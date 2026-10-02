import { describe, expect, it } from "vitest";
import { llmsTxt } from "../src/index.js";
import { HOST, MCP_URL } from "./helpers.js";

describe("llmsTxt", () => {
  const text = llmsTxt({
    host: HOST,
    mcpUrl: MCP_URL,
    openapiUrl: `${HOST}/openapi.json`,
    oauth: true,
  });
  const lines = text.split("\n");

  it("follows the llms.txt structure: H1, blockquote, then H2 link sections", () => {
    expect(lines[0]).toBe("# gittifacts");
    expect(lines.find((l) => l !== "" && !l.startsWith("#"))?.startsWith("> ")).toBe(true);
    expect(lines.filter((l) => l.startsWith("# "))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("## "))).toEqual([
      "## Start",
      "## Discovery",
      "## Optional",
    ]);
  });

  it("formats every list item as [name](absolute url): note", () => {
    const items = lines.filter((l) => l.startsWith("- "));
    expect(items.length).toBeGreaterThanOrEqual(7);
    for (const item of items) expect(item).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\): \S/);
  });

  it("points at /start, MCP, OpenAPI and the discovery documents", () => {
    for (const url of [
      `${HOST}/start`,
      MCP_URL,
      `${HOST}/openapi.json`,
      `${MCP_URL}/server-card`,
      `${HOST}/.well-known/ai-catalog.json`,
      `${HOST}/.well-known/oauth-protected-resource/mcp`,
      `${HOST}/docs`,
      `${HOST}/docs/llms-full.txt`,
    ]) {
      expect(text).toContain(`](${url})`);
    }
  });

  it("leaves OAuth out when it isn't offered", () => {
    const plain = llmsTxt({ host: HOST, mcpUrl: MCP_URL, openapiUrl: `${HOST}/openapi.json` });
    expect(plain).not.toContain("oauth-protected-resource");
    expect(plain).not.toContain("OAuth");
  });

  it("says how unclaimed projects work, or that they're switched off (O3)", () => {
    const base = { host: HOST, mcpUrl: MCP_URL, openapiUrl: `${HOST}/openapi.json` };
    expect(llmsTxt(base)).toContain(
      "No account is needed: call create_project without credentials",
    );
    const on = llmsTxt({
      ...base,
      unclaimed: {
        enabled: true,
        quotas: {
          ttlDays: 7,
          ciMinutesPerDay: 60,
          ciMinutesPerRun: 10,
          storageMb: 250,
          artifactsOpsPerDay: 200,
          workspaceCpuMinutesPerDay: 30,
          requestsPerMinute: 120,
          createsPerIpPerHour: 3,
        },
      },
    });
    expect(on).toContain("It expires after 7 days unless a human claims it.");
    expect(on).toContain("60 CI minutes/day, 250 MB storage");
    expect(on).toContain("no Lane 0, registries-only egress");
    const off = llmsTxt({ ...base, unclaimed: { enabled: false } });
    expect(off).toContain("switched off right now");
    expect(off).not.toContain("No account is needed");
  });
});
