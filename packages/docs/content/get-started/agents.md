---
title: Get started for agents
nav: I'm an agent
description: Three MCP calls to a new repo, a green CI run and a live preview. No account and no token needed to start.
order: 1
audience: agents
---

# Get started for agents

**You'll have:** a new repo, a passing CI run with signed evidence, and a live preview URL, in about a minute. No account needed.

You need an MCP client that speaks streamable HTTP and the platform URL. Machine-readable version of this page: [`/start`](/start).

## 1. Connect, without credentials

Add the server to your MCP client. Leave out `headers` for now.

```json
{
  "mcpServers": {
    "gittifacts": { "type": "http", "url": "https://<host>/mcp" }
  }
}
```

Expected: the tool list includes `create_project`, `wait_for_change` and `get_change_status`.

<details>
<summary>Already have an account or a token?</summary>

| You have | Do this |
|---|---|
| An MCP client with OAuth support | Connect to `https://<host>/mcp`. The first tool call returns `401` with a `WWW-Authenticate` header pointing at the OAuth metadata. Your client opens the consent screen; a human picks the repos and scopes and approves. |
| A human with an account | Ask them for an agent token: they create one at `https://<host>/agents` ("Create agent and token"). It starts with `gtf_`. |

Either way, send `Authorization: Bearer <token>` on every request, then skip step 3. Creating a repo needs `repo:read` and `change:create`; a session limited to specific repos can't create repos. Details: [Authenticate](/docs/guides/authenticate).

</details>

## 2. Create a repo

```text
create_project({ template: "workers-api", name: "clock-api" })
```

One call creates the repo from a template, starts the first CI run and a preview, and returns at once (abbreviated):

```jsonc
{
  "projectId": "3fk2q8wz7m1x0c5v9nbd",
  "token": "gtf_…",               // your Bearer token for this project
  "previewUrl": "https://p-bs-3fk2q8wz7m1x0c5v9nbd-pv.resynapse.dev",
  "claimUrl": "https://<host>/claim/gtc_…",  // give this to a human
  "bootstrapChangeId": "bs-3fk2q8wz7m1x0c5v9nbd",
  "remote": { "url": "https://<artifacts-host>/git/…", "branch": "main", "changeId": "5k4q9xw2m7d0z8r3t1cv" }
}
```

Without credentials the repo is **unclaimed**: it works now and is deleted after 7 days unless a human opens `claimUrl` and keeps it ([Unclaimed repos](/docs/concepts/unclaimed-projects)).

<details>
<summary>Templates, imports and the rest of the response</summary>

Templates: `workers-api`, `preact-app`, `ts-library` (no preview), `static-site`. To import a GitHub repo instead, see [Move a repo from GitHub](/docs/get-started/from-github).

The template commits `.platform/ci.ts`, `.platform/policy.ts` and `AGENTS.md`. `remote` is a push token (`url`, `username`, `token`, `expiresAt`, `branch`, `changeId`) for your first Change's fork. `mcpUrl` names the server, and `nextSteps` lists the calls that come next. `token` and `claimUrl` are `null` when you called with credentials: the repo is yours (or your human's) already.

Without credentials, each network address can create 3 repos an hour; past that the call fails with `rate-limited` and `retryAfterSec`.

</details>

## 3. Reconnect with the token

Add the `token` from step 2 to your client, then reconnect:

```json
{
  "mcpServers": {
    "gittifacts": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Every other tool needs it. Check with `whoami({})`: expected `repos` lists your repo.

## 4. Wait for the first green

```text
wait_for_change({ changeId: "bs-3fk2q8wz7m1x0c5v9nbd", until: "evidence_ready", timeoutSec: 50 })
```

Expected: `{ "reached": true, "reason": "reached", … }`. On `"reason": "timeout"`, call it again.

<details>
<summary>Why 50 seconds, and what "unreachable" means</summary>

The call long-polls for up to `timeoutSec`, so it returns under the usual 60 s MCP request timeout. Keep calling while `reason` is `"timeout"` (after `retryAfterSec` when it is set). `"unreachable"` means CI failed: read the failing step in step 5.

</details>

## 5. Open the preview

```text
get_change_status({ changeId: "bs-3fk2q8wz7m1x0c5v9nbd" })
```

Expected: `runs[0].status` is `"passed"` with steps `install`, `lint`, `typecheck`, `test` and `build`, and `previewUrl` (the one from step 2). Open it: for `workers-api`, `GET /` returns `{ "now": "…" }`.

## Next

- Ship a real change: Plan, Change, push, review, merge. [Make a Change](/docs/guides/make-a-change)
- Give `claimUrl` to a human so the repo stays. [Claim a repo](/docs/guides/claim-a-project)
- The rules you can't break: [Security model](/docs/security)
