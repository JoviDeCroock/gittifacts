---
title: "HTTP API"
description: "All 129 HTTP operations of the platform, grouped by area, with auth, idempotency, bodies and error codes."
order: 30
audience: both
generated: true
---

# HTTP API

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

JSON over HTTPS at `https://<host>`. The OpenAPI 3.1 document is at `https://<host>/openapi.json` (alias of `/api/v1/openapi.json`).

- **Auth:** `Authorization: Bearer <token>` (agent, integration or OAuth token), or the browser session cookie for humans. See [Authenticate](/docs/guides/authenticate).
- **Errors:** `{ "error": { "code", "message", "fix": { "explanation", "call"?, "command"?, "docsUrl"? }, "details"? } }` with a matching status. See [error codes](/docs/reference/errors).
- **Retries:** send `Idempotency-Key` on create and mutate calls. The same key and body replays the first response; the same key with another body is `409 idempotency-key-reuse`.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | [`/.well-known/gittifacts-keys.json`](/docs/reference/http-identity) | Platform signing keys (evidence, plan approvals, audit entries) |
| `GET` | [`/api/oauth/authorize`](/docs/reference/http-identity) | OAuth 2.1 authorization endpoint (code + PKCE S256 required); redirects to the consent screen |
| `POST` | [`/api/oauth/revoke`](/docs/reference/http-identity) | RFC 7009 revocation (refresh token: ends the whole session) |
| `POST` | [`/api/oauth/token`](/docs/reference/http-identity) | Token endpoint: authorization_code (PKCE), refresh_token (rotating), device_code (RFC 8628) |
| `POST` | [`/api/v1/admin/audit/verify`](/docs/reference/http-platform) | Re-verify the whole audit chain from genesis, ignoring the verified-through checkpoint |
| `POST` | [`/api/v1/admin/seed-cache`](/docs/reference/http-platform) | Pre-build every template's dependency snapshot (CI global cache) |
| `GET` | [`/api/v1/admin/spend`](/docs/reference/http-platform) | Today's metered platform spend (USD, upper-bound estimate) and the spend breaker |
| `PUT` | [`/api/v1/admin/spend-breaker`](/docs/reference/http-platform) | Resume paid work after the spend breaker tripped (until 00:00 UTC), or hand back to the budgets |
| `GET` | [`/api/v1/admin/unclaimed-creation`](/docs/reference/http-platform) | Kill switch for credential-less project creation: flag, override, effective state |
| `PUT` | [`/api/v1/admin/unclaimed-creation`](/docs/reference/http-platform) | Override the kill switch in D1 (works when Flagship is unreachable) |
| `GET` | [`/api/v1/agent-sessions`](/docs/reference/http-identity) | Your agents' sessions: client, scopes, repos, created, last used, expiry, status |
| `POST` | [`/api/v1/agent-sessions/{principalId}/revoke`](/docs/reference/http-identity) | Revoke an agent session: all its tokens stop working now and the agent is disabled |
| `GET` | [`/api/v1/audit`](/docs/reference/http-changes) | Audit log, newest first, with hash-chain verification |
| `GET` | [`/api/v1/blobs/{ref}`](/docs/reference/http-changes) | Raw bytes of an R2 reference (logRef, beforeRef, afterRef), authorized by the owning repo |
| `GET` | [`/api/v1/capabilities`](/docs/reference/http-identity) | Who am I, what may I do, on which repos (with claim status), and my quotas |
| `POST` | [`/api/v1/changes`](/docs/reference/http-changes) | Start a change: fork the repo and get a push token for the fork only |
| `GET` | [`/api/v1/changes/{changeId}`](/docs/reference/http-changes) | A change with its plan, pipeline runs and classification for the current head |
| `POST` | [`/api/v1/changes/{changeId}/close`](/docs/reference/http-changes) | Close (abandon) a change that won't merge (author or maintainer) |
| `GET` | [`/api/v1/changes/{changeId}/diff`](/docs/reference/http-changes) | Diff of the current head against the base |
| `GET` | [`/api/v1/changes/{changeId}/events`](/docs/reference/http-changes) | The change as Server-Sent Events, one `change` event per update |
| `GET` | [`/api/v1/changes/{changeId}/evidence`](/docs/reference/http-changes) | Signed evidence for the current head, re-verified against the platform keys |
| `GET` | [`/api/v1/changes/{changeId}/issues`](/docs/reference/http-changes) | Workers Issues attributed to the change (or its rollout version) |
| `POST` | [`/api/v1/changes/{changeId}/kill`](/docs/reference/http-changes) | Kill switch: flag off, roll back, open a revert change (human maintainer or owner) |
| `GET` | [`/api/v1/changes/{changeId}/overlaps`](/docs/reference/http-changes) | Open Changes in the same repo that share this change's Plan or touch the same paths |
| `GET` | [`/api/v1/changes/{changeId}/qa`](/docs/reference/http-changes) | The change's QA runs, newest first |
| `POST` | [`/api/v1/changes/{changeId}/qa`](/docs/reference/http-changes) | Ask for QA in a browser on the current head (on request only; idempotent per head) |
| `GET` | [`/api/v1/changes/{changeId}/queue`](/docs/reference/http-merge-queue) | A Change's place in the merge queue (state, track, batch, position, ETA, why it waits) |
| `POST` | [`/api/v1/changes/{changeId}/queue`](/docs/reference/http-merge-queue) | Enqueue options (priority, stack, plan group, land mode); the Change joins on approval |
| `PATCH` | [`/api/v1/changes/{changeId}/queue`](/docs/reference/http-merge-queue) | Reprioritize a queued Change (incident needs a human or an approved incident Plan) |
| `DELETE` | [`/api/v1/changes/{changeId}/queue`](/docs/reference/http-merge-queue) | Take a Change out of the merge queue (its stack dependents leave too) |
| `GET` | [`/api/v1/changes/{changeId}/queue/wait`](/docs/reference/http-merge-queue) | Long-poll until the Change merges, is ejected or dequeued, or the queue freezes |
| `POST` | [`/api/v1/changes/{changeId}/request-review`](/docs/reference/http-changes) | Ask for a human review of a change (author or its owner): recorded in the audit log, no message is sent; never approves |
| `POST` | [`/api/v1/changes/{changeId}/rerun`](/docs/reference/http-changes) | Re-run CI, evidence, lane and walkthrough on the current head (author or maintainer) |
| `GET` | [`/api/v1/changes/{changeId}/resolution`](/docs/reference/http-changes) | The merge queue's conflict resolution of this change (null when it needed none): what lands, what each side had |
| `POST` | [`/api/v1/changes/{changeId}/review`](/docs/reference/http-changes) | Review a change (human, change:review, not the author); binds to a head |
| `GET` | [`/api/v1/changes/{changeId}/reviews`](/docs/reference/http-changes) | Human reviews of a change, oldest first (each bound to a head) |
| `GET` | [`/api/v1/changes/{changeId}/rollout`](/docs/reference/http-changes) | Rollout state and the change's audit timeline |
| `POST` | [`/api/v1/changes/{changeId}/token`](/docs/reference/http-changes) | Fresh short-lived push token for the change's fork (author only) |
| `GET` | [`/api/v1/changes/{changeId}/tour`](/docs/reference/http-changes) | The reviewer agent's walkthrough (tour) for the current head |
| `GET` | [`/api/v1/claims/{token}`](/docs/reference/http-plans) | An unclaimed project behind a claim link: name, creator, expiry, what claiming does |
| `POST` | [`/api/v1/claims/{token}`](/docs/reference/http-plans) | Claim an unclaimed project (signed-in human + Turnstile); single-use, idempotent |
| `GET` | [`/api/v1/deployments/{deploymentId}`](/docs/reference/http-integrations) | A deployment with its status history |
| `POST` | [`/api/v1/deployments/{deploymentId}/statuses`](/docs/reference/http-integrations) | Integrations: report a deployment's state (queued, in_progress, success, failure, error) with its URL and log |
| `GET` | [`/api/v1/github`](/docs/reference/http-github) | GitHub mode: our GitHub App (or which config is missing) and the installations you linked |
| `POST` | [`/api/v1/github/repos/{repoId}/backtests`](/docs/reference/http-github) | Repo owners: backtest the repository's merged PRs (lanes, later reverts and patches, calibration) |
| `GET` | [`/api/v1/github/repos/{repoId}/backtests/latest`](/docs/reference/http-github) | The repository's latest backtest and its report |
| `PUT` | [`/api/v1/github/repos/{repoId}/pr-writes`](/docs/reference/http-github) | Repo owners: turn the walkthrough review and summary comment on GitHub PRs on or off |
| `GET` | [`/api/v1/health`](/docs/reference/http-platform) | Liveness and the deployed version and commit, no auth |
| `GET` | [`/api/v1/installation`](/docs/reference/http-integrations) | Integration tokens: this installation, its account and its repositories (with clone URLs) |
| `GET` | [`/api/v1/installations`](/docs/reference/http-integrations) | Integrations installed on your account: what each may do and on which repos |
| `PATCH` | [`/api/v1/installations/{installationId}`](/docs/reference/http-integrations) | Change which repos an installed integration reaches |
| `POST` | [`/api/v1/installations/{installationId}/uninstall`](/docs/reference/http-integrations) | Uninstall: every token stops working now and no more events are sent (except installation.deleted) |
| `GET` | [`/api/v1/integration-installs/{id}`](/docs/reference/http-integrations) | What an integration asks for, in plain words, and the repos you may install it on |
| `POST` | [`/api/v1/integration-installs/{id}/approve`](/docs/reference/http-integrations) | Install (or update) the integration on all or selected repos; returns where to send the browser |
| `POST` | [`/api/v1/integration-installs/{id}/deny`](/docs/reference/http-integrations) | Decline an install request; returns where to send the browser |
| `GET` | [`/api/v1/integrations`](/docs/reference/http-integrations) | Your registered integrations (developer portal) |
| `POST` | [`/api/v1/integrations`](/docs/reference/http-integrations) | Register an integration: returns its client_id and (confidential clients) the client secret, once |
| `GET` | [`/api/v1/integrations/{integrationId}`](/docs/reference/http-integrations) | One of your integrations |
| `PATCH` | [`/api/v1/integrations/{integrationId}`](/docs/reference/http-integrations) | Update an integration (name, URLs, redirect URIs, permissions, webhook) |
| `DELETE` | [`/api/v1/integrations/{integrationId}`](/docs/reference/http-integrations) | Delete an integration: uninstalled everywhere, its tokens stop working now |
| `GET` | [`/api/v1/integrations/{integrationId}/deliveries`](/docs/reference/http-integrations) | Webhook delivery log (newest first) |
| `GET` | [`/api/v1/integrations/{integrationId}/deliveries/{deliveryId}`](/docs/reference/http-integrations) | One delivery: request headers (signature), payload, response |
| `POST` | [`/api/v1/integrations/{integrationId}/deliveries/{deliveryId}/redeliver`](/docs/reference/http-integrations) | Send a delivery again (same X-Gittifacts-Delivery, fresh signature) |
| `POST` | [`/api/v1/integrations/{integrationId}/ping`](/docs/reference/http-integrations) | Send a signed `ping` event to the webhook URL |
| `POST` | [`/api/v1/integrations/{integrationId}/secrets`](/docs/reference/http-integrations) | Generate a new client secret (shown once; at most two active while you rotate) |
| `DELETE` | [`/api/v1/integrations/{integrationId}/secrets/{secretId}`](/docs/reference/http-integrations) | Revoke a client secret |
| `POST` | [`/api/v1/integrations/{integrationId}/webhook-secret`](/docs/reference/http-integrations) | Generate a new webhook secret (shown once; signatures use it from now on) |
| `GET` | [`/api/v1/invites/{token}`](/docs/reference/http-repos) | What an invite link offers: the repo, the role, who sent it (no sign-in needed) |
| `POST` | [`/api/v1/invites/{token}/accept`](/docs/reference/http-repos) | Accept an invite: a signed-in person whose e-mail is the invited one joins the repo |
| `GET` | [`/api/v1/me`](/docs/reference/http-identity) | The calling principal (and the signed-in user, for humans) |
| `GET` | [`/api/v1/me/getting-started`](/docs/reference/http-identity) | Your first-run checklist: a connected agent, the first green check (with its preview) and a repo brought in |
| `GET` | [`/api/v1/oauth/device/{userCode}`](/docs/reference/http-identity) | What a device (CLI) login asks for (device screen); binds the code to you |
| `POST` | [`/api/v1/oauth/device/{userCode}/approve`](/docs/reference/http-identity) | Approve a device login with scopes, repos and session length |
| `POST` | [`/api/v1/oauth/device/{userCode}/deny`](/docs/reference/http-identity) | Deny a device login |
| `GET` | [`/api/v1/oauth/requests/{id}`](/docs/reference/http-identity) | What an OAuth client asks for, in plain terms (consent screen) |
| `POST` | [`/api/v1/oauth/requests/{id}/approve`](/docs/reference/http-identity) | Approve an OAuth client: scopes, repos and session length; returns where to send the browser |
| `POST` | [`/api/v1/oauth/requests/{id}/deny`](/docs/reference/http-identity) | Deny an OAuth client; returns where to send the browser |
| `POST` | [`/api/v1/plans`](/docs/reference/http-plans) | Draft a plan (intent, acceptance criteria, scope) |
| `GET` | [`/api/v1/plans/{planId}`](/docs/reference/http-plans) | A plan and the changes that implement it |
| `POST` | [`/api/v1/plans/{planId}/approve`](/docs/reference/http-plans) | Approve a draft plan (human, plan:approve, not the author); signs the approval |
| `GET` | [`/api/v1/plans/{planId}/attempts`](/docs/reference/http-plans) | Every change attempting this plan, ranked by evidence and lane, with the recommended one |
| `POST` | [`/api/v1/plans/{planId}/attempts/{changeId}/pick`](/docs/reference/http-plans) | Pick one attempt (human, change:review, not its author): approves it, closes the others |
| `POST` | [`/api/v1/plans/{planId}/reject`](/docs/reference/http-plans) | Reject a draft plan (human maintainer or owner; the author may withdraw) |
| `POST` | [`/api/v1/plans/{planId}/withdraw`](/docs/reference/http-plans) | Withdraw a draft plan you drafted (its author only, agents included) |
| `GET` | [`/api/v1/principals`](/docs/reference/http-identity) | The caller and the agents it owns |
| `POST` | [`/api/v1/principals/agents`](/docs/reference/http-identity) | Register an agent principal owned by the caller; returns its bearer token once |
| `GET` | [`/api/v1/principals/{id}`](/docs/reference/http-identity) | A principal by id (agents include their owner's name) |
| `DELETE` | [`/api/v1/principals/{id}/tokens`](/docs/reference/http-identity) | Revoke every token of a principal (its owner or itself) |
| `POST` | [`/api/v1/projects`](/docs/reference/http-repos) | Create a project in one call: repo + .platform/* + AGENTS.md + first CI + first preview |
| `GET` | [`/api/v1/repos`](/docs/reference/http-repos) | Repos with lane counts and shadow-mode stats |
| `POST` | [`/api/v1/repos`](/docs/reference/http-repos) | Create a repo, or import one from a public https git URL |
| `GET` | [`/api/v1/repos/{repoId}`](/docs/reference/http-repos) | A repo with shadow-mode stats and lane counts |
| `GET` | [`/api/v1/repos/{repoId}/activity`](/docs/reference/http-repos) | Commits per day (UTC, by landing date) over whole weeks, and the top authors |
| `GET` | [`/api/v1/repos/{repoId}/changes`](/docs/reference/http-changes) | Changes of a repo (with plan title and author), most recently updated first |
| `GET` | [`/api/v1/repos/{repoId}/commits`](/docs/reference/http-repos) | First-parent history from a ref, newest first, each with the Change that landed it |
| `GET` | [`/api/v1/repos/{repoId}/commits/{sha}`](/docs/reference/http-repos) | One commit with its diff against its first parent |
| `PATCH` | [`/api/v1/repos/{repoId}/deploy-target`](/docs/reference/http-repos) | Set or clear the Worker merged Changes roll out to (human repo admin, claimed projects) |
| `GET` | [`/api/v1/repos/{repoId}/deployments`](/docs/reference/http-integrations) | Deployments reported for a repo (newest first) |
| `POST` | [`/api/v1/repos/{repoId}/deployments`](/docs/reference/http-integrations) | Integrations: report a deployment of a commit (preview of a Change, or production) |
| `GET` | [`/api/v1/repos/{repoId}/file`](/docs/reference/http-repos) | One file at a ref: text up to 512 KiB, else binary or too-large without content |
| `GET` | [`/api/v1/repos/{repoId}/import-grant`](/docs/reference/http-repos) | The project's import-by-push grant (state only, never the token) |
| `POST` | [`/api/v1/repos/{repoId}/import-grant`](/docs/reference/http-repos) | Open a new import-by-push grant for a project that has no default branch yet |
| `DELETE` | [`/api/v1/repos/{repoId}/import-grant`](/docs/reference/http-repos) | Close the import-by-push grant now (revokes its token) |
| `DELETE` | [`/api/v1/repos/{repoId}/invites/{inviteId}`](/docs/reference/http-repos) | Revoke an open invite (human owner); its link stops working |
| `PATCH` | [`/api/v1/repos/{repoId}/lane0`](/docs/reference/http-repos) | Turn Lane 0 (auto-merge) on or off |
| `GET` | [`/api/v1/repos/{repoId}/members`](/docs/reference/http-repos) | A repo's members and their roles (anyone who can read the repo) |
| `POST` | [`/api/v1/repos/{repoId}/members`](/docs/reference/http-repos) | Add a member by e-mail or principal id, or change a member's role (human owner) |
| `DELETE` | [`/api/v1/repos/{repoId}/members/{principalId}`](/docs/reference/http-repos) | Remove a member (human owner), or leave the repo (your own principal id) |
| `GET` | [`/api/v1/repos/{repoId}/plans`](/docs/reference/http-plans) | Plans of a repo, newest first |
| `GET` | [`/api/v1/repos/{repoId}/platform-config`](/docs/reference/http-repos) | The repo's latest .platform proposal (null when none was made) |
| `POST` | [`/api/v1/repos/{repoId}/platform-config`](/docs/reference/http-repos) | Propose .platform/ci.ts, .platform/policy.ts and AGENTS.md from import detection |
| `GET` | [`/api/v1/repos/{repoId}/queue`](/docs/reference/http-merge-queue) | The merge queue: tracks, batches, landing, freeze state, entries with reasons and ETAs |
| `GET` | [`/api/v1/repos/{repoId}/queue/events`](/docs/reference/http-merge-queue) | The merge queue's events as Server-Sent Events |
| `POST` | [`/api/v1/repos/{repoId}/queue/freeze`](/docs/reference/http-merge-queue) | Freeze the queue: only reverts and incident fixes land (human-signed audit event) |
| `POST` | [`/api/v1/repos/{repoId}/queue/resume`](/docs/reference/http-merge-queue) | Resume a queue that halted on an invariant violation (after an operator checked it) |
| `POST` | [`/api/v1/repos/{repoId}/queue/thaw`](/docs/reference/http-merge-queue) | Thaw the queue; batches built on the bad main are invalidated (human-signed audit event) |
| `GET` | [`/api/v1/repos/{repoId}/raw`](/docs/reference/http-repos) | One file's raw bytes at a ref (images inline, text as text/plain, else a download; ≤10 MiB) |
| `GET` | [`/api/v1/repos/{repoId}/tree`](/docs/reference/http-repos) | A directory's entries at a ref (directories first), with its README |
| `GET` | [`/api/v1/sign-in-options`](/docs/reference/http-identity) | What the sign-in page may offer on this deployment (no sign-in needed) |
| `GET` | [`/api/v1/stats/first-green`](/docs/reference/http-platform) | Live time-to-first-green: aggregates only (no project ids), no auth |
| `POST` | [`/git/{owner}/{repo}.git/git-receive-pack`](/docs/reference/http-integrations) | Always 403: nothing pushes through the integration git endpoint |
| `POST` | [`/git/{owner}/{repo}.git/git-upload-pack`](/docs/reference/http-integrations) | Git smart HTTP upload-pack (clone/fetch), streamed from the Artifacts remote |
| `GET` | [`/git/{owner}/{repo}.git/info/refs`](/docs/reference/http-integrations) | Git smart HTTP ref advertisement (service=git-upload-pack only; read-only) |
| `GET` | [`/github/oauth/callback`](/docs/reference/http-github) | User authorization callback: links the installation if it is yours |
| `GET` | [`/github/setup`](/docs/reference/http-github) | GitHub redirect after installing an App; verified through user authorization |
| `POST` | [`/github/webhooks`](/docs/reference/http-github) | GitHub App webhooks (HMAC-SHA-256 per App, deduplicated by delivery id, queued) |
| `GET` | [`/internal/ttfg`](/docs/reference/http-platform) | Time-to-first-green per project and template (Analytics Engine, else D1) |
| `POST` | [`/mcp`](/docs/reference/http-platform) | MCP server (streamable HTTP, stateless) |
| `POST` | [`/webhooks/workers-issues`](/docs/reference/http-platform) | Workers Issues generic webhook (Cloudflare Notifications) |
