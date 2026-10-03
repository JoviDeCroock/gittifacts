---
title: "MCP tools: plans and changes"
nav: "MCP: plans and changes"
description: "create_plan, start_change, wait_for_change and the read tools for status, evidence, tours and issues: arguments, scopes, examples and outputs."
order: 12
audience: agents
generated: true
---

# MCP tools: plans and changes

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## `create_plan`

Draft a plan: intent, acceptance criteria and the paths you expect to touch. A human other than you approves it before you start a change. Returns the plan id.

**Scope:** `plan:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts create-plan`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |
| `title` | string | yes | max 200 chars |
| `intent` | string | yes | Why: the problem and the intended outcome. max 10000 chars |
| `acceptanceCriteria` | string[] | yes | Observable results a reviewer can check. max 50 items |
| `outOfScope` | string[] |  | max 50 items |
| `riskDeclarations` | object[] |  | max 50 items |
| `riskDeclarations[].area` | string | yes | max 200 chars |
| `riskDeclarations[].description` | string | yes | max 2000 chars |
| `scopePaths` | string[] |  | Globs of the paths the change will touch, like "docs/*.md". Leaving them out blocks Lane 0. max 100 items |
| `affectedRoutes` | string[] |  | max 20 items |
| `supersedes` | string |  | Plan id this plan replaces. max 64 chars |

```text
create_plan({ repoId: "<repoId>", title: "<title>", intent: "<why>", acceptanceCriteria: ["<done when>"] })
```

**Returns:** `plan` (object), `nextSteps` (object[]).

## `start_change`

Fork the repo for one change and get a short-lived push grant for that fork only. Push commits there; CI, evidence and the lane follow automatically.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts start-change`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |
| `planId` | string |  | The approved plan this change implements. max 64 chars |
| `title` | string | yes | max 200 chars |
| `category` | "fix" \| "feature" \| "refactor" \| "dependency" \| "transform" \| "revert" \| "docs" \| "chore" | yes | Your claim; it can only raise risk, never lower it. |
| `summary` | string |  | max 10000 chars |
| `agentTraceId` | string |  | max 200 chars |

```text
start_change({ repoId: "<repoId>", title: "<what>", category: "fix" })
```

**Returns:** `change` (object), `remote` (object), `nextSteps` (object[]).

## `refresh_push_token`

A fresh short-lived push grant for your change's fork (author only). Use it when the old token expired.

**Scope:** `change:create` · **Kind:** mutating · **CLI:** `gittifacts refresh-push-token`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |

```text
refresh_push_token({ changeId: "<changeId>" })
```

**Returns:** `remote` (object).

## `wait_for_change`

Long-poll until the change reaches a milestone (evidence_ready, lane_assigned, tour_ready, merged, reverted), can no longer reach it, or the timeout passes. Prefer this to polling.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts wait-for-change`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |
| `until` | "evidence_ready" \| "lane_assigned" \| "tour_ready" \| "merged" \| "reverted" | yes |  |
| `timeoutSec` | integer |  | Default 50. Keep it below your MCP client's request timeout (60s in the SDK default) and call again if not reached. 1–600 |

```text
wait_for_change({ changeId: "<changeId>", until: "merged" })
```

**Returns:** `reached` (boolean), `reason` ("reached" | "timeout" | "unreachable"), `change` (object), `nextSteps` (object[]).

## `get_change_status`

A change's status, lane (and why), pipeline runs for each head, and what to do next.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts get-change-status`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |

```text
get_change_status({})
```

**Returns:** `change` (object), `runs` (object[]), `classification` (null | object), `nextSteps` (object[]).

## `get_evidence`

The signed evidence for the change's current head (tests, red/green proof, coverage, API diff, ...) and whether the signature verifies.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts get-evidence`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |

```text
get_evidence({})
```

**Returns:** `changeId` (string), `headSha` (string), `verification` ({ ok, keyId, reason }), `signedAt` (string), `keyId` (string), `items` (object[]).

## `get_tour`

The reviewer agent's guided tour of the change (what a human will read): stops with verdicts, least-confident points and what was not done.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts get-tour`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |

```text
get_tour({})
```

**Returns:** `tour` (object), `stale` (boolean).

## `request_review`

Ask a human to look at your change (notifies them). This never approves anything: agents cannot approve plans or changes.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts request-review`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `message` | string |  | max 2000 chars |

```text
request_review({ changeId: "<changeId>" })
```

**Returns:** `changeId` (string), `status` ("awaiting-push" | "running" | "failing" | "awaiting-review" | "approved" | "queued" | "merged" | "rolling-out" | "released" | "reverted" | "rejected" | "abandoned"), `notified` (boolean), `nextSteps` (object[]).

## `list_issues_for_change`

Workers Issues attributed to the change or the version it rolled out (errors seen in production).

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts list-issues-for-change`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |

```text
list_issues_for_change({ changeId: "<changeId>" })
```

**Returns:** `issues` (object[]).
