---
title: "MCP tools"
description: "All 36 tools of the gittifacts MCP server: what each does, the scope it needs, and where its arguments are documented."
order: 10
audience: agents
generated: true
---

# MCP tools

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts`, `packages/mcp/src/server.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

Server `gittifacts` 1.0.0 at `https://<host>/mcp` (streamable HTTP, stateless). Send `Authorization: Bearer <token>` on every request; see [Authenticate](/docs/guides/authenticate). Errors come back as a tool error whose text is `{ "error": { "code", "message", "fix" } }` ([error codes](/docs/reference/errors)).

The server's own instructions, sent on `initialize`:

```text verbatim
gittifacts is a git platform for agents. Humans approve intent; machines prove conformance.
New repo: create_project({ template }) → wait_for_change on bootstrapChangeId (first CI + preview) → push to remote (your first Change's fork).
Flow: whoami → create_plan (a human approves it) → start_change → push to the fork → wait_for_change → get_change_status / get_evidence / get_tour.
You can never approve a plan or a change; use request_review to ask a human.
Errors are JSON `{ error: { code, message, fix } }`; `fix.call` is the tool call that resolves it.
Mutating tools accept `idempotencyKey`: retry with the same key safely.
```

| Tool | What it does | Scope | Kind |
| --- | --- | --- | --- |
| [`create_project`](/docs/reference/mcp-projects#create_project) | One call: a repo from a template (or an import, or empty) with .platform/ci.ts, .platform/policy.ts and AGENTS.md committed, the first CI run and preview started, and a push token for your first Change's fork; it returns at once (wait_for_change on bootstrapChangeId for the first green). | `repo:read` `change:create` | write |
| [`whoami`](/docs/reference/mcp-projects#whoami) | Who you are (your actor: principalId, kind, owner), scopes, the repos you can act on (with claim status and allowed actions) and quotas. |  | read |
| [`list_repos`](/docs/reference/mcp-projects#list_repos) | Repos you can read, with open changes per lane and whether auto-merge (Lane 0) is on or still calibrating. | `repo:read` | read |
| [`list_members`](/docs/reference/mcp-projects#list_members) | A repo's human members and their roles (reader < reviewer < maintainer < owner), and your role (an agent acts with its owner's role: reviewer or above to draft plans and start changes). | `repo:read` | read |
| [`create_plan`](/docs/reference/mcp-changes#create_plan) | Draft a plan: intent, acceptance criteria and the paths you expect to touch. | `plan:create` | write |
| [`get_plan`](/docs/reference/mcp-changes#get_plan) | A plan: its intent, acceptance criteria and scope, its status (draft until a person approves it; agents never can), who drafted and approved it, the changes started from it, its page (url) to hand a person, and what to do next. | `repo:read` | read |
| [`list_plans`](/docs/reference/mcp-changes#list_plans) | A repo's plans, newest first, each with its status and page (url). | `repo:read` | read |
| [`withdraw_plan`](/docs/reference/mcp-changes#withdraw_plan) | Withdraw a draft plan you drafted yourself (it ends as rejected, withdrawn by its author; the reason is audited). | `plan:create` | write |
| [`start_change`](/docs/reference/mcp-changes#start_change) | Fork the repo for one change and get a short-lived push token for that fork only. | `change:create` | write |
| [`list_changes`](/docs/reference/mcp-changes#list_changes) | A repo's changes, most recently updated first (up to 200): status, lane, plan, who started it and its page (url). | `repo:read` | read |
| [`get_change_status`](/docs/reference/mcp-changes#get_change_status) | A change's status, lane (and why), pipeline runs for each head, the human reviews (decision, comment, reviewer, head; a withdrawn approval says why), its page (url) to hand a person, and what to do next. | `repo:read` | read |
| [`get_evidence`](/docs/reference/mcp-changes#get_evidence) | The signed evidence for the change's current head (tests, red/green proof, coverage, API diff, ...) and whether the signature verifies. | `repo:read` | read |
| [`get_tour`](/docs/reference/mcp-changes#get_tour) | The walkthrough (the tour) a second reviewer agent wrote for the change, what a human will read: stops with verdicts, least-confident points and what was not done. | `repo:read` | read |
| [`request_review`](/docs/reference/mcp-changes#request_review) | Ask a human to look at your change (notifies them; url is its page, to share). | `change:create` | write |
| [`rerun_ci`](#rerun_ci) | Repeats CI, evidence, the lane and the walkthrough on the change's current head, without a push (a flaky step). | `change:create` | write |
| [`close_change`](#close_change) | Close (abandon) a change that won't merge: stops its CI, takes it out of the merge queue and deletes its fork later. | `change:create` | write |
| [`list_issues_for_change`](/docs/reference/mcp-changes#list_issues_for_change) | Workers Issues attributed to the change or the version it rolled out (errors seen in production). | `repo:read` | read |
| [`refresh_push_token`](/docs/reference/mcp-changes#refresh_push_token) | A fresh short-lived push token for your change's fork (author only). | `change:create` | write |
| [`wait_for_change`](/docs/reference/mcp-changes#wait_for_change) | Long-poll until the change's current head reaches a milestone, can no longer reach it, or the timeout passes. | `repo:read` | read |
| [`open_workspace`](/docs/reference/mcp-workspaces#open_workspace) | A sandbox with your Change's fork checked out at its head, for agents without a local shell or git. | `change:create` | write |
| [`ws_exec`](/docs/reference/mcp-workspaces#ws_exec) | Runs `sh -c <command>` in the workspace checkout as the unprivileged runner user, with a hard timeout. | `change:create` | write |
| [`ws_read`](/docs/reference/mcp-workspaces#ws_read) | Reads a file from the workspace checkout, optionally a 1-based inclusive line range. | `repo:read` | read |
| [`ws_write`](/docs/reference/mcp-workspaces#ws_write) | Writes a whole file (`content`, creating parent directories) or applies a unified diff to it (`patch`). | `change:create` | write |
| [`ws_diff`](/docs/reference/mcp-workspaces#ws_diff) | Every change in the workspace (committed or not, new files included) against the Change's base commit: per-file stats and a unified diff (capped). | `repo:read` | read |
| [`ws_commit_push`](/docs/reference/mcp-workspaces#ws_commit_push) | Commits every change in the workspace (as you) and pushes it to the Change's fork branch. | `change:create` | write |
| [`close_workspace`](/docs/reference/mcp-workspaces#close_workspace) | Stops the workspace and deletes its sleep snapshot. | `change:create` | write |
| [`propose_platform_config`](/docs/reference/mcp-projects#propose_platform_config) | Detects how an imported repo installs, tests and builds (in a sandbox) and proposes .platform/ci.ts, .platform/policy.ts and AGENTS.md as a draft Plan plus a Change a human approves (never applied silently). | `plan:create` `change:create` | write |
| [`enqueue`](/docs/reference/mcp-merge-queue#enqueue) | Joins your Change to the merge queue with options (priority, dependsOn for stacks, plangroup + landTogether, landMode). | `change:create` | write |
| [`queue_status`](/docs/reference/mcp-merge-queue#queue_status) | State, track, batch, position, ETA, the Changes it waits on and why (e.g. | `repo:read` | read |
| [`wait_for_merge`](/docs/reference/mcp-merge-queue#wait_for_merge) | Long-polls until the Change merges, is ejected or dequeued, or the queue freezes (timeoutSec ≤ 55). | `repo:read` | read |
| [`dequeue`](/docs/reference/mcp-merge-queue#dequeue) | Removes your Change from the merge queue (stack dependents leave with it). | `change:create` | write |
| [`reprioritize`](/docs/reference/mcp-merge-queue#reprioritize) | Sets the priority class (normal, security, incident). | `change:create` | write |
| [`queue_overview`](/docs/reference/mcp-merge-queue#queue_overview) | Tracks (independent parallel queues) with their speculative batches, the landing pipeline, freeze state, throughput, p50/p95 time in queue, quarantined tests and every entry with its reason and ETA. | `repo:read` | read |
| [`search_tools`](/docs/reference/mcp-projects#search_tools) | Fuzzy search over every gittifacts tool's name and description. |  | read |
| [`request_qa`](#request_qa) | On request only: an agent drives the app built from the change's current head in a real browser against the Plan's acceptance criteria (no Plan: a smoke check), with a screenshot per step, a replay GIF and a pass / fail / couldn't-test verdict per criterion, signed into the evidence. |  | write |
| [`get_qa`](#get_qa) | The change's QA runs, newest first: status, verdict per criterion with the reason, the lane before and after, cost, and the screenshots' blob refs. |  | read |

## `rerun_ci`

Repeats CI, evidence, the lane and the walkthrough on the change's current head, without a push (a flaky step). Author, its owner or a maintainer; only while the change is running, failing or awaiting review.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts rerun-ci`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `reason` | string |  | Why (recorded in the change's audit log). max 2000 chars |

```text
rerun_ci({ changeId: "<changeId>" })
```

**Returns:** `change` (object), `headSha` (string), `nextSteps` (object[]).

## `close_change`

Close (abandon) a change that won't merge: stops its CI, takes it out of the merge queue and deletes its fork later. Author, its owner or a maintainer; the reason is audited. A merged change can't be closed.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts close-change`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `reason` | string |  | Why (recorded in the change's audit log). max 2000 chars |

```text
close_change({ changeId: "<changeId>" })
```

**Returns:** `change` (object), `nextSteps` (object[]).

## `request_qa`

On request only: an agent drives the app built from the change's current head in a real browser against the Plan's acceptance criteria (no Plan: a smoke check), with a screenshot per step, a replay GIF and a pass / fail / couldn't-test verdict per criterion, signed into the evidence. A failure raises the lane; nothing lowers it. Needs green CI on the head. Idempotent per head (force: run again); at most 6 runs an hour per repo.

**Scope:** none · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts request-qa`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |
| `force` | boolean |  | Run again although this head already has a finished run (counts against the repo's limit). |

```text
request_qa({})
```

**Returns:** `run` (object), `reused` (boolean), `nextSteps` (object[]).

## `get_qa`

The change's QA runs, newest first: status, verdict per criterion with the reason, the lane before and after, cost, and the screenshots' blob refs.

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts get-qa`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string |  | max 64 chars |
| `github` | string |  | GitHub mode: the pull request as owner/repo#123, instead of changeId (pass exactly one). |

```text
get_qa({})
```

**Returns:** `runs` (object[]), `nextSteps` (object[]).
