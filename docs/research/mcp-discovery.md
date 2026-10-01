# MCP discovery: which documents to serve

Researched 2026-10-01, from primary sources only (spec pages, GitHub API, the npm tarballs of `@modelcontextprotocol/server`
and `@modelcontextprotocol/client` 2.2.0, and live `curl` of deployed cards). Labels used below:
**RATIFIED** means in the MCP 2026-07-28 spec or in an RFC. **DRAFT** means an open SEP or an external draft. **OURS** means our own convention.

## TL;DR
- The current MCP spec is **2026-07-28** (the versioning page says so). Its core defines **no `.well-known` document for finding
  an MCP server**. It does define (a) **OAuth discovery**: RFC 9728 Protected Resource Metadata plus a 401 `WWW-Authenticate`
  challenge, then RFC 8414 or OIDC metadata at the issuer, and (b) **`server/discover`**, an in-band JSON-RPC call on `/mcp`
  that servers MUST implement.
- **Server Cards** are still a **DRAFT**. SEP-2127 is an open PR labelled `in-review` (last updated 2026-09-30). The extension
  repo README says "Experimental … not an accepted or official MCP extension". The SEP file on the PR branch says
  "Status: Final", but the PR is not merged, so treat it as draft. Current draft path: **`<streamable-http-url>/server-card`**
  (for us, `/mcp/server-card`). Domain-level discovery goes through an **AI Catalog** at **`/.well-known/ai-catalog.json`**,
  which is a separate community draft.
- **Dead proposals:** `/.well-known/mcp/server-card.json` came from SEP-1649, which was closed 2026-01-26 and moved to
  SEP-2127. The current draft explicitly does **not** recommend a `.well-known` card. `/.well-known/mcp` came from SEP-1960,
  closed 2025-12-12 as a duplicate of SEP-1649. IANA has **no** `mcp` well-known entry.
