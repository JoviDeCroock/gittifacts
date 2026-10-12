---
title: "MCP tools: code and history"
nav: "MCP: code and history"
description: "list_repo_files, read_repo_file, list_commits, get_commit and get_commit_activity: a repo's code and history at a ref, read-only. Arguments, scopes, examples and outputs."
order: 13
audience: agents
generated: true
---

# MCP tools: code and history

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## `list_repo_files`

A directory of a repo at a ref (default: its default branch, i.e. what has landed): entries, directories first, and the directory's README. Walk deeper with path; read a file with read_repo_file.

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts list-repo-files`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | The repo (list_repos). max 64 chars |
| `path` | string |  | Repo-relative path, e.g. "src/lib" ("" or absent: the root). max 1024 chars |
| `ref` | string |  | Branch, tag or commit sha. Default: the repo's default branch (what has landed). max 255 chars |

```text
list_repo_files({ repoId: "<repoId>" })
```

**Returns:** `ref` (string), `commitSha` (string), `path` (string), `entries` (object[]), `readme` ({ path, text } | null), `url` (string).

## `read_repo_file`

One file of a repo at a ref (default: its default branch): its text up to 512 KiB, or kind binary / too-large without content.

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts read-repo-file`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | The repo (list_repos). max 64 chars |
| `path` | string | yes | The file, e.g. "src/index.ts". max 1024 chars |
| `ref` | string |  | Branch, tag or commit sha. Default: the repo's default branch (what has landed). max 255 chars |

```text
read_repo_file({ repoId: "<repoId>", path: "<path>" })
```

**Returns:** `ref` (string), `commitSha` (string), `path` (string), `size` (integer), `kind` ("text" | "binary" | "too-large"), `text` (string | null), `url` (string).

## `list_commits`

A repo's history from a ref (default: its default branch), newest first, a page at a time: each commit's title, author, time, and the Change that landed it (landedBy).

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts list-commits`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | The repo (list_repos). max 64 chars |
| `ref` | string |  | Branch, tag or commit sha. Default: the repo's default branch (what has landed). max 255 chars |
| `limit` | integer |  | Page size (default 30). 1–100 |
| `offset` | integer |  | nextOffset from the previous page. ≥ 0 |

```text
list_commits({ repoId: "<repoId>" })
```

**Returns:** `ref` (string), `headSha` (string | null), `commits` (object[]), `nextOffset` (integer | null).

## `get_commit`

One commit: message, author, the Change that landed it, and its patch against the first parent (per file, within a 200k-character budget).

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts get-commit`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | The repo (list_repos). max 64 chars |
| `sha` | string | yes | Full commit sha (list_commits). |

```text
get_commit({ repoId: "<repoId>", sha: "<sha>" })
```

**Returns:** `commit` (object), `parentSha` (string | null), `additions` (integer), `deletions` (integer), `complete` (boolean), `files` (object[]).

## `get_commit_activity`

How active a repo is: commits per UTC day (by when they landed) over whole weeks, the total, and the top authors.

**Scope:** none · **Kind:** read-only · **CLI:** `gittifacts get-commit-activity`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | The repo (list_repos). max 64 chars |
| `ref` | string |  | Branch, tag or commit sha. Default: the repo's default branch (what has landed). max 255 chars |
| `weeks` | integer |  | Whole weeks back (default 26). 1–52 |

```text
get_commit_activity({ repoId: "<repoId>" })
```

**Returns:** `ref` (string), `headSha` (string | null), `from` (string), `to` (string), `total` (integer), `days` (object[]), `authors` (object[]), `truncated` (boolean), `url` (string).
