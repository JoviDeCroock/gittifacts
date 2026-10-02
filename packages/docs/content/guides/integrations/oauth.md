---
title: Install flow (OAuth)
description: OAuth 2.1 authorization code with PKCE for integrations — install on all or selected repos, rotating refresh tokens, uninstall.
order: 2
---

# Install flow (OAuth)

The install flow is OAuth 2.1 authorization code with **PKCE S256, required for every integration**. It runs on the same authorization server agents use, and the HTTP API (`https://<host>/api`) is the only audience.

## 1. Send the person to the authorization endpoint

```
https://<host>/api/oauth/authorize?response_type=code
  &client_id=gtic_…
  &redirect_uri=https%3A%2F%2Fdeploy.example%2Fcallback
  &scope=repo%3Aread+contents%3Aread+webhooks+deployments%3Awrite
  &state=…&code_challenge=…&code_challenge_method=S256
  &resource=https%3A%2F%2F<host>%2Fapi
```

`scope` is a subset of what you registered (empty: all of it). `resource` is optional, and only `https://<host>/api` is accepted.

## 2. They install

They sign in and see what you asked for in plain words. They pick **all the repositories they own or maintain**, or **selected ones**, and approve. That creates an **installation**: your integration × their account × those repos. Only claimed repos they own or maintain can be picked.

They come back to:

```
redirect_uri?code=…&state=…&iss=https://<host>&installation_id=ins_…
```

## 3. Exchange the code

`client_secret_basic` is shown below; `client_secret_post` works too. Public clients send `client_id` and no secret.

```sh
curl -s https://<host>/api/oauth/token -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=authorization_code -d code="$CODE" -d code_verifier="$VERIFIER" \
  -d redirect_uri=https://deploy.example/callback
```

```json
{ "access_token": "gti_…", "token_type": "Bearer", "expires_in": 3600,
  "refresh_token": "gtir_…", "scope": "repo:read contents:read webhooks deployments:write",
  "installation_id": "ins_…" }
```

## 4. Keep it fresh

- Access tokens last **1 hour**.
- Refresh with `grant_type=refresh_token` and the same client authentication. You get a new pair, and the old refresh token is spent.
- **Replaying a spent refresh token or a used code revokes every token of the installation.** The person stays installed; you run the flow again.
- Revoke a single token with `POST https://<host>/api/oauth/revoke` (RFC 7009).
- `GET https://<host>/api/v1/installation` (Bearer) returns the account, the granted repositories and their clone URLs.

## Uninstall

The person uninstalls with one click under Settings → Integrations. Every token stops working at once, and no more events are sent except a final `installation.deleted`.
