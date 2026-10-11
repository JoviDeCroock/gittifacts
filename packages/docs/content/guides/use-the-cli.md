---
title: Use the CLI
description: Install the gittifacts CLI, log in with the device flow, and ship a Change from a terminal. Every MCP tool is a command; output is JSON.
order: 12
audience: both
group: Daily work
---

# Use the CLI

**You'll have:** the CLI installed under its own name, logged in as you, and the commands for the full change loop.

New here? [Try it in 2 minutes](/docs/get-started/cli) first: it needs no login.

## 1. Give the CLI its name

```sh
alias gittifacts="npx -y https://<host>/cli/gittifacts.tgz"
gittifacts --version
```

Expected: `{"name":"gittifacts","version":"0.1.0"}`. The next steps the CLI prints start with `gittifacts`, so the alias makes them runnable.

<details>
<summary>Install for good, update, and npm</summary>

Install it with `npm install -g https://<host>/cli/gittifacts.tgz`. `npx` caches a tarball by its URL: to pick up a newer CLI, clear that cache (`rm -rf ~/.npm/_npx`). `https://<host>/cli/latest.json` names the version the platform serves.

Always run the CLI from your platform's tarball URL. A bare `npx gittifacts` fetches whatever npm package holds that name, which is not this CLI.

</details>

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

To keep a repo you made without logging in, open its `claimUrl` signed in ([Claim a repo](/docs/guides/claim-a-project)).

## 3. Ship a change

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

Take `PUSH_URL`, `PUSH_TOKEN` and the branch from `remote` in the `start-change` output. Each step, with expected output: [Make a Change](/docs/guides/make-a-change). Pushing in depth: [Commit and push with git](/docs/guides/git).

## Habits

- `gittifacts tools` lists every command; `gittifacts search-tools "wait for ci"` finds one by what it does.
- `gittifacts <command> --help` prints its flags from the tool's schema.
- `--human` prints tables instead of JSON.
- Mutating commands print an `idempotencyKey`. On a network error, retry with `--idempotency-key <key>` and nothing happens twice.
- Errors are `{ "error": { "code", "message", "fix" } }`. `fix.command` is the CLI command that resolves it.

## Next

- Every command, flag, variable and exit code: [CLI reference](/docs/reference/cli).
- The same loop over MCP: [Make a Change](/docs/guides/make-a-change).