- **Static bearer / API-key auth cannot be declared** in any ratified document. SEP-2742 (an auth block) was closed
  2026-08-24 and folded into the server-card working group (ext-server-card issue #13, still open). The only draft way to
  hint at it is a card's `remotes[].headers`.

## 1. Server discovery (Server Cards)
| Proposal | Path | Status (2026-10-01) |
|---|---|---|
| SEP-1649 | `/.well-known/mcp/server-card.json` | closed, continued as #2127 |
| SEP-1960 | `/.well-known/mcp` | closed (duplicate) |
| **SEP-2127** (Extensions Track, id `io.modelcontextprotocol/server-card`) | card at `<mcp-url>/server-card`; catalog at `/.well-known/ai-catalog.json` | **open, in-review**. SDK reference PRs are open, not merged: TS #2527, Python #2951, Go #1024 |

Draft rules, from `ext-server-card` `docs/discovery.md` and `schema.ts`:
- Media type `application/mcp-server-card+json`. Clients SHOULD send `Accept: application/mcp-server-card+json`.
- A card may live at any URI. `GET <streamable-http-url>/server-card` is reserved as the recommended place. "Not recommended":
  `.well-known/mcp/server-card`, a bare `GET /mcp`, and a domain-root `/mcp/` namespace used for metadata.
- Response headers: CORS MUST be `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`,
  `Access-Control-Allow-Headers: Content-Type, If-None-Match`, `Access-Control-Expose-Headers: ETag`. Caching SHOULD be
  `Cache-Control: public, max-age=3600` with an `ETag`, and the server should honour `If-None-Match` with a 304. HTTPS MUST be used.
- Fields. **Required:** `$schema`, `name`, `version`, `description` (1–100 chars). **Optional:** `title`, `websiteUrl`,
  `repository{url,source,subfolder?,id?}`, `icons[]`, `remotes[]`, `_meta`. `name` is reverse-DNS with one `/`
  (`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`). `remotes[]` = `{ type: "streamable-http"|"sse", url, headers?: KeyValueInput[],
  variables?, supportedProtocolVersions? }`. `$schema` MUST equal
  `https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`, which **returns 404 today** (v1 "pre-release").
- Cards **omit tools, resources and prompts**. They are advisory: clients MUST NOT use them for security decisions and should
  prefer live `server/discover` values when the two disagree.
- Deployed today, verified with curl: `github.com/.well-known/ai-catalog.json` points to `api.githubcopilot.com/mcp/server-card`,
  and `buildkite.com/.well-known/ai-catalog.json` points to `mcp.buildkite.com/mcp/server-card`. Both use the shapes below.

## 2. Authorization in 2026-07-28 (RATIFIED)
- An MCP server **MUST** implement RFC 9728 PRM. The PRM **MUST** include `authorization_servers` with at least one entry.
  The server MUST offer at least one of two mechanisms:
  1. The 401 `WWW-Authenticate` header carrying `resource_metadata`.
  2. A well-known URI. Either the path form, where `https://example.com/public/mcp` maps to
     `https://example.com/.well-known/oauth-protected-resource/public/mcp`, or the root form at `/.well-known/oauth-protected-resource`.

  Clients use the header if it is present. Otherwise they probe **the path form first, then the root**.
  (2025-06-18 made the header a MUST, so serving both mechanisms is safest.)
- **RFC 9728 fields:** `resource` REQUIRED (§3.3: MUST equal the identifier the suffix was inserted into);
  `authorization_servers` OPTIONAL in the RFC but MUST in MCP; `scopes_supported` RECOMMENDED (MCP: the minimal set, no
  `offline_access`); `resource_name` RECOMMENDED; `bearer_methods_supported` (`["header"]`), `resource_documentation`,
  `jwks_uri` OPTIONAL. Serve as `application/json`, 200.
- **401 challenge:** `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. `scope` is a SHOULD, and clients treat it as authoritative.
- **Insufficient scope:** return 403 with `Bearer error="insufficient_scope", scope="…", resource_metadata="…", error_description="…"`.
  Put all required scopes in one challenge.
- **AS metadata.** For an issuer with no path, clients MUST try `/.well-known/oauth-authorization-server`, then
  `/.well-known/openid-configuration`. For an issuer like `https://h/t1` they try
  `/.well-known/oauth-authorization-server/t1`, then `/.well-known/openid-configuration/t1`, then `/t1/.well-known/openid-configuration`.
  The `issuer` in the document MUST equal the issuer the URL was built from. MCP defines no custom suffix.
- **AS fields clients rely on:** `code_challenge_methods_supported` (if absent, clients **MUST refuse**; use `S256`);
  `authorization_response_iss_parameter_supported: true` (RFC 9207: sending `iss` is a SHOULD, and a server that sends it MUST
  advertise this); `client_id_metadata_document_supported: true` (CIMD); `registration_endpoint` (DCR only). RFC 8414
  REQUIRES `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported`.
- **Client registration:** CIMD is a SHOULD (client_id is an HTTPS URL to a JSON document). **DCR is deprecated (SEP-837)**:
  still a MAY, kept for backward compatibility. Priority order: pre-registered, then CIMD, then DCR, then prompt the user.
  Clients MUST send RFC 8707 `resource` = the canonical server URI, and servers MUST check the token audience.
- **SDK 2.2.0** (read from dist): `oauthMetadataResponse(req, opts)` serves **only** the path form
  `/.well-known/oauth-protected-resource/mcp` plus `/.well-known/oauth-authorization-server` (verbatim), with ACAO `*`.
  The PRM it builds has `resource`, `authorization_servers`, `scopes_supported`, `resource_name`, `resource_documentation`.
  `getOAuthProtectedResourceMetadataUrl(new URL("https://h/mcp"))` returns `https://h/.well-known/oauth-protected-resource/mcp`.
  The client's `checkResourceAllowed` accepts a PRM `resource` equal to the server URL or a same-origin path prefix of it.

## 3. MCP Registry `server.json`
- `$schema`: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (live, 200). That is the latest
  dated release. Registry v1.8.1 has a draft that adds `{baseUrl}` URL templates.
- Required: `name`, `description` (≤100), `version`. Optional: `title`, `websiteUrl`, `repository`, `icons`,
  `packages[]` (local installs), `remotes[]` (`{type:"streamable-http", url, headers?, variables?}`), `_meta`.
- A Server Card is the remote-only subset of this, with the same `Remote` shape. It deliberately excludes `packages`.
- Publishing under a domain namespace (`example.gittifacts/...`) uses HTTP verification at `/.well-known/mcp-registry-auth`,
  an Ed25519 or ECDSA key file. This only matters if we publish to the official registry.

## 4. Other conventions an agent may try
- **AI Catalog** (Agent-Card/ai-catalog, an editor's draft): `specVersion` + `entries[{identifier,type,url|data}]`, optional `host`.
  Content type `application/ai-catalog+json`. Agents SHOULD first check `Link: <…>; rel="ai-catalog"` or an HTML `<link rel="ai-catalog">`,
  then the well-known URI. Its guide claims IANA registration, but **`ai-catalog.json` is not in the IANA registry** (CSV checked 2026-10-01).
- **`/llms.txt`** (llmstxt.org, Jeremy Howard): a proposal, not a standard. Only the H1 is required; a blockquote summary and
  H2 link lists are optional. It defines no MCP field, so mentioning `/mcp` there is OURS. It is still the most likely thing
  a generic agent reads.
- **A2A `/.well-known/agent-card.json`**: IANA-registered (2025-08-01, Linux Foundation). It is for A2A agents only and not
  relevant unless we expose A2A.
- IANA has permanent entries for `oauth-protected-resource` (RFC 9728), `oauth-authorization-server` (RFC 8414) and
  `openid-configuration`.

## Recommendation for gittifacts
Host `https://gittifacts.example`, MCP at `/mcp`. Scopes are the ones an agent session can hold (`repo:read`, `plan:create`,
`change:create`); approval scopes are never delegated to agents. `@app/conventions` → `mcpDiscovery()` generates 2, 3, 5 and 6.

**1. 401 on `/mcp` with no or invalid token. RATIFIED (RFC 9728 §5.1 / RFC 6750).**
```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://gittifacts.example/.well-known/oauth-protected-resource/mcp", scope="repo:read change:create"
```

**2. `GET /.well-known/oauth-protected-resource/mcp`. `application/json`. RATIFIED (primary).**
```json
{
  "resource": "https://gittifacts.example/mcp",
  "authorization_servers": ["https://gittifacts.example"],
  "scopes_supported": ["repo:read", "plan:create", "change:create"],
  "bearer_methods_supported": ["header"],
  "resource_name": "gittifacts",
  "resource_documentation": "https://gittifacts.example/start"
}
```

**3. `GET /.well-known/oauth-protected-resource`. `application/json`. RATIFIED fallback.** Same body.
Caveat: strict RFC 9728 §3.3 expects `resource` here to be `https://gittifacts.example`. Clients only reach this URL when
the path form fails, and the TS SDK accepts either value. Keep `/mcp` so that tokens carry a single audience.

**4. `GET /.well-known/oauth-authorization-server`. `application/json`. RATIFIED (RFC 8414 + MCP).**
Our AS issuer must have **no path**. If better-auth's issuer is `https://gittifacts.example/api/auth`, the URL becomes
`/.well-known/oauth-authorization-server/api/auth`. I did not verify better-auth's actual issuer value. Also serve
`/.well-known/openid-configuration` if the AS speaks OIDC.
```json
{
  "issuer": "https://gittifacts.example",
  "authorization_endpoint": "https://gittifacts.example/oauth/authorize",
  "token_endpoint": "https://gittifacts.example/oauth/token",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["repo:read", "plan:create", "change:create", "offline_access"],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true
}
```
Add `"registration_endpoint"` only if we keep DCR, which is deprecated.

**5. `GET /mcp/server-card`. `application/mcp-server-card+json`. DRAFT (SEP-2127).** Send the CORS and caching headers from §1.
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "example.gittifacts/gittifacts",
  "version": "1.0.0",
  "title": "gittifacts",
  "description": "Plans, changes and reviews for agent-authored code, with human approval lanes.",
  "websiteUrl": "https://gittifacts.example/start",
  "remotes": [{
    "type": "streamable-http",
    "url": "https://gittifacts.example/mcp",
    "supportedProtocolVersions": ["2026-07-28"],
    "headers": [{ "name": "Authorization", "description": "Agent token (Bearer). Omit to use OAuth via the 401 challenge.",
      "isRequired": false, "isSecret": true, "value": "Bearer {token}",
      "variables": { "token": { "description": "gittifacts agent token", "isSecret": true } } }]
  }]
}
```
The `headers` entry for API-key auth is draft-compatible but is our own usage; the auth shape is still unsettled (issue #13).

**6. `GET /.well-known/ai-catalog.json`. `application/ai-catalog+json`. DRAFT (AI Catalog + SEP-2127).** Use the same CORS
headers. Also send `Link: <https://gittifacts.example/.well-known/ai-catalog.json>; rel="ai-catalog"` on `/`, `/start` and `/llms.txt`.
```json
{
  "specVersion": "1.0",
  "host": { "displayName": "gittifacts", "identifier": "gittifacts.example", "documentationUrl": "https://gittifacts.example/start" },
  "entries": [
    { "identifier": "urn:air:gittifacts.example:mcp:gittifacts", "type": "application/mcp-server-card+json",
      "url": "https://gittifacts.example/mcp/server-card" }
  ]
}
```

**7. `GET /llms.txt`. `text/plain; charset=utf-8` (llmstxt.org does not fix a type). Community proposal; content is OURS.**
```markdown
# gittifacts
> Agent-first code review platform. Agents connect via MCP or the HTTP API.

## Connect
- [MCP endpoint](https://gittifacts.example/mcp): streamable HTTP, MCP 2026-07-28. Auth: `Authorization: Bearer <agent token>`, or OAuth (discover from the 401 / `/.well-known/oauth-protected-resource/mcp`)
- [Start guide](https://gittifacts.example/start): get a token, first calls
- [OpenAPI](https://gittifacts.example/openapi.json): HTTP API
- [Server Card](https://gittifacts.example/mcp/server-card): MCP connection metadata
```

**8. `GET /start` (`text/html` + `text/markdown` via `Accept`) and `GET /openapi.json` (`application/json`). OURS.** Neither
is an MCP discovery document. Link them from PRM `resource_documentation`, the card's `websiteUrl`, the catalog `host.documentationUrl` and llms.txt.

**Do not serve:** `/.well-known/mcp`, `/.well-known/mcp.json`, `/.well-known/mcp/server-card.json`. They come from dead
proposals that no current spec reads. If you want a legacy alias, it is OURS; it is low value and adds drift risk.
**Optional, OURS:** answer `server/discover` without a token so agents can read `instructions` before auth. The spec is
silent on this; the server-card working group notes that discover is "frequently gated by auth".

## Sources (all read 2026-10-01)
- https://modelcontextprotocol.io/specification/versioning: current version is 2026-07-28; `server/discover` is a mandatory RPC.
- https://blog.modelcontextprotocol.io/posts/2026-07-28/: release notes. RFC 9207 iss (SEP-2468), DCR deprecated (SEP-837), issuer binding (SEP-2352). No server cards.
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md: PRM MUST, CIMD SHOULD, DCR deprecated, scope/401/403 rules, iss validation, RFC 8707.
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery.md: PRM header or well-known (path, then root); AS probe order; issuer match.
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md: CIMD fields, `client_id_metadata_document_supported`, DCR deprecated, priority order.
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations.md: refuse if `code_challenge_methods_supported` is absent; S256.
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md: request/response shape (`supportedVersions`, `capabilities`, serverInfo in `_meta`, `instructions`).
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization: same PRM/AS discovery, CIMD SHOULD, DCR MAY (not yet deprecated). …/2025-06-18/basic/authorization: 401 `WWW-Authenticate` MUST, RFC 8414 only, DCR SHOULD.
- https://modelcontextprotocol.io/community/working-groups/server-card.md: Server Card WG charter; SEP-2127 listed as Draft.
- https://modelcontextprotocol.io/extensions/overview.md: extension lifecycle; Server Card is not listed as official.
- https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127 (via `gh api`), plus its branch file `seps/2127-mcp-server-cards.md`: open, labelled in-review; path `<mcp-url>/server-card` + AI Catalog. Issues #1649, #1960, #2742, #2652 and PR #2133: closure reasons and dates as above; SEP-2133 (extensions) is Final.
- https://github.com/modelcontextprotocol/ext-server-card: README (Experimental), `schema.ts`, `docs/discovery.md`, `docs/core-maintainer-roadmap.md`, `examples/ServerCard/*`.
- https://api.githubcopilot.com/mcp/server-card, https://github.com/.well-known/ai-catalog.json, https://buildkite.com/.well-known/ai-catalog.json, https://mcp.buildkite.com/mcp/server-card: live examples and headers.
- https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json: 404. https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json: 200.
- https://github.com/modelcontextprotocol/registry: `docs/reference/server-json/{generic-server-json.md,CHANGELOG.md,draft/server.schema.json}`, `docs/modelcontextprotocol-io/authentication.mdx` (`/.well-known/mcp-registry-auth`).
- https://github.com/Agent-Card/ai-catalog: `specification/ai-catalog.md`, `docs/guides/serving-your-catalog.md`, `docs/examples/minimal-catalog.md`.
- https://www.iana.org/assignments/well-known-uris/well-known-uris-1.csv: no `mcp*` or `ai-catalog.json` entries; `agent-card.json`, `oauth-*` and `openid-configuration` are present.
- https://www.rfc-editor.org/rfc/rfc9728.txt, https://www.rfc-editor.org/rfc/rfc8414.txt: field requirement levels, path insertion, §3.3 match rule.
- https://llmstxt.org/: llms.txt structure and proposal status.
- npm tarballs `@modelcontextprotocol/server@2.2.0` and `@modelcontextprotocol/client@2.2.0`: `oauthMetadataResponse`, `getOAuthProtectedResourceMetadataUrl`, `checkResourceAllowed`.
