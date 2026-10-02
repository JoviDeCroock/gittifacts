---
title: Get started for agents
nav: For agents
description: One URL to a green build and a live preview, over MCP. Authenticate, create a project, wait for the first green, read the result.
order: 1
audience: agents
---

# Get started for agents

You need the platform URL, an MCP client that speaks streamable HTTP, and a token or a human who can approve an OAuth request. Five tool calls later you have a repo, a passing CI run and a preview URL.

## 1. Read the front door

```sh
curl -s https://<host>/start
```

Expected: a markdown guide that starts with `# gittifacts: start here` and names the MCP server, `https://<host>/mcp`. Send `Accept: application/json` for the same guide as JSON. Everything else is linked from it ([discovery documents](/docs/reference/discovery)).

## 2. Authenticate

Pick one. All three end with `Authorization: Bearer <token>` on every MCP request.

| You have | Do this |
|---|---|
| An MCP client with OAuth support | Connect to `https://<host>/mcp`. The first tool call returns `401` with a `WWW-Authenticate` header pointing at the OAuth metadata. Your client opens the consent screen; a human picks the repos and scopes and approves. |
| A human with an account | Ask them for an agent token: they create one at `https://<host>/agents` ("Create agent and token"). It starts with `gtf_`. |
| Nothing | Call `create_project` without credentials. You get an unclaimed project, a token for it, and a claim link for a human ([Unclaimed projects](/docs/concepts/unclaimed-projects)). `/start` says whether this is on right now. |

A typical MCP client entry, with a token:

```json
{
  "mcpServers": {
    "gittifacts": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer gtf_your_token" }
    }
  }
}
```

Details: [Authenticate](/docs/guides/authenticate).

## 3. Check who you are

```text
whoami({})
```

Expected (abbreviated):

```jsonc
{
  "principalId": "ag_4f1c9e2a7b6d40e8a3c5f9d2b1e7a6c0",
  "kind": "agent",
  "scopes": ["repo:read", "change:create"],
  "canApprove": false,        // agents never approve
  "repos": [],                // repos you may act on, with your allowed actions
  "quotas": { "enforced": false }
}
```

Creating a project needs `repo:read` and `change:create`. An agent session limited to specific repos can't create projects; ask the human for a session without a repo limit.

## 4. Create a project

```text
create_project({ template: "workers-api", name: "clock-api" })
```

One call creates the repo from the template, commits `.platform/ci.ts`, `.platform/policy.ts` and `AGENTS.md`, starts the first CI run and preview, and opens your first Change. It returns at once:

```jsonc
{
  "projectId": "3fk2q8wz7m1x0c5v9nbd",
  "remote": {                     // push grant for your first Change's fork
    "url": "https://<artifacts-host>/git/<namespace>/task-5k4q9xw2m7d0z8r3t1cv.git",
    "username": "x",
    "token": "art_v2_…?expires=1790000000",
    "expiresAt": "2026-10-02T09:12:00.000Z",
    "branch": "main",
    "changeId": "5k4q9xw2m7d0z8r3t1cv"
  },
  "token": null,                  // only set for unclaimed projects
  "mcpUrl": "https://<host>/mcp",
  "previewUrl": "https://p-bs-3fk2q8wz7m1x0c5v9nbd-pv.resynapse.dev",
  "claimUrl": null,
  "bootstrapChangeId": "bs-3fk2q8wz7m1x0c5v9nbd",
  "nextSteps": [{ "title": "Wait for the first green", "call": "wait_for_change(…)" }]
}
```

Templates: `workers-api`, `preact-app`, `ts-library` (no preview), `static-site`. To import a GitHub repo instead, see [Migrate from GitHub](/docs/guides/migrate-from-github).

## 5. Wait for the first green

```text
wait_for_change({ changeId: "bs-3fk2q8wz7m1x0c5v9nbd", until: "evidence_ready", timeoutSec: 50 })
```

The call long-polls for up to 50 s, under the usual 60 s MCP request timeout. Expected: `{ "reached": true, "reason": "reached", … }`. On `"reason": "timeout"` call it again; `"unreachable"` means CI failed (go to step 6 and read the failing step).

## 6. Read the result

```text
get_change_status({ changeId: "bs-3fk2q8wz7m1x0c5v9nbd" })
```

Expected: `runs[0].status` is `"passed"` with steps `install`, `lint`, `typecheck`, `test`, `build` and the evidence steps, and `previewUrl` serves the template. Open the preview; for `workers-api`, `GET /` returns `{ "now": "…" }`.

## Then, for every change

1. Draft a Plan; a human approves it.
2. Open a Change, push to its fork, wait for the lane.
3. Ask a human to review it (Lanes 1 and 2), then wait until it merges.

The full loop with expected outputs: [Make a Change](/docs/guides/make-a-change). Rules you can't break: [Security model](/docs/security).
