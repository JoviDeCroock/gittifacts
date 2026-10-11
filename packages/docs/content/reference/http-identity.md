---
title: "HTTP API: identity and auth"
nav: "HTTP: identity and auth"
description: "HTTP endpoints for principals, agent tokens, OAuth (authorize, token, revoke, consent, device flow), agent sessions and signing keys."
order: 31
audience: both
generated: true
---

# HTTP API: identity and auth

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## identity

### `GET /api/v1/capabilities`

Who am I, what may I do, on which repos (with claim status), and my quotas

- **Auth:** session cookie or bearer token
- **200:** `Capabilities { principal: Principal, user: SessionUser, scopes, canApprove, repos, quotas }`
- **Errors:** 401

### `GET /api/v1/me`

The calling principal (and the signed-in user, for humans)

- **Auth:** session cookie or bearer token
- **200:** `{ principal: Principal, user: SessionUser }`
- **Errors:** 401

### `GET /api/v1/me/getting-started`

Your first-run checklist: a connected agent, the first green check (with its preview) and a repo brought in

- **Auth:** session cookie or bearer token
- **200:** `GettingStarted { projects, agent, firstGreen, latestBootstrap, repo }`
- **Errors:** 401, 403

### `GET /api/v1/principals`

The caller and the agents it owns

- **Auth:** session cookie or bearer token
- **200:** `{ principals }`
- **Errors:** 401

### `POST /api/v1/principals/agents`

Register an agent principal owned by the caller; returns its bearer token once

Humans only. Agents may hold repo:read, plan:create and change:create; never plan:approve, change:review, policy:admin or repo:admin.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `{ name, scopes, expiresInDays?, repoIds? }`
- **201:** `{ principal: Principal, token }`
- **Errors:** 400, 401, 403

### `GET /api/v1/principals/{id}`

A principal by id (agents include their owner's name)

- **Auth:** session cookie or bearer token
- **Parameters:** `id` (path, required)
- **200:** `{ principal }`
- **Errors:** 401, 403, 404

### `DELETE /api/v1/principals/{id}/tokens`

Revoke every token of a principal (its owner or itself)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `id` (path, required)
- **200:** `{ revoked }`
- **Errors:** 401, 403, 404

## oauth

### `GET /api/oauth/authorize`

OAuth 2.1 authorization endpoint (code + PKCE S256 required); redirects to the consent screen

- **Auth:** none
- **Parameters:** `response_type` (query, required), `client_id` (query, required), `redirect_uri` (query, required), `code_challenge` (query, required), `code_challenge_method` (query, required), `scope` (query), `state` (query), `resource` (query)
- **Errors:** 302, 400

### `POST /api/oauth/revoke`

RFC 7009 revocation (refresh token: ends the whole session)

- **Auth:** none
- **200:** Revoked (or unknown: also 200)
- **Errors:** 400

### `POST /api/oauth/token`

Token endpoint: authorization_code (PKCE), refresh_token (rotating), device_code (RFC 8628)

- **Auth:** none
- **200:** `{ access_token, token_type, expires_in, refresh_token, scope }`
- **Errors:** 400

### `GET /api/v1/agent-sessions`

Your agents' sessions: client, scopes, repos, created, last used, expiry, status

- **Auth:** session cookie or bearer token
- **200:** `{ sessions }`
- **Errors:** 401, 403

### `POST /api/v1/agent-sessions/{principalId}/revoke`

Revoke an agent session: all its tokens stop working now and the agent is disabled

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `principalId` (path, required)
- **200:** `{ session: AgentSession }`
- **Errors:** 401, 403, 404

### `GET /api/v1/oauth/device/{userCode}`

What a device (CLI) login asks for (device screen); binds the code to you

- **Auth:** session cookie or bearer token
- **Parameters:** `userCode` (path, required)
- **200:** `{ consent: ConsentView }`
- **Errors:** 401, 403, 404, 409

### `POST /api/v1/oauth/device/{userCode}/approve`

Approve a device login with scopes, repos and session length

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `userCode` (path, required)
- **Body:** `ConsentDecision { scopes, repoIds, sessionDays, name? }`
- **200:** `{ status }`
- **Errors:** 400, 401, 403, 404, 409

### `POST /api/v1/oauth/device/{userCode}/deny`

Deny a device login

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `userCode` (path, required)
- **200:** `{ status }`
- **Errors:** 401, 403, 404, 409

### `GET /api/v1/oauth/requests/{id}`

What an OAuth client asks for, in plain terms (consent screen)

Humans only. The first signed-in human to open a request owns its decision.

- **Auth:** session cookie or bearer token
- **Parameters:** `id` (path, required)
- **200:** `{ consent: ConsentView }`
- **Errors:** 401, 403, 404

### `POST /api/v1/oauth/requests/{id}/approve`

Approve an OAuth client: scopes, repos and session length; returns where to send the browser

Humans only. Scopes must be a subset of repo:read, plan:create, change:create you hold; agents can never get plan:approve, change:review, policy:admin or repo:admin. repoIds: specific repos, or null for every repo (explicit).

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `id` (path, required)
- **Body:** `ConsentDecision { scopes, repoIds, sessionDays, name? }`
- **200:** `{ redirectTo }`
- **Errors:** 400, 401, 403, 404, 409

### `POST /api/v1/oauth/requests/{id}/deny`

Deny an OAuth client; returns where to send the browser

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `id` (path, required)
- **200:** `{ redirectTo }`
- **Errors:** 401, 403, 404, 409

## keys

### `GET /.well-known/gittifacts-keys.json`

Platform signing keys (evidence, plan approvals, audit entries)

Accepted by `verify-attestation --keys`. Public; cacheable.

- **Auth:** none
- **200:** `{ keys }`
