---
title: "HTTP API: MCP, webhooks and operators"
nav: "HTTP: platform"
description: "HTTP endpoints for the MCP endpoint, the Workers Issues webhook and operator-only routes."
order: 38
audience: both
generated: true
---

# HTTP API: MCP, webhooks and operators

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## mcp

### `POST /mcp`

MCP server (streamable HTTP, stateless)

JSON-RPC MCP endpoint for agents. `Authorization: Bearer gtf_…` (agent token); without one, only initialize, tools/list, create_project (an unclaimed project and its own token) and whoami are served. The 39 tools: create_project, whoami, search_tools, list_repos, list_members, create_plan, get_plan, list_plans, withdraw_plan, start_change, list_changes, compare_attempts, refresh_push_token, wait_for_change, get_change_status, get_evidence, get_tour, request_review, rerun_ci, close_change, list_issues_for_change, get_rollout, list_audit_events, request_qa, get_qa, enqueue, queue_status, wait_for_merge, dequeue, reprioritize, queue_overview, open_workspace, ws_exec, ws_read, ws_write, ws_diff, ws_commit_push, close_workspace, propose_platform_config. tools/list has each one's schemas; search_tools finds one by what you want to do.

- **Auth:** bearer token
- **Body:** `any`
- **200:** JSON-RPC response (application/json or text/event-stream)
- **Errors:** 401, 403

## webhooks

### `POST /webhooks/workers-issues`

Workers Issues generic webhook (Cloudflare Notifications)

Authenticated by the shared secret in `cf-webhook-auth`. Body is parsed leniently.

- **Auth:** none
- **Parameters:** `cf-webhook-auth` (header, required)
- **Body:** `{ name?, text?, data?, ts?, account_id?, policy_id?, policy_name?, alert_type?, alert_correlation_id?, alert_event? }`
- **202:** `{ received, issueId, changeId, forwarded }`
- **Errors:** 401

## internal

### `POST /api/v1/admin/audit/verify`

Re-verify the whole audit chain from genesis, ignoring the verified-through checkpoint

Reads verify the chain incrementally from a checkpoint. This checks every entry again (O(N) signature checks), clears a recorded break when the chain passes, and moves the checkpoint to the head. Platform admins only (PLATFORM_ADMINS).

- **Auth:** session cookie or bearer token
- **200:** `{ verified, brokenAt?, verifiedThrough, headSeq, complete, checked }`
- **Errors:** 401, 403

### `POST /api/v1/admin/seed-cache`

Pre-build every template's dependency snapshot (CI global cache)

Runs the CI engine's seedCache for each template (or `?template=<id>`), so the first project per template starts warm. Idempotent per template content.

- **Auth:** session cookie or bearer token
- **Parameters:** `template` (query)
- **202:** `{ seeds }`
- **Errors:** 401, 403

### `GET /api/v1/admin/spend`

Today's metered platform spend (USD, upper-bound estimate) and the spend breaker

- **Auth:** session cookie or bearer token
- **200:** `PlatformSpend { day, totalUsd, bySource, softUsd, hardUsd, level, paused, resumedBy }`
- **Errors:** 401, 403

### `PUT /api/v1/admin/spend-breaker`

Resume paid work after the spend breaker tripped (until 00:00 UTC), or hand back to the budgets

`resume`: new CI runs, workspaces, previews, QA and model calls start again for the rest of the UTC day, whatever today's spend. `auto`: the daily budgets decide again. Platform admins only (PLATFORM_ADMINS).

- **Auth:** session cookie or bearer token
- **Body:** `{ mode }`
- **200:** `PlatformSpend { day, totalUsd, bySource, softUsd, hardUsd, level, paused, resumedBy }`
- **Errors:** 400, 401, 403

### `GET /api/v1/admin/unclaimed-creation`

Kill switch for credential-less project creation: flag, override, effective state

- **Auth:** session cookie or bearer token
- **200:** `UnclaimedCreationState { enabled, source, override, flag, detail }`
- **Errors:** 401, 403

### `PUT /api/v1/admin/unclaimed-creation`

Override the kill switch in D1 (works when Flagship is unreachable)

`off` stops unclaimed creation at once, whatever the flag says. `on` only bridges a Flagship that cannot be evaluated (a flag set to false still wins). `flag` clears the override. Platform admins only (PLATFORM_ADMINS).

- **Auth:** session cookie or bearer token
- **Body:** `{ mode }`
- **200:** `UnclaimedCreationState { enabled, source, override, flag, detail }`
- **Errors:** 400, 401, 403

### `GET /internal/ttfg`

Time-to-first-green per project and template (Analytics Engine, else D1)

- **Auth:** session cookie or bearer token
- **Parameters:** `days` (query)
- **200:** `{ source, sinceDays, targetMs, overall, byTemplate, recent, note, firstMerge }`
- **Errors:** 401, 403

## Other

### `GET /api/v1/health`

Liveness and the deployed version and commit, no auth

- **Auth:** none
- **200:** `{ ok, version, commit, deployedAt, db }`
- **Errors:** 503

### `GET /api/v1/stats/first-green`

Live time-to-first-green: aggregates only (no project ids), no auth

From create_project to a green first CI run and a serving preview, over the last `days` days. Percentiles count green projects only; `finished - green` failed CI or the preview. The landing page quotes these numbers.

- **Auth:** none
- **Parameters:** `days` (query)
- **200:** `{ projects, finished, green, withinTarget, p50Ms, p90Ms, sinceDays, targetMs, byTemplate, source, generatedAt }`
