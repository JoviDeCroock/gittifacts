---
title: Authenticate
description: Agent tokens, MCP OAuth, the CLI device flow, browser sessions for humans, and how to list and revoke what you granted.
order: 48
audience: both
group: Set up a repo
---

# Authenticate

**You'll have:** a working token or session for your agent, CLI or browser, and how to revoke it.

Every MCP and API call carries `Authorization: Bearer <token>`, except a human in the browser, who has a session cookie. Agents can hold only `repo:read`, `plan:create` and `change:create`, so no token can ever approve anything.

| Method | For | Token |
|---|---|---|
| Agent token | Any agent, scripts | `gtf_…`, created by a human, up to 365 days |
| MCP OAuth | MCP clients with OAuth support | `gtf_…` access (1 h) + `gtr_…` refresh, per session |
| Device flow | The CLI and other headless tools | Same as OAuth |
| Session cookie | Humans in the web app | better-auth session |

## Agent tokens

1. A human opens **Agents** (`https://<host>/agents`) and chooses **Create agent and token**.
2. They name the agent, pick scopes, and copy the `gtf_…` token. It is shown once and stored hashed.

The same over HTTP, with the human's session:

```sh
curl -s https://<host>/api/v1/principals/agents \
  -H "Cookie: $GITTIFACTS_SESSION" -H "Content-Type: application/json" \
  -d '{"name":"release-bot","scopes":["repo:read","change:create"],"expiresInDays":30}'
```

Expected: `201` with `{ principal, token }`. Asking for `plan:approve`, `change:review`, `repo:admin` or `policy:admin` fails with `403 scope-not-allowed`.

## MCP OAuth

Connect the client to `https://<host>/mcp` without a token. The first real call gets:

```text
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="repo:read plan:create change:create"
```

From there a standard MCP client does the rest:

1. It reads the resource metadata, then the authorization server metadata at `https://<host>/.well-known/oauth-authorization-server`.
2. It identifies itself with a Client ID Metadata Document: its `client_id` is an `https` URL. Dynamic client registration is not offered.
3. It sends the human to `/api/oauth/authorize` with PKCE (S256) and `resource=https://<host>/mcp`.
4. The human sees the consent screen: which repos (all, or chosen ones), which scopes (default: open Changes), and how long (1, 7, 30 or 90 days).
5. The client exchanges the code at `/api/oauth/token` and gets an access token (1 h) and a refresh token that rotates on every use.

Each approved session becomes its own agent actor, owned by the human. Tokens bound to `/mcp` don't work on the HTTP API, and the reverse; ask for `resource=https://<host>/api` for API use.

## CLI device flow

```sh
npx -y https://<host>/cli/v2/gittifacts.tgz --host https://<host> login
```

The CLI prints a URL (`https://<host>/device`) and a code. The human opens it signed in, checks the code, picks repos, scopes and session length, and approves. Expected: `{ "loggedIn": true, … }`. Device-flow tokens work on both `/mcp` and the HTTP API.

## Humans

Sign in at `https://<host>/dashboard` with GitHub, or e-mail and password; add a passkey later. Only humans hold `plan:approve`, `change:review` and the admin scopes, and only for repos where their role allows it ([Members and roles](/docs/guides/members-and-roles)).

## List and revoke

- **Agents** (`/agents`) lists every agent and session: client, scopes, repos, last use, expiry. One click revokes a session; the next request with its tokens fails.
- Over HTTP: `POST /api/v1/agent-sessions/<principalId>/revoke`, or `DELETE /api/v1/principals/<id>/tokens` for a token-based agent.
- A client can end its own session with RFC 7009 revocation of its refresh token at `/api/oauth/revoke`.
- Replaying a refresh token that was already rotated revokes the whole session.

## Errors

| Code | Meaning | Fix |
|---|---|---|
| `401 unauthorized` | No token, or it expired or was revoked | Refresh, or ask the human for a new grant |
| `403 insufficient-scope` | The token lacks a scope this call needs | `whoami` shows your scopes; ask the owner |
| `403 repo-not-granted` | The session is limited to other repos | Ask the human to approve a session for this repo |
| `404 not-found` on a repo you expect | You aren't a member, or your agent's owner isn't | Ask an owner for access |
