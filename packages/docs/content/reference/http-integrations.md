---
title: "HTTP API: integrations"
nav: "HTTP: integrations"
description: "HTTP endpoints for the developer portal, installations, webhook deliveries, deployments and the read-only git proxy."
order: 35
audience: both
generated: true
---

# HTTP API: integrations

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## integrations

### `GET /api/v1/installation`

Integration tokens: this installation, its account and its repositories (with clone URLs)

- **Auth:** bearer token
- **200:** `CurrentInstallation { installation, repositories }`
- **Errors:** 401, 403, 404

### `GET /api/v1/installations`

Integrations installed on your account: what each may do and on which repos

- **Auth:** session cookie or bearer token
- **200:** `{ installations }`
- **Errors:** 401, 403

### `PATCH /api/v1/installations/{installationId}`

Change which repos an installed integration reaches

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `installationId` (path, required)
- **Body:** `InstallDecision { repoSelection, repoIds? }`
- **200:** `{ installation: Installation }`
- **Errors:** 400, 401, 403, 404, 409

### `POST /api/v1/installations/{installationId}/uninstall`

Uninstall: every token stops working now and no more events are sent (except installation.deleted)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `installationId` (path, required)
- **200:** `{ installation: Installation }`
- **Errors:** 401, 403, 404

### `GET /api/v1/integration-installs/{id}`

What an integration asks for, in plain words, and the repos you may install it on

Humans only. The first signed-in human to open an install request owns its decision.

- **Auth:** session cookie or bearer token
- **Parameters:** `id` (path, required)
- **200:** `{ install: IntegrationInstallView }`
- **Errors:** 401, 403, 404

### `POST /api/v1/integration-installs/{id}/approve`

Install (or update) the integration on all or selected repos; returns where to send the browser

Only claimed repos you own can be selected; unclaimed projects are refused (repo-not-installable).

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `id` (path, required)
- **Body:** `InstallDecision { repoSelection, repoIds? }`
- **200:** `{ redirectTo }`
- **Errors:** 400, 401, 403, 404, 409

### `POST /api/v1/integration-installs/{id}/deny`

Decline an install request; returns where to send the browser

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `id` (path, required)
- **200:** `{ redirectTo }`
- **Errors:** 401, 403, 404, 409

### `GET /api/v1/integrations`

Your registered integrations (developer portal)

- **Auth:** session cookie or bearer token
- **200:** `{ integrations }`
- **Errors:** 401, 403

### `POST /api/v1/integrations`

Register an integration: returns its client_id and (confidential clients) the client secret, once

Redirect URIs match exactly. Permissions are a subset of repo:read contents:read webhooks deployments:write checks:write. Without webhook.secret a webhook secret is generated and returned once.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `IntegrationInput { name, description?, logoUrl?, homepageUrl, redirectUris, clientType?, scopes, webhook? }`
- **201:** `{ integration: Integration, clientSecret, webhookSecret }`
- **Errors:** 400, 401, 403

### `GET /api/v1/integrations/{integrationId}`

One of your integrations

- **Auth:** session cookie or bearer token
- **Parameters:** `integrationId` (path, required)
- **200:** `{ integration: Integration }`
- **Errors:** 401, 403, 404

### `PATCH /api/v1/integrations/{integrationId}`

Update an integration (name, URLs, redirect URIs, permissions, webhook)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `integrationId` (path, required)
- **Body:** `IntegrationPatch { name?, description?, logoUrl?, homepageUrl?, redirectUris?, scopes?, webhook? }`
- **200:** `{ integration: Integration }`
- **Errors:** 400, 401, 403, 404

### `DELETE /api/v1/integrations/{integrationId}`

Delete an integration: uninstalled everywhere, its tokens stop working now

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `integrationId` (path, required)
- **200:** `{ deleted, uninstalled }`
- **Errors:** 401, 403, 404

### `GET /api/v1/integrations/{integrationId}/deliveries`

Webhook delivery log (newest first)

- **Auth:** session cookie or bearer token
- **Parameters:** `integrationId` (path, required), `status` (query), `event` (query), `limit` (query)
- **200:** `{ deliveries }`
- **Errors:** 401, 403, 404

### `GET /api/v1/integrations/{integrationId}/deliveries/{deliveryId}`

One delivery: request headers (signature), payload, response

