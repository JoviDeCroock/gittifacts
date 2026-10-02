---
title: Get started with the CLI
nav: With the CLI
description: Install the gittifacts CLI, log in with the device flow, create a project and ship a first Change from a terminal.
order: 3
audience: both
---

# Get started with the CLI

The CLI is a thin wrapper over the MCP tools: every tool is a command, output is one JSON document on stdout, and `--human` prints tables. It suits agents with a shell and humans alike.

## 1. Install

**Coming soon.** `npx gittifacts` once the package is published to npm. Until then, build it from a checkout of the gittifacts repository:

```sh
pnpm install
pnpm --filter gittifacts build
alias gittifacts="node $PWD/packages/cli/dist/cli.mjs"
gittifacts --version
```

Expected: `{"name":"gittifacts","version":"0.1.0"}`. The build is one dependency-free file, `packages/cli/dist/cli.mjs` (Node 22 or later).

## 2. Log in

```sh
gittifacts --host https://<host> login
```

The CLI prints a URL and a code (OAuth device flow). Open the URL signed in as yourself, check the code, pick repos and scopes, and approve. Expected: `{ "loggedIn": true, … }` and a token stored in `~/.config/gittifacts/credentials.json` (mode 0600). Later commands remember the host.

An agent without a browser runs it in two halves and hands the URL to a human:

```sh
gittifacts --host https://<host> login --no-wait
gittifacts login --device-code <deviceCode>
```

## 3. Create a project and clone it

```sh
gittifacts init --template workers-api --name my-api --clone
cd my-api
```

`init` calls `create_project`, writes `.gittifacts.json` (`{ host, projectId, remote }`, no secrets) and clones the repo. The token reaches git through its environment, never argv or `.git/config`. Expected output includes `projectId`, `bootstrapChangeId` and `previewUrl`.

## 4. Wait for the first green

```sh
gittifacts wait bs-3fk2q8wz7m1x0c5v9nbd --until evidence_ready
gittifacts get-change-status bs-3fk2q8wz7m1x0c5v9nbd --human
```

`wait` re-issues the long-poll until the milestone or `--timeout` (default 600 s). Exit code 0 means reached, 3 means it timed out or can no longer be reached.

## 5. Ship a change

```sh
gittifacts create-plan --repo-id 3fk2q8wz7m1x0c5v9nbd --title "Add /time" \
  --intent "Clients need the server time in ISO 8601." \
  --acceptance-criteria "GET /time returns an ISO 8601 timestamp"
# a human approves the plan, then:
gittifacts start-change --repo-id 3fk2q8wz7m1x0c5v9nbd --plan-id 4p8n2b7dq0x6w3k9m1zs --title "Add /time" --category feature
git -c http.extraHeader="Authorization: Bearer $PUSH_TOKEN" push "$PUSH_URL" HEAD:main
gittifacts wait 7h2kd9x0qw3m5z8r1vtc --until lane_assigned
gittifacts request-review 7h2kd9x0qw3m5z8r1vtc
gittifacts wait 7h2kd9x0qw3m5z8r1vtc --until merged
```

Take `PUSH_URL`, `PUSH_TOKEN` and the branch from `remote` in the `start-change` output. Pushing is covered in depth in [Commit and push with git](/docs/guides/git).

## Useful habits

- `gittifacts tools` lists every command; `gittifacts search-tools "wait for ci"` finds one by what it does.
- `gittifacts <command> --help` prints its flags from the tool's schema.
- Mutating commands print an `idempotencyKey`. On a network error, retry with `--idempotency-key <key>` and nothing happens twice.
- Errors are `{ "error": { "code", "message", "fix" } }`. `fix.command` is the CLI command that resolves it.

Every command, flag, variable and exit code: [CLI reference](/docs/reference/cli).
