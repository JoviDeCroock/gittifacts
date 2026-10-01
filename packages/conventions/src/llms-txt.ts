/**
 * `GET /llms.txt` per the llms.txt proposal (llmstxt.org): an H1, a blockquote summary, a few
 * plain paragraphs, then H2 sections of `- [name](url): note` links. "Optional" is the section an
 * agent may skip when its context is short.
 */
import { TEMPLATE_IDS } from "./catalog.js";
import { MCP_PROTOCOL_VERSION, PLATFORM_SUMMARY } from "./start.js";
import { join, normalizeOrigin, pathOf } from "./urls.js";

export interface LlmsTxtOptions {
  host: string;
  mcpUrl: string;
  openapiUrl: string;
  /** MCP OAuth is offered (protected resource metadata is served). Default false. */
  oauth?: boolean;
}

export function llmsTxt(opts: LlmsTxtOptions): string {
  const host = normalizeOrigin(opts.host);
  const mcpPath = pathOf(opts.mcpUrl);
  const prm = join(host, `/.well-known/oauth-protected-resource${mcpPath === "/" ? "" : mcpPath}`);
  const link = (name: string, url: string, note: string) => `- [${name}](${url}): ${note}`;
  return [
    "# gittifacts",
    "",
    `> ${PLATFORM_SUMMARY}`,
    "",
    `Start with ${join(host, "/start")}: it lists the three calls that create a project, run CI and return a live preview URL.`,
    "No account is needed: create_project without credentials returns an unclaimed project, a token and a claim link for a human.",
    "",
    "## Start",
    link(
      "Start guide",
      join(host, "/start"),
      "what the platform is, auth, the 3 calls to ship something (JSON with Accept: application/json)",
    ),
    link(
      "MCP server",
      opts.mcpUrl,
      `streamable HTTP, MCP ${MCP_PROTOCOL_VERSION}; send Authorization: Bearer <token>${opts.oauth === true ? ", or use OAuth discovered from the 401" : ""}`,
    ),
    link("OpenAPI", opts.openapiUrl, "the HTTP API; every endpoint mirrors an MCP tool"),
    "",
    "## Discovery",
    link(
      "MCP server card",
      `${opts.mcpUrl.replace(/\/+$/, "")}/server-card`,
      "name, version and remote endpoint of the MCP server (draft SEP-2127)",
    ),
    link(
      "AI catalog",
      join(host, "/.well-known/ai-catalog.json"),
      "domain-level index pointing at the server card (draft)",
    ),
    ...(opts.oauth === true
      ? [
          link(
            "OAuth protected resource metadata",
            prm,
            "RFC 9728: which authorization server issues tokens for the MCP server",
          ),
        ]
      : []),
    "",
    "## Optional",
    link(
      "Templates",
      `${join(host, "/start")}#templates`,
      `create_project({ template }) accepts ${TEMPLATE_IDS.map((id) => `"${id}"`).join(", ")}`,
    ),
    link(
      "Signing keys",
      join(host, "/.well-known/gittifacts-keys.json"),
      "Ed25519 keys that sign evidence, plan approvals and audit entries",
    ),
    "",
  ].join("\n");
}
