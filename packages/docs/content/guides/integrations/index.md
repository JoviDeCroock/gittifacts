---
title: Integrations
description: Connect a deploy platform (Cloudflare Workers Builds, Netlify, Vercel…) to gittifacts as a git provider — OAuth, webhooks, git clone and deployment statuses.
order: 1
---

# Integrations

gittifacts is a git provider that deploy platforms (Cloudflare Workers Builds, Netlify, Vercel, Render, Fly…) connect to the way they connect to GitHub: **OAuth**, **webhooks**, **`git clone`**, and **deployment statuses** back.

An integration **reads code and reports what it deployed**:

- it can never push, approve, review or merge, and never sees agents' push tokens;
- it can't be connected to unclaimed projects;
- deploy results come back as signed **evidence** on the Change.

Examples use `https://<host>` for your gittifacts deployment.

| Where | What |
|---|---|
| `https://<host>/settings/integrations/developer` | Developer portal: register and manage integrations, rotate secrets, delivery log |
| `https://<host>/settings/integrations` | Installed integrations (per person): what each can do, repos, uninstall |
| `https://<host>/api/v1/openapi.json` | OpenAPI (tags `integrations`, `deployments`, `git`) |
| `https://<host>/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |

## Register an integration

In the developer portal (or `POST /api/v1/integrations` with a signed-in session) give:

- a name, homepage and logo URL;
- **redirect URIs**, matched exactly;
- the **permissions** you need (below);
- a **webhook URL** and the events you want.

You get a `client_id` (`gtic_…`) and, for a confidential client, a `client_secret` (`gtis_…`) **shown once**. It is stored hashed.

To rotate, generate a second secret, switch over, then revoke the old one (at most two are active; the last one can't be revoked). Without your own webhook secret one is generated (`whsec_…`) and shown once. Public clients (no secret, PKCE only) are allowed too.

## Permissions

| Scope | In plain words | What it allows |
|---|---|---|
| `repo:read` | Read repository metadata | See the repository's name, branches, commits, Changes and their status. |
| `contents:read` | Clone the code | Clone and fetch the repository and its Change heads over git, read-only. |
| `webhooks` | Receive events | Get notified when the default branch or a Change is pushed, and when Changes are created, updated, merged or reverted. |
| `deployments:write` | Report deployments | Post deployment status and preview URLs. A successful preview is attached to its Change as signed evidence. |
| `checks:write` | Report checks | Attach external check results to Changes. They can only raise a Change's risk lane, never lower it. *Reserved: you can register and be granted it, but there is no checks endpoint yet.* |

A deploy platform needs `repo:read contents:read webhooks deployments:write`. These can never be requested:

- approval and admin scopes: `plan:approve`, `change:review`, `repo:admin`, `policy:admin`;
- authoring scopes: `plan:create`, `change:create`.

Next: [the install flow](./oauth.md), [git access](./git.md), [webhooks](./webhooks.md), [deployments](./deployments.md), and an end-to-end example: [connect a Cloudflare Workers project](./cloudflare-workers.md).

## Errors and limits

Platform JSON errors are `{ "error": { "code", "message", "fix": { "explanation", … } } }`. The token and revocation endpoints answer in RFC 6749 form: `{ "error", "error_description", "fix" }`.

Each integration has one request budget shared by all its installations. Over budget, requests get HTTP 429 `rate-limited` with `Retry-After`.
