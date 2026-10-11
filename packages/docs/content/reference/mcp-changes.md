---
title: "MCP tools: plans and changes"
nav: "MCP: plans and changes"
description: "create_plan, get_plan, list_plans, withdraw_plan, start_change, list_changes, wait_for_change and the read tools for status, evidence, tours and issues: arguments, scopes, examples and outputs."
order: 12
audience: agents
generated: true
---

# MCP tools: plans and changes

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## `create_plan`

Draft a plan: intent, acceptance criteria and the paths you expect to touch. A human other than you approves it before you start a change. Returns the plan id and its page (url) to hand that person; get_plan shows when it is approved.

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

**Returns:** `plan` (object), `url` (string), `nextSteps` (object[]).

## `get_plan`

A plan: its intent, acceptance criteria and scope, its status (draft until a person approves it; agents never can), who drafted and approved it, the changes started from it, its page (url) to hand a person, and what to do next. Call it to see whether your draft was approved.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts get-plan`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `planId` | string | yes | max 64 chars |

```text
get_plan({ planId: "<planId>" })
```

**Returns:** `plan` (object), `author` ({ id, name, kind } | null), `approver` ({ id, name, kind } | null), `changes` (object[]), `url` (string), `nextSteps` (object[]).

## `list_plans`

A repo's plans, newest first, each with its status and page (url). Filter by status (draft, approved, superseded, rejected) or to the plans you drafted (mine: true).

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts list-plans`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |
| `status` | "draft" \| "approved" \| "superseded" \| "rejected" |  | Only plans with this status. |
| `mine` | boolean |  | Only plans you drafted. |

```text
list_plans({ repoId: "<repoId>" })
```

**Returns:** `plans` (object[]).

## `withdraw_plan`

Withdraw a draft plan you drafted yourself (it ends as rejected, withdrawn by its author; the reason is audited). Only the author, and only a draft: approving or rejecting anyone's plan stays with people.

**Scope:** `plan:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts withdraw-plan`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `planId` | string | yes | max 64 chars |
| `reason` | string |  | Why (recorded in the plan's audit log). max 2000 chars |

```text
withdraw_plan({ planId: "<planId>" })
```

**Returns:** `plan` (object), `nextSteps` (object[]).

## `start_change`

Fork the repo for one change and get a short-lived push token for that fork only. Push commits there; CI, evidence and the lane follow automatically. overlaps lists the open changes already on the same plan or touching the paths you name (paths) or your plan's scopePaths: coordinate with them or wait.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts start-change`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |
| `planId` | string |  | The approved plan this change implements. max 64 chars |
| `title` | string | yes | max 200 chars |
| `category` | "fix" \| "feature" \| "refactor" \| "dependency" \| "transform" \| "revert" \| "docs" \| "chore" | yes | Your claim; it can only raise risk, never lower it. |
| `summary` | string |  | max 10000 chars |
| `agentTraceId` | string |  | max 200 chars |
| `paths` | string[] |  | Optional. Paths or globs you expect to touch (files like src/money.ts, or globs). The result's overlaps lists open changes already touching them; never stored, never a lane input. max 50 items |

```text
start_change({ repoId: "<repoId>", title: "<what>", category: "fix" })
```

**Returns:** `change` (object), `remote` (object), `url` (string), `overlaps` (null | object), `nextSteps` (object[]).

## `list_changes`

A repo's changes, most recently updated first (up to 200): status, lane, plan, who started it and its page (url). Filter by status (e.g. awaiting-review) or to the changes you started (mine: true). get_change_status has one change's details.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts list-changes`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | The repo. max 64 chars |
| `status` | "awaiting-push" \| "running" \| "failing" \| "awaiting-review" \| "approved" \| "queued" \| "merged" \| "rolling-out" \| "released" \| "reverted" \| "rejected" \| "abandoned" |  | Only changes with this status. |
| `mine` | boolean |  | Only changes you started. |

```text
list_changes({ repoId: "<repoId>" })
```

**Returns:** `changes` (object[]).

## `refresh_push_token`

A fresh short-lived push token for your change's fork (author only). Use it when the old token expired.

**Scope:** `change:create` · **Kind:** mutating · **CLI:** `gittifacts refresh-push-token`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |

```text
refresh_push_token({ changeId: "<changeId>" })
```

**Returns:** `remote` (object).

## `wait_for_change`

Long-poll until the change's current head reaches a milestone, can no longer reach it, or the timeout passes. Prefer this to polling. reached=true means the milestone holds now: evidence_ready = CI finished (passed or failed) and its signed evidence is sealed (a first Change: also released when green, failing when not); lane_assigned = the lane is set (status stays running while the walkthrough is written); tour_ready = the walkthrough is written and the change is routed (awaiting-review, or queued); merged = on the default branch; reverted = reverted. A human can send it back first: reason changes-requested (push a new head), rejected (it ended) or approval-withdrawn (it needs a fresh review); read get_change_status for the review. On timeout call again, after retryAfterSec when it is set.

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

**Returns:** `reached` (boolean), `reason` ("reached" | "timeout" | "unreachable" | "changes-requested" | "rejected" | "approval-withdrawn"), `retryAfterSec` (integer), `change` (object), `nextSteps` (object[]).

## `get_change_status`

A change's status, lane (and why), pipeline runs for each head, the human reviews (decision, comment, reviewer, head; a withdrawn approval says why), the open changes on the same plan or paths (overlaps), its page (url) to hand a person, and what to do next.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts get-change-status`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |

```text
get_change_status({})
```

**Returns:** `change` (object), `url` (string), `reviews` (object[]), `runs` (object[]), `classification` (null | object), `previewUrl` (string | null), `overlaps` (null | object), `nextSteps` (object[]).

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

The walkthrough (the tour) a second reviewer agent wrote for the change, what a human will read: stops with verdicts, least-confident points and what was not done.

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

Ask a human to look at your change (notifies them; url is its page, to share). This never approves anything: agents cannot approve plans or changes.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts request-review`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `message` | string |  | max 2000 chars |

```text
request_review({ changeId: "<changeId>" })
```

**Returns:** `changeId` (string), `status` ("awaiting-push" | "running" | "failing" | "awaiting-review" | "approved" | "queued" | "merged" | "rolling-out" | "released" | "reverted" | "rejected" | "abandoned"), `notified` (boolean), `url` (string), `nextSteps` (object[]).

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
