# gittifacts

The CLI for [gittifacts](https://github.com/JoviDeCroock/gittifacts), the git platform built for coding agents.
Humans approve intent and machines prove conformance. Every MCP tool is a command, the output is JSON by default, and
you don't need an account to start.

```sh
npx gittifacts --host https://<host> init --template workers-api --name my-api --clone
```

## Ship something in 5 commands

```sh
# 1. Create a repo with CI, a preview and AGENTS.md. No account needed: you get an unclaimed project
#    and a claimUrl for a human. Writes .gittifacts.json, so later commands in ./my-api need no --host.
npx gittifacts --host https://<host> init --template workers-api --name my-api --clone && cd my-api

# 2. Wait for the first green build. The changeId is in nextSteps[0] of step 1.
npx gittifacts wait <changeId> --until evidence_ready

# 3. Read the result: CI steps, the lane and why, and the preview URL.
npx gittifacts get-change-status <changeId>

# 4. For the next change, draft a plan (a human approves it), then open the change. That gives you a fork remote.
npx gittifacts create-plan --repo-id <projectId> --title "Add /time" --intent "Clients need server time." --acceptance-criteria "GET /time returns ISO 8601"
npx gittifacts start-change --repo-id <projectId> --plan-id <planId> --title "Add /time" --category feature
git -c http.extraHeader="Authorization: Bearer <remote.token>" push <remote.url> HEAD:<remote.branch>

# 5. Ask a human to review it (lanes 1 and 2), then wait until it merges.
npx gittifacts request-review <changeId> && npx gittifacts wait <changeId> --until merged
```

Templates: `workers-api`, `preact-app`, `ts-library`, `static-site`. To import a repo instead, use `init --from https://github.com/org/repo`.

## Output contract

- **stdout gets exactly one JSON document.** That covers errors too:
  `{ "error": { "code", "message", "fix": { "explanation", "call"?, "command"?, "docsUrl"? } } }`.
- Next steps and fixes carry `call`, the MCP tool call, and `command`, the same step as a CLI command you can run as is.
- Mutating commands send an idempotency key and print it as `idempotencyKey`. Retry with
  `--idempotency-key <key>` and the platform won't act twice. On retryable errors, `fix.command` is the retry.
- `--human` prints text sections and tables. It uses color only on a TTY and never with `NO_COLOR`. Errors go to stderr.
- Progress and login prompts go to stderr.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Error. `{ error }` is on stdout (from the platform, the network, auth or the CLI itself) |
| 2 | Usage error (unknown command or flag, missing argument). Nothing was sent |
| 3 | `wait` didn't reach the milestone (timeout or unreachable). The result is still printed |
| 130 | Interrupted with Ctrl-C |

## Commands

Commands are generated from the platform's MCP tools: `get_change_status` becomes `get-change-status`, and each
input property becomes a flag (`changeId` becomes `--change-id`). A single required string can also be passed as a
positional argument. For raw arguments, pass `--json '{...}'` or `-` to read JSON from stdin. Precedence, lowest
first: stdin, `--json`, positional, flags. A tool that's newer than your CLI still works, because the CLI looks it
up in the server's `tools/list`.

```sh
gittifacts tools [--remote]          # every command (--remote: what the server offers right now)
gittifacts search-tools wait for ci  # fuzzy search over names and descriptions
gittifacts <command> --help          # flags, from the tool's input schema
```

The local commands are `init` (calls `create_project`), `login`, `logout`, `wait`, `tools`, `search-tools` and `help`.
`wait <changeId> --until <milestone> [--timeout 600]` re-issues the `wait_for_change` long-poll until the change
reaches the milestone or the timeout runs out. The milestones are `evidence_ready`, `lane_assigned`, `tour_ready`,
`merged` and `reverted`.

## Auth and configuration

- **No account.** `init` creates an unclaimed project. Its token is stored for you, and the output carries a
  `claimUrl` to hand to a human.
- **`gittifacts login`** uses the OAuth device flow (RFC 8628): open the URL, confirm the code. Agents can run
  `login --no-wait` to get the URL and code as JSON, then `login --device-code <code>` to finish.
- **Host**, highest priority first: `--host`, `GITTIFACTS_HOST`, the nearest `.gittifacts.json`, then the last host you logged in to.
- **Token**, highest priority first: `GITTIFACTS_TOKEN`, the host's login, then the token of the project in the current directory.
- Credentials live in `~/.config/gittifacts/credentials.json` (mode 0600, keyed by host; override the directory
  with `GITTIFACTS_CONFIG_DIR`). `.gittifacts.json` holds `{ host, projectId, remote }` and no secrets.
- `init --clone` passes the token to git through its environment. It never appears in argv or `.git/config`.
