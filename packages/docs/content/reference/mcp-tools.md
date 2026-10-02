---
title: "MCP tools"
description: "All 28 tools of the gittifacts MCP server: what each does, the scope it needs, and where its arguments are documented."
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
New project: create_project({ template }) → wait_for_change on bootstrapChangeId (first CI + preview) → push to remote (your first Change's fork).
Flow: whoami → create_plan (a human approves it) → start_change → push to the fork → wait_for_change → get_change_status / get_evidence / get_tour.
You can never approve a plan or a change; use request_review to ask a human.
Errors are JSON `{ error: { code, message, fix } }`; `fix.call` is the tool call that resolves it.
Mutating tools accept `idempotencyKey`: retry with the same key safely.
```

| Tool | What it does | Scope | Kind |
| --- | --- | --- | --- |
| [`create_project`](/docs/reference/mcp-projects#create_project) | One call: a repo from a template (or an import, or empty) with .platform/ci.ts, .platform/policy.ts and AGENTS.md committed, the first CI run and preview started, and a push grant for your first Change's fork; it returns at once (wait_for_change on bootstrapChangeId for the first green). | `repo:read` `change:create` | write |
| [`whoami`](/docs/reference/mcp-projects#whoami) | Your principal, scopes, the repos you can act on (with claim status and allowed actions) and quotas. |  | read |
| [`list_repos`](/docs/reference/mcp-projects#list_repos) | Repos you can read, with open changes per lane and whether Lane 0 (auto-merge) is on. | `repo:read` | read |
| [`list_members`](/docs/reference/mcp-projects#list_members) | A repo's human members and their roles (reader < reviewer < maintainer < owner), and your role (an agent acts with its owner's role: reviewer or above to draft plans and start changes). | `repo:read` | read |
| [`create_plan`](/docs/reference/mcp-changes#create_plan) | Draft a plan: intent, acceptance criteria and the paths you expect to touch. | `plan:create` | write |
| [`start_change`](/docs/reference/mcp-changes#start_change) | Fork the repo for one change and get a short-lived push grant for that fork only. | `change:create` | write |
| [`get_change_status`](/docs/reference/mcp-changes#get_change_status) | A change's status, lane (and why), pipeline runs for each head, and what to do next. | `repo:read` | read |
| [`get_evidence`](/docs/reference/mcp-changes#get_evidence) | The signed evidence for the change's current head (tests, red/green proof, coverage, API diff, ...) and whether the signature verifies. | `repo:read` | read |
| [`get_tour`](/docs/reference/mcp-changes#get_tour) | The reviewer agent's guided tour of the change (what a human will read): stops with verdicts, least-confident points and what was not done. | `repo:read` | read |
| [`request_review`](/docs/reference/mcp-changes#request_review) | Ask a human to look at your change (notifies them). | `change:create` | write |
| [`list_issues_for_change`](/docs/reference/mcp-changes#list_issues_for_change) | Workers Issues attributed to the change or the version it rolled out (errors seen in production). | `repo:read` | read |
| [`refresh_push_token`](/docs/reference/mcp-changes#refresh_push_token) | A fresh short-lived push grant for your change's fork (author only). | `change:create` | write |
| [`wait_for_change`](/docs/reference/mcp-changes#wait_for_change) | Long-poll until the change reaches a milestone (evidence_ready, lane_assigned, tour_ready, merged, reverted), can no longer reach it, or the timeout passes. | `repo:read` | read |
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
