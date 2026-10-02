---
title: "MCP tools: projects and discovery"
nav: "MCP: projects"
description: "create_project, whoami, list_repos, list_members, propose_platform_config and search_tools: arguments, scopes, examples and outputs."
order: 11
audience: agents
generated: true
---

# MCP tools: projects and discovery

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## `create_project`

One call: a repo from a template (or an import, or empty) with .platform/ci.ts, .platform/policy.ts and AGENTS.md committed, the first CI run and preview started, and a push grant for your first Change's fork. Returns at once; wait_for_change on bootstrapChangeId for the first green.

**Scope:** `repo:read` + `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts create-project`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string |  | Project (and repo) name, normalized to lowercase letters, digits and dashes. Default: <template>-<random>. max 63 chars |
| `template` | "workers-api" \| "preact-app" \| "ts-library" \| "static-site" |  | Start from a template that passes CI and serves a preview at once. Omit both template and from for an empty project. |
| `from` | string |  | Import a public https git repository (e.g. GitHub) instead of a template. max 500 chars |
| `description` | string |  | One line about the project. max 500 chars |

```text
create_project({ template: "workers-api" })
```

**Returns:** `projectId` (string), `name` (string), `template` (string | null), `defaultBranch` (string), `remote` (null | object), `token` (string | null), `mcpUrl` (string), `previewUrl` (string | null), `claimUrl` (string | null), `bootstrapChangeId` (string | null), `nextSteps` (object[]).

## `whoami`

Your principal, scopes, the repos you can act on (with claim status and allowed actions) and quotas. Call this first.

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts whoami`

No arguments.

```text
whoami({})
```

**Returns:** `principalId` (string), `kind` ("human" | "agent" | "system"), `name` (string), `ownerId` (string | null), `scopes` (string[]), `canApprove` (boolean), `repos` (object[]), `quotas` ({ enforced, ciMinutesPerDay, ciMinutesUsedToday, artifactsOpsPerDay }).

## `list_repos`

Repos you can read, with open changes per lane and whether Lane 0 (auto-merge) is on.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts list-repos`

No arguments.

```text
list_repos({})
```

**Returns:** `repos` (object[]).

## `list_members`

A repo's human members and their roles (reader < reviewer < maintainer < owner), and your role (an agent acts with its owner's role: reviewer or above to draft plans and start changes). Ask an owner listed here for access.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts list-members`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |

```text
list_members({ repoId: "<repoId>" })
```

**Returns:** `repoId` (string), `members` (object[]), `yourRole` ("owner" | "maintainer" | "reviewer" | "reader" | null).

## `propose_platform_config`

Detects how an imported repo installs, tests and builds (in a sandbox) and proposes .platform/ci.ts, .platform/policy.ts and AGENTS.md as a draft Plan plus a Change a human approves (never applied silently). Uncertain guesses are listed as risks. Idempotent per default-branch commit; waits up to waitSec.

**Scope:** `plan:create` + `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts propose-platform-config`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |
| `rerun` | boolean |  | Detect again even if a proposal exists for the current default-branch commit (e.g. after a human rejected it). |
| `waitSec` | integer |  | How long to wait for the proposal to finish (default 45). 0–50 |

```text
propose_platform_config({ repoId: "<repoId>" })
```

**Returns:** `proposalId` (string), `repoId` (string), `status` ("running" | "proposed" | "not-needed" | "failed"), `baseSha` (string | null), `planId` (string | null), `changeId` (string | null), `detection` (object | null), `error` (string | null), `startedAt` (string), `nextSteps` (object[]).

## `search_tools`

Fuzzy search over every gittifacts tool's name and description. Returns matching tool names, a one-line description and an example call.

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts search-tools`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | What you want to do, e.g. "merge my change" or "workspace exec". max 200 chars |

```text
search_tools({ query: "merge my change" })
```

**Returns:** `tools` (object[]).
