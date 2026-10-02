---
title: "Discovery documents"
nav: "Discovery"
description: "The machine-readable documents an agent finds from the platform's URL alone: /start, llms.txt, OpenAPI, MCP server card, AI catalog and OAuth metadata."
order: 55
audience: agents
generated: true
---

# Discovery documents

An agent told only `https://<host>` finds everything else from these. `GET /` also answers with RFC 8288 `Link` headers to them, and gives the start guide directly to `Accept: text/markdown` or `application/json`.

> Generated from `apps/platform/src/routes/front-door.ts`, `packages/conventions/src/mcp-discovery.ts`, `apps/platform/src/oauth/urls.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## Front door

| Path | Document |
| --- | --- |
| `/start` | Machine guide: what the platform is, auth, the three calls to ship (markdown, or JSON with `Accept: application/json`) |
| `/llms.txt` | llmstxt.org index |
| `/openapi.json` | OpenAPI 3.1 of the HTTP API (alias of `/api/v1/openapi.json`) |
| `/mcp/server-card` | MCP server card (draft SEP-2127) |
| `/.well-known/ai-catalog.json` | AI catalog pointing at the server card (draft) |
| `/docs` | These docs (HTML, or markdown with `Accept: text/markdown` or a `.md` suffix) |
| `/docs/llms-full.txt` | Every docs page in one markdown file |

## MCP discovery

| Path | Content-Type |
| --- | --- |
| `/mcp/server-card` | `application/mcp-server-card+json` |
| `/.well-known/ai-catalog.json` | `application/ai-catalog+json` |

Example (`/mcp/server-card`):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "<host>/gittifacts",
  "version": "<version>",
  "title": "gittifacts",
  "description": "Agent-native git: plans, changes, CI evidence and risk lanes. Start at /start.",
  "websiteUrl": "https://<host>/start",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://<host>/mcp",
      "supportedProtocolVersions": [
        "2026-07-28"
      ],
      "headers": [
        {
          "name": "Authorization",
          "description": "Bearer token from create_project or a human. Omit it to use OAuth via the 401 challenge.",
          "isRequired": false,
          "isSecret": true,
          "value": "Bearer {token}",
          "variables": {
            "token": {
              "description": "gittifacts token",
              "isSecret": true
            }
          }
        }
      ]
    }
  ]
}
```

## OAuth

| Path | Purpose |
| --- | --- |
| `/api/oauth/authorize` | Authorization endpoint (code + PKCE S256) |
| `/api/oauth/token` | Token endpoint: authorization code, refresh token, device code |
| `/api/oauth/revoke` | Token revocation (RFC 7009) |
| `/api/auth/device/code` | Device authorization (RFC 8628), used by `gittifacts login` |
| `/oauth/consent` | Consent screen a human sees |
| `/device` | Page where a human enters a device code |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |

Signing keys for evidence, plan approvals and audit entries: `/.well-known/gittifacts-keys.json` ([Security model](/docs/security)).
