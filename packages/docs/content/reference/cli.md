---
title: "CLI reference"
nav: "CLI"
description: "Every gittifacts CLI command (v0.1.0): local commands, one command per MCP tool, global flags, environment variables and exit codes."
order: 20
audience: both
generated: true
---

# CLI reference

The CLI prints exactly one JSON document on stdout (errors too) and `--human` tables on request. Every MCP tool is a command: `get_change_status` becomes `gittifacts get-change-status`, and each argument becomes a flag (`changeId` → `--change-id`). A single required string argument can also be passed positionally.

> Generated from `packages/cli/src/main.ts`, `packages/cli/src/tools/commands.ts`, `packages/cli/src/args.ts`, `packages/cli/src/commands/help.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## Global flags

| Flag | Notes |
| --- | --- |
| `--host <url>` | Platform origin (else GITTIFACTS_HOST, .gittifacts.json, the last login). |
| `--human` | Text for people (the default when stdout is a terminal). |
| `--json [<object\|->]` | Print JSON (the default when stdout is not a terminal). With an object (or `-` for stdin): raw tool arguments. |
| `--idempotency-key <key>` | Key for mutating commands (default: generated, printed in the output). |
| `--help` | Usage for a command. |
| `--version` | Print the CLI version. |
| `--no-update` | Run this build as it is: skip the check for a newer one on the platform (also GITTIFACTS_NO_UPDATE=1). |

## Environment

| Variable | Meaning |
| --- | --- |
| `GITTIFACTS_HOST` | platform origin (overrides .gittifacts.json and the last login) |
| `GITTIFACTS_TOKEN` | bearer token (overrides stored credentials) |
| `GITTIFACTS_TOKEN_HOST` | the one host GITTIFACTS_TOKEN may be sent to when the host comes only from .gittifacts.json |
| `GITTIFACTS_CONFIG_DIR` | credentials directory (default ~/.config/gittifacts) |
| `GITTIFACTS_NO_UPDATE` | 1: never check the platform for a newer CLI build (like --no-update; builds live in ~/.cache/gittifacts/cli) |
| `NO_COLOR` | no color in --human output |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | error: `{ error: { code, message, fix } }` on stdout |
| `2` | usage error (unknown command/flag, missing argument); nothing was sent |
| `3` | wait, ship: the milestone was not reached (timeout, unreachable, or ship: CI failed) |
| `130` | interrupted (Ctrl-C) |

## Local commands

These run in the CLI itself (some call one MCP tool on your behalf).

### `gittifacts init`

Create a repo in one call (create_project): repo from a template or a GitHub import, .platform/ci.ts, policy and AGENTS.md, first CI and preview. Writes .gittifacts.json (host, projectId, remote, changeId; no secrets). With --clone, plain git push then goes to the first Change's fork (credential helper). No account needed: you get an unclaimed repo and a claim URL for a human.

```text
gittifacts init [--template <workers-api|preact-app|ts-library|static-site>] [--from <string>] [--name <string>] [--description <string>] [--clone] [--dir <string>] [--force] [--show-token] [--idempotency-key <key>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--template` | workers-api \| preact-app \| ts-library \| static-site |  | Start from a template. |
| `--from` | string |  | Import a GitHub repository (https URL). |
| `--name` | string |  | Repo name. |
| `--description` | string |  | One-line description. |
| `--clone` | boolean |  | git clone the new repo (the token travels in git's environment, never in .git/config). |
| `--dir` | string |  | Where to write .gittifacts.json (default: cwd), or clone to with --clone (default: ./<name>). |
| `--force` | boolean |  | Overwrite an existing .gittifacts.json. |
| `--show-token` | boolean |  | Include the repo token in the output (it is stored either way). |

Examples: `gittifacts init --template workers-api --name my-api`, `gittifacts init --template preact-app --name app --clone`, `gittifacts init --from https://github.com/org/repo`.

### `gittifacts clone`

git clone a repo you can read (the platform's read-only /git/ proxy, with your login token), write .gittifacts.json and install the credential helper. Then edit, commit and run `gittifacts ship`.

```text
gittifacts clone <repoId> [--dir <string>] [--url <string>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--repo-id` | string | yes | Also the first positional argument. The repo (from list-repos or the repo page). |
| `--dir` | string |  | Where to clone (default ./<repo name>). |
| `--url` | string |  | The repo's /git/ URL, when the platform doesn't report one. |

Examples: `gittifacts clone repo_123`, `gittifacts clone repo_123 --dir work`.

### `gittifacts ship`

Push HEAD to this clone's open Change (or start one: start_change, then point origin at its fork), wait for CI and the lane, and print the lane, why, the Change's page and the next step.

```text
gittifacts ship [--title <string>] [--plan <string>] [--category <fix|feature|refactor|dependency|transform|revert|docs|chore>] [--timeout <integer>] [--wait] [--idempotency-key <key>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--title` | string |  | A new Change's title (default: the last commit subject). |
| `--plan` | string |  | The approved plan a new Change implements (planId). |
| `--category` | fix \| feature \| refactor \| dependency \| transform \| revert \| docs \| chore |  | A new Change's category (default feature). |
| `--timeout` | integer |  | Seconds to wait for the lane (default 900). |
| `--wait` | boolean |  | Wait for the lane (default true; --no-wait to skip). |

Examples: `gittifacts ship`, `gittifacts ship --title "Rate limit logins" --category fix`.

### `gittifacts login`

Log in with the OAuth device flow (RFC 8628): open the printed URL, confirm the code, and the token is stored in ~/.config/gittifacts/credentials.json (0600) for this host. Optional: unclaimed projects work without it.

```text
gittifacts login [--scope <string>] [--no-wait] [--device-code <string>] [--interval <integer>] [--expires-in <integer>] [--client-id <string>] [--device-code-url <string>] [--token-url <string>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--scope` | string |  | Space-separated scopes to request (default: the platform's). |
| `--no-wait` | boolean |  | Print the code and URL as JSON and exit; finish later with --device-code. |
| `--device-code` | string |  | Finish a login started with --no-wait. |
| `--interval` | integer |  | Polling interval in seconds with --device-code (default 5). |
| `--expires-in` | integer |  | Seconds left on the --device-code (default 1800). |
| `--client-id` | string |  | OAuth client id (default gittifacts-cli, or what /start names). |
| `--device-code-url` | string |  | Device authorization endpoint (default: discovered). |
| `--token-url` | string |  | Token endpoint (default: discovered). |

Examples: `gittifacts login --host https://gittifacts.example`, `gittifacts login --no-wait   # agent: hand the URL to a human, then:`, `gittifacts login --device-code <deviceCode>`.

### `gittifacts logout`

Revoke this host's login on the platform (its session stops showing as active), then forget the token. --all also forgets the tokens of unclaimed projects created from this machine.

```text
gittifacts logout [--all]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--all` | boolean |  | Also remove project tokens for this host. |

### `gittifacts wait`

Wait until a change reaches a milestone, re-issuing the wait_for_change long-poll until --timeout. Exit 0 when reached, 3 when it timed out, can no longer be reached, a human sent it back (changes requested, rejected, approval withdrawn) or it is failing (red CI, a merge-queue ejection or a failed merge).

```text
gittifacts wait <changeId> --until <evidence_ready|lane_assigned|tour_ready|merged|reverted> [--timeout <integer>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--change-id` | string | yes | Also the first positional argument. The change to wait for. |
| `--until` | evidence_ready \| lane_assigned \| tour_ready \| merged \| reverted | yes | The milestone. |
| `--timeout` | integer |  | Overall seconds to wait (default 600). |

Examples: `gittifacts wait chg_123 --until evidence_ready`, `gittifacts wait chg_123 --until merged --timeout 1800 --human`.

### `gittifacts qa`

Ask an agent to test the app built from the change's head in a real browser against the Plan's acceptance criteria (screenshots, a replay, a verdict per criterion). Idempotent per head; --wait prints the verdicts when it finishes.

```text
gittifacts qa <changeId> [--github <string>] [--force] [--wait] [--timeout <integer>] [--idempotency-key <key>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--change-id` | string |  | Also the first positional argument. The change (or pass --github). |
| `--github` | string |  | GitHub mode: the pull request as owner/repo#123. |
| `--force` | boolean |  | Run again although this head already has a finished run. |
| `--wait` | boolean |  | Wait for the run to finish and print the verdicts. |
| `--timeout` | integer |  | With --wait: overall seconds (default 600). |

Examples: `gittifacts qa chg_123 --wait`, `gittifacts qa --github acme/web#42 --wait --human`.

### `gittifacts tools`

List the commands generated from MCP tools (bundled with this CLI, or --remote: what the live server offers now).

```text
gittifacts tools [--remote]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--remote` | boolean |  | Ask the server's tools/list instead. |

### `gittifacts search-tools`

Fuzzy-search command names and descriptions (offline; mirrors the MCP search_tools). --remote searches the live server's tools.

```text
gittifacts search-tools <query> [--remote] [--limit <integer>]
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--query` | string |  | Also the first positional argument. What you want to do, in words. |
| `--remote` | boolean |  | Search the server's tools/list. |
| `--limit` | integer |  | Maximum results (default 5). |

Examples: `gittifacts search-tools "wait for ci"`, `gittifacts search-tools review`.

### `gittifacts help`

Usage, commands, global flags and exit codes; `help <command>` for one command.

```text
gittifacts help <command>
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--command` | string |  | Also the first positional argument. |

### `gittifacts git-credential`

git's credential helper (installed per clone by init --clone, clone, start-change and ship): a fresh push token for this clone's Change on every git push. Not for running by hand.

```text
gittifacts git-credential <action>
```

| Flag | Type | Required | Notes |
| --- | --- | --- | --- |
| `--action` | get \| store \| erase |  | Also the first positional argument. |

## Tool commands

One per MCP tool. Arguments, scopes and outputs are in the [MCP tools](/docs/reference/mcp-tools) reference. Mutating commands send an idempotency key and print it; pass `--idempotency-key <key>` to retry without acting twice. `--json '{...}'` (or `--json -` for stdin) passes raw arguments.

| Command | Tool | Usage |
| --- | --- | --- |
| `gittifacts create-project` | `create_project` | `gittifacts create-project [--name <string>] [--template <workers-api\|preact-app\|ts-library\|static-site>] [--from <string>] [--import-mode <push>] [--description <string>] [--idempotency-key <key>]` — One call: a repo from a template (or an import, or empty) with .platform/ci.ts, .platform/policy.ts and AGENTS.md committed, the first CI run and preview started, and a push token for your first Change's fork; it returns at once (wait_for_change on bootstrapChangeId for the first green). |
| `gittifacts whoami` | `whoami` | `gittifacts whoami` — Who you are (your actor: principalId, kind, and for an agent the person accountable for you, ownerName, with the page where they inspect or revoke you, agentsUrl), scopes, the repos you can act on (with claim status and allowed actions) and quotas. |
| `gittifacts list-repos` | `list_repos` | `gittifacts list-repos` — Repos you can read, with open changes per lane and whether auto-merge (Lane 0) is on or still calibrating. |
| `gittifacts list-members` | `list_members` | `gittifacts list-members <repoId>` — A repo's human members and their roles (reader < reviewer < maintainer < owner), and your role (an agent acts with its owner's role: reviewer or above to draft plans and start changes). |
| `gittifacts create-plan` | `create_plan` | `gittifacts create-plan --repo-id <string> --title <string> --intent <string> --acceptance-criteria <string>... [--out-of-scope <string>...] [--risk-declarations <json>] [--scope-paths <string>...] [--affected-routes <string>...] [--supersedes <string>] [--idempotency-key <key>]` — Draft a plan: intent, acceptance criteria and the paths you expect to touch. |
| `gittifacts get-plan` | `get_plan` | `gittifacts get-plan <planId>` — A plan: its intent, acceptance criteria and scope, its status (draft until a person approves it; agents never can), who drafted and approved it, the changes started from it, its page (url) to hand a person, and what to do next. |
| `gittifacts list-plans` | `list_plans` | `gittifacts list-plans <repoId> [--status <draft\|approved\|superseded\|rejected>] [--mine]` — A repo's plans, newest first, each with its status and page (url). |
| `gittifacts withdraw-plan` | `withdraw_plan` | `gittifacts withdraw-plan <planId> [--reason <string>] [--idempotency-key <key>]` — Withdraw a draft plan you drafted yourself (it ends as rejected, withdrawn by its author; the reason is audited). |
| `gittifacts start-change` | `start_change` | `gittifacts start-change --repo-id <string> [--plan-id <string>] --title <string> --category <fix\|feature\|refactor\|dependency\|transform\|revert\|docs\|chore> [--summary <string>] [--agent-trace-id <string>] [--paths <string>...] [--idempotency-key <key>]` — Fork the repo for one change and get a short-lived push token for that fork only. |
| `gittifacts list-changes` | `list_changes` | `gittifacts list-changes <repoId> [--status <awaiting-push\|running\|failing\|awaiting-review\|approved\|queued\|merged\|rolling-out\|released\|reverted\|rejected\|abandoned>] [--mine]` — A repo's changes, most recently updated first (up to 200): status, lane, plan, who started it and its page (url). |
| `gittifacts compare-attempts` | `compare_attempts` | `gittifacts compare-attempts <planId>` — Several agents may attempt the same approved plan, each its own change. |
| `gittifacts get-change-status` | `get_change_status` | `gittifacts get-change-status <changeId> [--github <string>]` — A change's status, lane (and why), pipeline runs for each head, the human reviews (decision, comment, reviewer, head; a withdrawn approval says why), who started it (author, with an agent's accountable person), the open changes on the same plan or paths (overlaps), the merge queue's conflict resolution when what lands differs from your head (resolution), its page (url) to hand a person, and what to do next. |
| `gittifacts get-evidence` | `get_evidence` | `gittifacts get-evidence <changeId> [--github <string>]` — The signed evidence for the change's current head (tests, red/green proof, coverage, API diff, ...) and whether the signature verifies. |
| `gittifacts get-tour` | `get_tour` | `gittifacts get-tour <changeId> [--github <string>]` — The walkthrough (the tour) a second reviewer agent wrote for the change, what a human will read: stops with verdicts, least-confident points and what was not done. |
| `gittifacts request-review` | `request_review` | `gittifacts request-review <changeId> [--message <string>] [--idempotency-key <key>]` — Ask for a human review of your change. |
| `gittifacts rerun-ci` | `rerun_ci` | `gittifacts rerun-ci <changeId> [--reason <string>] [--idempotency-key <key>]` — Repeats CI, evidence, the lane and the walkthrough on the change's current head, without a push (a flaky step). |
| `gittifacts close-change` | `close_change` | `gittifacts close-change <changeId> [--reason <string>] [--idempotency-key <key>]` — Close (abandon) a change that won't merge: stops its CI, takes it out of the merge queue and deletes its fork later. |
| `gittifacts list-issues-for-change` | `list_issues_for_change` | `gittifacts list-issues-for-change <changeId>` — Workers Issues attributed to the change or the version it rolled out (errors seen in production). |
| `gittifacts refresh-push-token` | `refresh_push_token` | `gittifacts refresh-push-token <changeId> [--idempotency-key <key>]` — A fresh short-lived push token for your change's fork (author only). |
| `gittifacts wait-for-change` | `wait_for_change` | `gittifacts wait-for-change <changeId> [--github <string>] --until <evidence_ready\|lane_assigned\|tour_ready\|merged\|reverted> [--timeout-sec <integer>]` — Long-poll until the change's current head reaches a milestone, can no longer reach it, or the timeout passes. |
| `gittifacts open-workspace` | `open_workspace` | `gittifacts open-workspace <changeId> [--idempotency-key <key>]` — A sandbox with your Change's fork checked out at its head, for agents without a local shell or git. |
| `gittifacts ws-exec` | `ws_exec` | `gittifacts ws-exec --workspace-id <string> --command <string> [--cwd <string>] [--timeout-sec <integer>] [--idempotency-key <key>]` — Runs `sh -c <command>` in the workspace checkout as the unprivileged runner user, with a hard timeout. |
| `gittifacts ws-read` | `ws_read` | `gittifacts ws-read --workspace-id <string> --path <string> [--start-line <integer>] [--end-line <integer>]` — Reads a file from the workspace checkout, optionally a 1-based inclusive line range. |
| `gittifacts ws-write` | `ws_write` | `gittifacts ws-write --workspace-id <string> --path <string> [--content <string>] [--patch <string>] [--idempotency-key <key>]` — Writes a whole file (`content`, creating parent directories) or applies a unified diff to it (`patch`). |
| `gittifacts ws-diff` | `ws_diff` | `gittifacts ws-diff <workspaceId>` — Every change in the workspace (committed or not, new files included) against the Change's base commit: per-file stats and a unified diff (capped). |
| `gittifacts ws-commit-push` | `ws_commit_push` | `gittifacts ws-commit-push --workspace-id <string> --message <string> [--idempotency-key <key>]` — Commits every change in the workspace (as you) and pushes it to the Change's fork branch. |
| `gittifacts close-workspace` | `close_workspace` | `gittifacts close-workspace <workspaceId> [--idempotency-key <key>]` — Stops the workspace and deletes its sleep snapshot. |
| `gittifacts propose-platform-config` | `propose_platform_config` | `gittifacts propose-platform-config <repoId> [--rerun] [--wait-sec <integer>] [--idempotency-key <key>]` — Detects how an imported repo installs, tests and builds (in a sandbox) and proposes .platform/ci.ts, .platform/policy.ts and AGENTS.md as a draft Plan plus a Change a human approves (never applied silently). |
| `gittifacts enqueue` | `enqueue` | `gittifacts enqueue <changeId> [--priority <normal\|security\|incident>] [--depends-on <string>...] [--plangroup <string>] [--land-together] [--group-size <integer>] [--land-mode <atomic\|incremental>] [--incident-plan-id <string>] [--idempotency-key <key>]` — Joins your Change to the merge queue with options (priority, dependsOn for stacks, plangroup + landTogether, landMode); optional, since approval queues a Change by itself. |
| `gittifacts queue-status` | `queue_status` | `gittifacts queue-status <changeId>` — State, track, batch, position, ETA, the Changes it waits on and why (e.g. |
| `gittifacts wait-for-merge` | `wait_for_merge` | `gittifacts wait-for-merge <changeId> [--timeout-sec <integer>]` — Long-polls until the Change merges, is ejected or dequeued, or the queue freezes (timeoutSec ≤ 55). |
| `gittifacts dequeue` | `dequeue` | `gittifacts dequeue <changeId> [--idempotency-key <key>]` — Removes a Change from the merge queue (stack dependents leave with it): its author, the author's owner, or a person who may review it. |
| `gittifacts reprioritize` | `reprioritize` | `gittifacts reprioritize <changeId> --priority <normal\|security\|incident> [--incident-plan-id <string>] [--idempotency-key <key>]` — Sets a queued Change's priority class (normal, security, incident): its author, the author's owner, or a person who may review it. |
| `gittifacts queue-overview` | `queue_overview` | `gittifacts queue-overview <repoId>` — Tracks (independent parallel queues) with their speculative batches, the landing pipeline, freeze state, throughput, p50/p95 time in queue, quarantined tests and every entry with its reason and ETA. |
| `gittifacts search-tools` | `search_tools` | `gittifacts search-tools <query>` — Fuzzy search over every gittifacts tool's name and description. |
| `gittifacts request-qa` | `request_qa` | `gittifacts request-qa <changeId> [--github <string>] [--force] [--idempotency-key <key>]` — On request only: an agent drives the app built from the change's current head in a real browser against the Plan's acceptance criteria (no Plan: a smoke check), with a screenshot per step, a replay GIF and a pass / fail / couldn't-test verdict per criterion, signed into the evidence. |
| `gittifacts get-qa` | `get_qa` | `gittifacts get-qa <changeId> [--github <string>]` — The change's QA runs, newest first: status, verdict per criterion with the reason, the lane before and after, cost, and the screenshots' blob refs. |
| `gittifacts get-rollout` | `get_rollout` | `gittifacts get-rollout <changeId> [--github <string>]` — After merge: the staged rollout of the change (stages, error rate against the previous version, new issue groups, the flag that switches it off), the policy it was held to (from its base) and its audit timeline. |
| `gittifacts list-audit-events` | `list_audit_events` | `gittifacts list-audit-events [--repo-id <string>] [--subject <string>] [--actor <string>] [--action <string>] [--cursor <string>] [--limit <integer>]` — The signed audit log, newest first: who did what (actor, with an agent's accountable person), to which subject, when, and whether the hash chain verifies. |