- **Auth:** session cookie or bearer token
- **Parameters:** `integrationId` (path, required), `deliveryId` (path, required)
- **200:** `{ delivery: WebhookDeliveryDetail }`
- **Errors:** 401, 403, 404

### `POST /api/v1/integrations/{integrationId}/deliveries/{deliveryId}/redeliver`

Send a delivery again (same X-Gittifacts-Delivery, fresh signature)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `integrationId` (path, required), `deliveryId` (path, required)
- **202:** `{ delivery: WebhookDelivery }`
- **Errors:** 401, 403, 404, 409

### `POST /api/v1/integrations/{integrationId}/ping`

Send a signed `ping` event to the webhook URL

- **Auth:** session cookie or bearer token
- **Parameters:** `integrationId` (path, required)
- **202:** `{ delivery: WebhookDelivery }`
- **Errors:** 401, 403, 404, 409

### `POST /api/v1/integrations/{integrationId}/secrets`

Generate a new client secret (shown once; at most two active while you rotate)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `integrationId` (path, required)
- **201:** `{ clientSecret, secret: IntegrationSecret, integration: Integration }`
- **Errors:** 401, 403, 404, 409

### `DELETE /api/v1/integrations/{integrationId}/secrets/{secretId}`

Revoke a client secret

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `integrationId` (path, required), `secretId` (path, required)
- **200:** `{ integration: Integration }`
- **Errors:** 401, 403, 404

### `POST /api/v1/integrations/{integrationId}/webhook-secret`

Generate a new webhook secret (shown once; signatures use it from now on)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `integrationId` (path, required)
- **200:** `{ webhookSecret, integration: Integration }`
- **Errors:** 401, 403, 404

## deployments

### `GET /api/v1/deployments/{deploymentId}`

A deployment with its status history

- **Auth:** session cookie or bearer token
- **Parameters:** `deploymentId` (path, required)
- **200:** `{ deployment: Deployment }`
- **Errors:** 401, 403, 404

### `POST /api/v1/deployments/{deploymentId}/statuses`

Integrations: report a deployment's state (queued, in_progress, success, failure, error) with its URL and log

A successful preview becomes a signed `preview` evidence item on its Change (informational: it never lowers a lane). Production deployments appear in the Change's rollout timeline; failures with their log link.

- **Auth:** bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `deploymentId` (path, required)
- **Body:** `DeploymentStatusInput { state, url?, logUrl?, description? }`
- **201:** `{ deployment: Deployment }`
- **Errors:** 400, 401, 403, 404

### `GET /api/v1/repos/{repoId}/deployments`

Deployments reported for a repo (newest first)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required), `environment` (query), `changeId` (query), `limit` (query)
- **200:** `{ deployments }`
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/deployments`

Integrations: report a deployment of a commit (preview of a Change, or production)

Integration token with deployments:write, on a repo of its installation (never an unclaimed project). changeId ties a preview to its Change; production deployments are matched to the merged Change by sha.

- **Auth:** bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `DeploymentInput { sha, environment, changeId?, ref?, description? }`
- **201:** `{ deployment: Deployment }`
- **Errors:** 400, 401, 403, 404

## git

### `POST /git/{owner}/{repo}.git/git-receive-pack`

Always 403: nothing pushes through the integration git endpoint

- **Auth:** none
- **Parameters:** `owner` (path, required), `repo` (path, required)
- **Errors:** 403

### `POST /git/{owner}/{repo}.git/git-upload-pack`

Git smart HTTP upload-pack (clone/fetch), streamed from the Artifacts remote

- **Auth:** bearer token
- **Parameters:** `owner` (path, required), `repo` (path, required)
- **200:** application/x-git-upload-pack-result
- **Errors:** 401, 403, 404

### `GET /git/{owner}/{repo}.git/info/refs`

Git smart HTTP ref advertisement (service=git-upload-pack only; read-only)

Basic `x-access-token:<token>` or Bearer. Integration tokens need contents:read; agent tokens repo:read. A Change's fork: /git/{owner}/{repo}/changes/{changeId}.git/…

- **Auth:** bearer token
- **Parameters:** `owner` (path, required), `repo` (path, required), `service` (query, required)
- **200:** application/x-git-upload-pack-advertisement
- **Errors:** 401, 403, 404
