/**
 * `GET /llms.txt` per the llms.txt proposal (llmstxt.org): an H1, a blockquote summary, a few
 * plain paragraphs, then H2 sections of `- [name](url): note` links. "Optional" is the section an
 * agent may skip when its context is short.
 */
import { TEMPLATE_IDS } from "./catalog.js";
import { cliCommand, cliTarballUrl } from "./cli.js";
import { MCP_PROTOCOL_VERSION, PLATFORM_SUMMARY, type UnclaimedQuotaHints } from "./start.js";
import { join, normalizeOrigin, pathOf } from "./urls.js";

export interface LlmsTxtOptions {
  host: string;
  mcpUrl: string;
  openapiUrl: string;
  /** MCP OAuth is offered (protected resource metadata is served). Default false. */
  oauth?: boolean;
  /**
   * Whether create_project works without credentials right now (the kill switch), and the
   * configured quotas. Omitted: enabled, generic wording.
   */
  unclaimed?: { enabled: boolean; quotas?: UnclaimedQuotaHints | undefined };
}

/** The "No account" paragraph: how unclaimed projects work, or that they're switched off. */
export function noAccountText(unclaimed: LlmsTxtOptions["unclaimed"]): string {
  if (unclaimed?.enabled === false) {
    return "Creating projects without an account is switched off right now: authenticate with MCP OAuth (discovered from the MCP server's 401) or an agent token from a human.";
  }
  const q = unclaimed?.quotas;
  const expiry =
    q === undefined
      ? "It expires unless a human claims it."
      : `It expires after ${q.ttlDays} days unless a human claims it.`;
  const limits =
    q === undefined
      ? "Until then: previews only, no secrets, custom domains or production deploys, no Lane 0, registries-only egress, tight quotas."
      : `Until then: previews only, no secrets, custom domains or production deploys, no Lane 0, registries-only egress, ${q.ciMinutesPerDay} CI minutes/day, ${q.storageMb} MB storage.`;
  return `No account is needed: call create_project without credentials to get an unclaimed project, a Bearer token for it and a claimUrl for a human. ${expiry} ${limits}`;
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
    noAccountText(opts.unclaimed),
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
    link(
      "CLI",
      cliTarballUrl(host),
      `every MCP tool as a shell command with JSON output, served as an npm tarball (not on npm yet): \`${cliCommand(host, "--help")}\``,
    ),
    link(
      "Docs",
      join(host, "/docs"),
      "task-first guides and generated references (append .md to any page, or send Accept: text/markdown)",
    ),
    link(
      "Docs, full text",
      join(host, "/docs/llms-full.txt"),
      "every docs page in one markdown file",
    ),
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
