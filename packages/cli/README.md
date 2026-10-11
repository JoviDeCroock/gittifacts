# gittifacts

The CLI for [gittifacts](https://github.com/JoviDeCroock/gittifacts), the git platform built for coding agents.
Humans approve intent and machines prove conformance. Every MCP tool is a command, the output is text on a terminal
and JSON when piped (or with `--json`), and you don't need an account to start.

The platform serves the CLI as an npm tarball; always run it from your platform's URL. A bare `npx gittifacts`
fetches whatever npm package holds that name, which is not this CLI. Node 22 or later:

```sh
npx -y https://<host>/cli/v2/gittifacts.tgz --host https://<host> init --template workers-api --name my-api --clone
# The CLI prints next steps as `gittifacts …` commands: give it that name.
alias gittifacts="npx -y https://<host>/cli/v2/gittifacts.tgz"
```

The CLI updates itself: before a command it checks `<host>/cli/version.json` (at most every 10 minutes, only for a
host you chose, never one named only by a checkout's `.gittifacts.json`, never with a token) and runs the newer
verified build from `~/.cache/gittifacts/cli/`. Opt out with `--no-update` or `GITTIFACTS_NO_UPDATE=1`.

## Ship something in 5 commands

```sh
# 1. Create a repo with CI, a preview and AGENTS.md, cloned into ./my-api. No account needed: you get an unclaimed
#    repo and a claim link for a human. The clone's origin is your first Change's fork, and git push just works.
gittifacts --host https://<host> init --template workers-api --name my-api --clone && cd my-api

# 2. Wait for the first green build: the Change is bs-<repoId> (nextSteps[0] in the JSON).
gittifacts wait bs-<repoId> --until evidence_ready

# 3. Edit, commit, ship: pushes HEAD to the Change's fork, waits for CI and the lane, prints why and what next.
git commit -am "Add /time" && gittifacts ship

# 4. Ask a human to review it (lanes 1 and 2), then wait until it merges.
gittifacts request-review <changeId> && gittifacts wait <changeId> --until merged

# 5. Next change: ship again. Once the last one merged, ship starts a new Change and points origin at its fork.
git commit -am "Add /date" && gittifacts ship --title "Add /date"
```

An existing repo: `gittifacts clone <repoId>` (needs a login; claimed repos only), then edit, commit, `gittifacts ship`.
With an approved plan: `gittifacts ship --plan <planId>`.

Templates: `workers-api`, `preact-app`, `ts-library`, `static-site`. To import a repo instead, use `init --from https://github.com/org/repo`.

## Output contract

- **Piped (or `--json`), stdout gets exactly one JSON document.** That covers errors too:
  `{ "error": { "code", "message", "fix": { "explanation", "call"?, "command"?, "docsUrl"? } } }`.
- Next steps and fixes carry `call`, the MCP tool call, and `command`, the same step as a CLI command you can run as is.
- Mutating commands send an idempotency key and print it as `idempotencyKey`. Retry with
  `--idempotency-key <key>` and the platform won't act twice. On retryable errors, `fix.command` is the retry.
- On a terminal (or with `--human`) the same document prints as text sections and tables; `init`, `ship` and `clone`
  print a few lines instead. Color only on a TTY and never with `NO_COLOR`. Errors go to stderr.
- Progress and login prompts go to stderr.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Error. `{ error }` is on stdout (from the platform, the network, auth or the CLI itself) |
| 2 | Usage error (unknown command or flag, missing argument). Nothing was sent |
| 3 | `wait` or `ship` didn't reach the milestone (timeout, unreachable, or CI failed). The result is still printed |
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

The local commands are `init` (calls `create_project`), `clone`, `ship`, `login`, `logout`, `wait`, `qa`, `tools`,
`search-tools`, `help` and `git-credential` (git runs it).
`wait <changeId> --until <milestone> [--timeout 600]` re-issues the `wait_for_change` long-poll until the change
reaches the milestone or the timeout runs out. The milestones are `evidence_ready`, `lane_assigned`, `tour_ready`,
`merged` and `reverted`. `reached: true` means the milestone holds for the change's current head right now:
`evidence_ready` is CI finished and its evidence sealed (a bootstrap Change is `released` or `failing` by then), and
`tour_ready` is the tour written and the change routed. A long-poll the platform could not hold (a deploy) answers
`timeout` with `retryAfterSec`; `wait` pauses that long and asks again, and re-issues a request that stays silent
15 s past its window.

A red run you believe is flaky doesn't need a new push: `gittifacts rerun-ci <changeId> --reason "<why>"` runs CI,
evidence, the lane and the tour again on the same head. `gittifacts close-change <changeId> --reason "<why>"` closes
a Change that won't merge. Both work for the Change's author (or the human who owns that agent) and maintainers.

`init` stores the project token and sends it on every later command, so it leaves out the platform's "reconnect
with the token" step (an MCP session needs it; the CLI doesn't).

## Auth and configuration

- **No account.** `init` creates an unclaimed project. Its token is stored for you, and the output carries a
  `claimUrl` to hand to a human.
- **`gittifacts login`** uses the OAuth device flow (RFC 8628): open the URL, confirm the code. Agents can run
  `login --no-wait` to get the URL and code as JSON, then `login --device-code <code>` to finish.
- **Host**, highest priority first: `--host`, `GITTIFACTS_HOST`, the nearest `.gittifacts.json`, then the last host you logged in to.
- **Token**, highest priority first: `GITTIFACTS_TOKEN`, the host's login, then the token of the project in the current directory.
- **What a checkout can't do.** `.gittifacts.json` comes from the directory tree, so the CLI doesn't let it redirect a
  token. `GITTIFACTS_TOKEN` is sent to a host only `.gittifacts.json` names when you logged in to that host, created a
  project there from this machine, or set `GITTIFACTS_TOKEN_HOST` to it; otherwise the command fails with
  `untrusted-host` (set `GITTIFACTS_HOST` next to `GITTIFACTS_TOKEN` and it never comes up). Its `mcpUrl` is ignored
  unless it is on the host, and plain `http://` is refused except to localhost, 127.0.0.1 and [::1].
- Credentials live in `~/.config/gittifacts/credentials.json` (mode 0600, keyed by host; override the directory
  with `GITTIFACTS_CONFIG_DIR`). `.gittifacts.json` holds `{ host, projectId, remote, changeId }` and no secrets;
  templates git-ignore it and the CLI adds it to `.git/info/exclude`.
- **Plain `git push`.** `init --clone`, `clone`, `start-change` (inside a clone) and `ship` point `origin` at the
  Change's fork, set `remote.origin.push` to its branch, and install `gittifacts git-credential` as the local
  credential helper for that origin. On every push git asks it; it calls `refresh_push_token` and answers Basic
  `x:<token without ?expires=>`. Push tokens live an hour and each Change has its own fork, so nothing is stored:
  tokens never appear in argv or `.git/config`. The helper runs this bundle by absolute path, or
  `npx -y <host>/cli/v2/gittifacts.tgz` once npx's cache is gone.
