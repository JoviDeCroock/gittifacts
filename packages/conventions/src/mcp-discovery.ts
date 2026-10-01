/**
 * MCP discovery documents (researched 2026-10-01, docs/research/mcp-discovery.md):
 *
 * - RATIFIED (MCP 2026-07-28 authorization + RFC 9728): OAuth Protected Resource Metadata at
 *   `/.well-known/oauth-protected-resource<mcp path>` (probed first) and the root fallback
 *   `/.well-known/oauth-protected-resource`, plus a 401 `WWW-Authenticate: Bearer resource_metadata=...`.
 *   Only served when an authorization server exists: MCP requires `authorization_servers` to be non-empty.
 * - DRAFT (SEP-2127 "MCP Server Cards", in review): the card at `<mcp url>/server-card`
 *   (`application/mcp-server-card+json`), indexed from `/.well-known/ai-catalog.json` (AI Catalog draft).
 *
 * Not served on purpose: `/.well-known/mcp`, `/.well-known/mcp.json`, `/.well-known/mcp/server-card.json`
 * (closed proposals SEP-1960 / SEP-1649). The authorization server serves its own RFC 8414 metadata.
 */
import { MCP_PROTOCOL_VERSION } from "./start.js";
import { hostnameOf, join, normalizeOrigin, pathOf } from "./urls.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface WellKnownDocument {
  /** Path on the platform host. */
  path: string;
  contentType: string;
  /** Extra response headers (CORS, caching). The platform adds an ETag. */
  headers: Record<string, string>;
  body: { [key: string]: JsonValue };
  status: "ratified" | "draft";
  spec: string;
}

/** Scopes an agent session can hold. Approval scopes are never delegated to agents. */
export const AGENT_SCOPES = ["repo:read", "plan:create", "change:create"] as const;

export const SERVER_CARD_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

export interface McpDiscoveryOptions {
  host: string;
  mcpUrl: string;
  /** Server version for the card (the platform's deploy version). */
  version: string;
  /** OAuth authorization server issuers. Empty: OAuth isn't offered, so no protected-resource metadata. */
  authorizationServers: string[];
  scopes?: readonly string[];
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "Content-Type, If-None-Match",
  "access-control-expose-headers": "ETag",
  "cache-control": "public, max-age=3600",
};

/** `/.well-known/oauth-protected-resource/mcp` for an MCP endpoint at `/mcp`. */
export function protectedResourceMetadataPath(mcpUrl: string): string {
  const path = pathOf(mcpUrl);
  return `/.well-known/oauth-protected-resource${path === "/" ? "" : path}`;
}

/** Path of the draft server card: `<mcp path>/server-card`. */
export function serverCardPath(mcpUrl: string): string {
  const path = pathOf(mcpUrl);
  return `${path === "/" ? "" : path}/server-card`;
}

/** Reverse-DNS server name required by the card schema: `gittifacts.example` → `example.gittifacts/gittifacts`. */
export function serverCardName(host: string): string {
  return `${hostnameOf(host).split(".").reverse().join(".")}/gittifacts`;
}

/** Every discovery document the platform should serve, in the order clients probe them. */
export function mcpDiscovery(opts: McpDiscoveryOptions): WellKnownDocument[] {
  const host = normalizeOrigin(opts.host);
  const scopes = [...(opts.scopes ?? AGENT_SCOPES)];
  const docs: WellKnownDocument[] = [];

  if (opts.authorizationServers.length > 0) {
    const prm = {
      resource: opts.mcpUrl,
      authorization_servers: opts.authorizationServers,
      scopes_supported: scopes,
      bearer_methods_supported: ["header"],
      resource_name: "gittifacts",
      resource_documentation: join(host, "/start"),
    };
    const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" };
    docs.push({
      path: protectedResourceMetadataPath(opts.mcpUrl),
      contentType: "application/json",
      headers,
      body: prm,
      status: "ratified",
      spec: "RFC 9728 + MCP 2026-07-28 authorization (path form, probed first)",
    });
    if (pathOf(opts.mcpUrl) !== "/") {
      docs.push({
        path: "/.well-known/oauth-protected-resource",
        contentType: "application/json",
        headers,
        // `resource` stays the MCP URL so tokens carry one audience; the TS SDK accepts a same-origin prefix.
        body: prm,
        status: "ratified",
        spec: "RFC 9728 + MCP 2026-07-28 authorization (root fallback)",
      });
    }
  }

  const cardUrl = join(host, serverCardPath(opts.mcpUrl));
  docs.push({
    path: serverCardPath(opts.mcpUrl),
    contentType: SERVER_CARD_MEDIA_TYPE,
    headers: CORS,
    body: {
      $schema: SERVER_CARD_SCHEMA,
      name: serverCardName(host),
      version: opts.version,
      title: "gittifacts",
      description: "Agent-native git: plans, changes, CI evidence and risk lanes. Start at /start.",
      websiteUrl: join(host, "/start"),
      remotes: [
        {
          type: "streamable-http",
          url: opts.mcpUrl,
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
          headers: [
            {
              name: "Authorization",
              description:
                "Bearer token from create_project or a human. Omit it to use OAuth via the 401 challenge.",
              isRequired: false,
              isSecret: true,
              value: "Bearer {token}",
              variables: { token: { description: "gittifacts token", isSecret: true } },
            },
          ],
        },
      ],
    },
    status: "draft",
    spec: "SEP-2127 MCP Server Cards (in review)",
  });

  docs.push({
    path: "/.well-known/ai-catalog.json",
    contentType: AI_CATALOG_MEDIA_TYPE,
    headers: CORS,
    body: {
      specVersion: "1.0",
      host: {
        displayName: "gittifacts",
        identifier: hostnameOf(host),
        documentationUrl: join(host, "/start"),
      },
      entries: [
        {
          identifier: `urn:air:${hostnameOf(host)}:mcp:gittifacts`,
          type: SERVER_CARD_MEDIA_TYPE,
          url: cardUrl,
        },
      ],
    },
    status: "draft",
    spec: "AI Catalog editor's draft (Agent-Card/ai-catalog), referenced by SEP-2127",
  });
  return docs;
}

/**
 * `WWW-Authenticate` value for a 401 (missing/invalid token) or a 403 (insufficient scope) from the
 * MCP endpoint. Without OAuth there is no metadata to point at, so the challenge is a plain Bearer.
 */
export function mcpAuthChallenge(
  opts: Pick<McpDiscoveryOptions, "host" | "mcpUrl" | "authorizationServers" | "scopes">,
  error?: {
    code: "invalid_token" | "insufficient_scope";
    description?: string;
    scopes?: readonly string[];
  },
): string {
  const parts: string[] = [];
  if (error !== undefined) parts.push(`error="${error.code}"`);
  if (opts.authorizationServers.length > 0) {
    parts.push(
      `resource_metadata="${join(opts.host, protectedResourceMetadataPath(opts.mcpUrl))}"`,
    );
  }
  const scopes = error?.scopes ?? opts.scopes ?? AGENT_SCOPES;
  parts.push(`scope="${scopes.join(" ")}"`);
  if (error?.description !== undefined)
    parts.push(`error_description="${error.description.replace(/["\\]/g, "")}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** `Link` header for `/`, `/start` and `/llms.txt` so agents find the AI catalog without probing. */
export function aiCatalogLinkHeader(host: string): string {
  return `<${join(host, "/.well-known/ai-catalog.json")}>; rel="ai-catalog"`;
}
