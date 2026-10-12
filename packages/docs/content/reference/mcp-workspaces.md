---
title: "MCP tools: remote workspaces"
nav: "MCP: workspaces"
description: "open_workspace and the ws_* tools for agents without a shell: arguments, scopes, examples and outputs."
order: 14
audience: agents
generated: true
---

# MCP tools: remote workspaces

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## `open_workspace`

A sandbox with your Change's fork checked out at its head, for agents without a local shell or git. Starts or resumes it (idempotent per Change; author only) and returns the ws_* tools to use. It sleeps when idle and ends at expiresAt.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts open-workspace`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |

```text
open_workspace({ changeId: "<changeId>" })
```

**Returns:** `workspaceId` (string), `changeId` (string), `repoId` (string), `forkName` (string), `branch` (string), `baseSha` (string), `headSha` (string | null), `status` ("starting" | "ready" | "sleeping" | "closed" | "expired"), `network` ("open" | "registries-only"), `expiresAt` (string), `idleSleepSec` (integer), `restoredFrom` ("sleep-snapshot" | "dependency-snapshot" | "image" | null), `usage` ({ containerSeconds, projectSecondsRemaining }), `tools` (object[]), `nextSteps` (object[]).

## `ws_exec`

Runs `sh -c <command>` in the workspace checkout as the unprivileged runner user, with a hard timeout. Returns the exit code and stdout/stderr (each capped; the middle of long output is dropped).

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts ws-exec`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspaceId` | string | yes | From open_workspace. max 100 chars |
| `command` | string | yes | A shell command (sh -c), run as the unprivileged runner user. max 16384 chars |
| `cwd` | string |  | Working directory relative to the repository root. max 1024 chars |
| `timeoutSec` | integer |  | Default 120. Capped by the repo's quota; keep it under your client's request timeout and background long jobs (nohup … &). 1–1800 |

```text
ws_exec({ workspaceId: "<workspaceId>", command: "pnpm test" })
```

**Returns:** `exitCode` (integer | null), `timedOut` (boolean), `durationMs` (integer), `stdout` (string), `stderr` (string), `stdoutBytes` (integer), `stderrBytes` (integer), `stdoutTruncated` (boolean), `stderrTruncated` (boolean), `nextSteps` (object[]).

## `ws_read`

Reads a file from the workspace checkout, optionally a 1-based inclusive line range. Large files are truncated (truncated: true); binary files come back empty with binary: true.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts ws-read`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspaceId` | string | yes | From open_workspace. max 100 chars |
| `path` | string | yes | Relative to the repository root (/workspace). Paths outside it are rejected. max 1024 chars |
| `startLine` | integer |  | 1-based, inclusive. ≥ 1 |
| `endLine` | integer |  | 1-based, inclusive. ≥ 1 |

```text
ws_read({ workspaceId: "<workspaceId>", path: "<path>" })
```

**Returns:** `path` (string), `content` (string), `binary` (boolean), `sizeBytes` (integer), `totalLines` (integer), `startLine` (integer), `endLine` (integer), `truncated` (boolean).

## `ws_write`

Writes a whole file (`content`, creating parent directories) or applies a unified diff to it (`patch`). Paths outside the repository are rejected. Nothing is committed until ws_commit_push.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts ws-write`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspaceId` | string | yes | From open_workspace. max 100 chars |
| `path` | string | yes | The file to write (or the one file the patch changes). max 1024 chars |
| `content` | string |  | The whole new file content (creates parent directories). Pass this or patch. max 1048576 chars |
| `patch` | string |  | A unified diff (git apply) that changes only `path`. Pass this or content. max 1048576 chars |

```text
ws_write({ workspaceId: "<workspaceId>", path: "<path>" })
```

**Returns:** `path` (string), `mode` ("content" | "patch"), `bytes` (integer), `created` (boolean), `nextSteps` (object[]).

## `ws_diff`

Every change in the workspace (committed or not, new files included) against the Change's base commit: per-file stats and a unified diff (capped).

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts ws-diff`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspaceId` | string | yes | From open_workspace. max 100 chars |

```text
ws_diff({ workspaceId: "<workspaceId>" })
```

**Returns:** `baseSha` (string), `files` (object[]), `patch` (string), `truncated` (boolean), `nextSteps` (object[]).

## `ws_commit_push`

Commits every change in the workspace (as you) and pushes it to the Change's fork branch. That push starts CI, evidence, the lane and the walkthrough, exactly like a git push.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts ws-commit-push`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspaceId` | string | yes | From open_workspace. max 100 chars |
| `message` | string | yes | max 10000 chars |

```text
ws_commit_push({ workspaceId: "<workspaceId>", message: "<message>" })
```

**Returns:** `changeId` (string), `branch` (string), `commitSha` (string), `previousHead` (string | null), `filesChanged` (integer), `pushed` (boolean), `nextSteps` (object[]).

## `close_workspace`

Stops the workspace and deletes its sleep snapshot. Uncommitted changes are lost; the fork keeps everything you pushed. open_workspace starts a fresh one.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts close-workspace`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `workspaceId` | string | yes | From open_workspace. max 100 chars |

```text
close_workspace({ workspaceId: "<workspaceId>" })
```

**Returns:** `workspaceId` (string), `changeId` (string), `repoId` (string), `forkName` (string), `branch` (string), `baseSha` (string), `headSha` (string | null), `status` ("starting" | "ready" | "sleeping" | "closed" | "expired"), `network` ("open" | "registries-only"), `expiresAt` (string), `idleSleepSec` (integer), `restoredFrom` ("sleep-snapshot" | "dependency-snapshot" | "image" | null), `usage` ({ containerSeconds, projectSecondsRemaining }), `nextSteps` (object[]).
