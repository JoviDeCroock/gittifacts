import { describe, expect, it } from "vitest";
import {
  AGENT_SCOPES,
  aiCatalogLinkHeader,
  mcpAuthChallenge,
  mcpDiscovery,
  SERVER_CARD_SCHEMA,
  serverCardName,
} from "../src/index.js";
import { HOST, MCP_URL } from "./helpers.js";

const opts = { host: HOST, mcpUrl: MCP_URL, version: "1.2.3", authorizationServers: [HOST] };

describe("mcpDiscovery", () => {
  const docs = mcpDiscovery(opts);
  const byPath = new Map(docs.map((d) => [d.path, d]));

  it("serves PRM (path form, then root), the server card and the AI catalog", () => {
    expect(docs.map((d) => [d.path, d.status])).toEqual([
      ["/.well-known/oauth-protected-resource/mcp", "ratified"],
      ["/.well-known/oauth-protected-resource", "ratified"],
      ["/mcp/server-card", "draft"],
      ["/.well-known/ai-catalog.json", "draft"],
    ]);
  });

  it("never serves the paths of closed proposals", () => {
    for (const d of docs) expect(d.path).not.toMatch(/^\/\.well-known\/mcp/);
  });

  it("builds RFC 9728 protected resource metadata", () => {
    const prm = byPath.get("/.well-known/oauth-protected-resource/mcp");
    expect(prm?.contentType).toBe("application/json");
    expect(prm?.body).toEqual({
      resource: MCP_URL,
      authorization_servers: [HOST],
      scopes_supported: [...AGENT_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "gittifacts",
      resource_documentation: `${HOST}/start`,
    });
    expect(AGENT_SCOPES).not.toContain("plan:approve");
    expect(AGENT_SCOPES).not.toContain("change:review");
  });

  it("omits PRM when no authorization server exists (MCP requires a non-empty list)", () => {
    const paths = mcpDiscovery({ ...opts, authorizationServers: [] }).map((d) => d.path);
    expect(paths).toEqual(["/mcp/server-card", "/.well-known/ai-catalog.json"]);
  });

  it("builds a server card that satisfies the draft schema's rules", () => {
    const card = byPath.get("/mcp/server-card");
    expect(card?.contentType).toBe("application/mcp-server-card+json");
    expect(card?.headers["access-control-allow-origin"]).toBe("*");
    const body = card?.body as Record<string, unknown> & {
      remotes: { type: string; url: string; supportedProtocolVersions: string[] }[];
    };
    expect(body.$schema).toBe(SERVER_CARD_SCHEMA);
    expect(body.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(body.version).toBe("1.2.3");
    expect(String(body.description).length).toBeLessThanOrEqual(100);
    expect(body.remotes).toEqual([
      expect.objectContaining({
        type: "streamable-http",
        url: MCP_URL,
        supportedProtocolVersions: ["2026-07-28"],
      }),
    ]);
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("indexes the card from the AI catalog", () => {
    const catalog = byPath.get("/.well-known/ai-catalog.json");
    expect(catalog?.contentType).toBe("application/ai-catalog+json");
    expect(catalog?.body).toMatchObject({
      specVersion: "1.0",
      entries: [{ type: "application/mcp-server-card+json", url: `${MCP_URL}/server-card` }],
    });
  });

  it("handles an MCP endpoint at the root and hosts with ports", () => {
    const root = mcpDiscovery({
      ...opts,
      host: "http://localhost:8787",
      mcpUrl: "http://localhost:8787/",
    });
    expect(root.map((d) => d.path)).toEqual([
      "/.well-known/oauth-protected-resource",
      "/server-card",
      "/.well-known/ai-catalog.json",
    ]);
    expect(serverCardName("http://localhost:8787")).toBe("localhost/gittifacts");
    expect(serverCardName("https://gittifacts.resynapse.dev")).toBe(
      "dev.resynapse.gittifacts/gittifacts",
    );
  });
});

describe("mcpAuthChallenge", () => {
  it("points a 401 at the metadata", () => {
    expect(mcpAuthChallenge(opts)).toBe(
      `Bearer resource_metadata="${HOST}/.well-known/oauth-protected-resource/mcp", scope="repo:read plan:create change:create"`,
    );
  });

  it("describes insufficient scope on a 403", () => {
    expect(
      mcpAuthChallenge(opts, {
        code: "insufficient_scope",
        scopes: ["change:create"],
        description: 'needs "change:create"',
      }),
    ).toBe(
      `Bearer error="insufficient_scope", resource_metadata="${HOST}/.well-known/oauth-protected-resource/mcp", scope="change:create", error_description="needs change:create"`,
    );
  });

  it("is a plain Bearer challenge without OAuth", () => {
    expect(mcpAuthChallenge({ ...opts, authorizationServers: [] }, { code: "invalid_token" })).toBe(
      'Bearer error="invalid_token", scope="repo:read plan:create change:create"',
    );
  });

  it("builds the ai-catalog Link header", () => {
    expect(aiCatalogLinkHeader(`${HOST}/`)).toBe(
      `<${HOST}/.well-known/ai-catalog.json>; rel="ai-catalog"`,
    );
  });
});
