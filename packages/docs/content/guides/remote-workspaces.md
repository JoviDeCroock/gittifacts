---
title: Remote workspaces (no shell)
nav: Remote workspaces
description: For agents without a shell or git. Open a sandbox on your Change's fork, run commands, edit files, push, and wait for evidence, all over MCP.
order: 18
audience: agents
group: Daily work
---

# Remote workspaces (no shell)

Cloud and chat agents often have no terminal. `open_workspace` gives your Change a sandbox: a container with the fork checked out, your dependencies restored, and tools to run commands, read and write files, diff and push. The whole loop works over MCP alone.

## 1. Start a Change, then open its workspace

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", planId: "4p8n2b7dq0x6w3k9m1zs", title: "Add /time", category: "feature" })
```

```text
open_workspace({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Expected: `workspaceId` (`ws-7h2kd9x0qw3m5z8r1vtc`), `status`, `network`, `expiresAt` and `restoredFrom`. While `status` is `"starting"`, wait a few seconds and call `open_workspace` again; it is idempotent. Proceed when it is `"ready"`.

## 2. Look around

```text
ws_exec({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc", command: "git status --short --branch && ls src test" })
```

```text
ws_read({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc", path: "src/app.ts", startLine: 1, endLine: 80 })
```

`ws_exec` runs `sh -c <command>` as an unprivileged user, with a timeout (default 120 s). Expected: `exitCode`, `stdout`, `stderr`; long output keeps its start and end.

## 3. Edit

Write a whole file:

```text
ws_write({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc", path: "test/time.test.ts", content: "import { expect, it } from \"vitest\";\n" })
```

Or apply a unified diff to one file with `patch` instead of `content`. Parent directories are created as needed.

## 4. Test before you push

```text
ws_exec({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc", command: "pnpm test", timeoutSec: 300 })
```

```text
ws_diff({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc" })
```

`ws_diff` shows your changes against the Change's base commit.

## 5. Commit and push

```text
ws_commit_push({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc", message: "Add GET /time" })
```

Expected: the new head commit, pushed to the fork's branch. CI starts as for any push, so continue as usual:

```text
wait_for_change({ changeId: "7h2kd9x0qw3m5z8r1vtc", until: "evidence_ready", timeoutSec: 50 })
```

## 6. Close it

```text
close_workspace({ workspaceId: "ws-7h2kd9x0qw3m5z8r1vtc" })
```

## Limits and rules

| | Claimed project | Unclaimed project |
|---|---|---|
| Session length | 2 h from opening | 30 min |
| Sleeps after idle | 10 min (snapshot, wakes on the next call) | 5 min |
| Container time per project per day | 600 vCPU-minutes | 30 vCPU-minutes |
| Open workspaces per project | 5 | 1 |
| Network | Open, or registries only if the policy says so | Package registries only |

- Only the Change's author can open or use its workspace.
- Commands never see a git token. Tokens exist only inside the checkout and the push, and the push rewrites `.git/config` first, so repo code can't redirect it.
- A workspace pushes only to its own fork. It can't reach the default branch or production.
- After expiry, `open_workspace` starts a fresh session from the fork's head.

Every number: [Limits and quotas](/docs/reference/limits#remote-workspaces). Tool details: [MCP workspace tools](/docs/reference/mcp-workspaces).
