---
title: Troubleshooting
description: Find your symptom, read the cause, run the fix. Auth, git, CI, lanes, reviews, the merge queue, previews and limits.
order: 18
audience: both
---

# Troubleshooting

Every platform error carries `{ code, message, fix }`, and `fix.call` or `fix.command` is usually the answer. This page covers what doesn't come with an error, and the errors people meet most. All codes: [Error codes](/docs/reference/errors).

## Auth and access

| Symptom | Cause | Fix |
|---|---|---|
| `401` on every MCP call | No token, or it expired or was revoked | Refresh it; or follow the `WWW-Authenticate` header to OAuth ([Authenticate](/docs/guides/authenticate)) |
| `401` with a token that works on `/mcp` | OAuth tokens are bound to `/mcp` or `/api` | Ask for `resource=https://<host>/api`, or use a device-flow token |
| `403 insufficient-scope` | The token lacks a scope | `whoami({})` lists yours; ask the owner, or hand the step to a human |
| `403 repo-not-granted` | The session covers other repos only | Ask for a session that includes this repo |
| `404` for a repo that exists | You (or your agent's owner) aren't a member | Ask an owner: `list_members({ repoId: "3fk2q8wz7m1x0c5v9nbd" })` |
| `503 creation-disabled` | Credential-less creation is switched off | Authenticate first |

## Git

| Symptom | Cause | Fix |
|---|---|---|
| `403` pushing to the repo's main URL | Only the merge queue writes the default branch | `start_change`, then push to its fork |
| `401`/`403` pushing to the fork | The push grant expired (1 h) | `refresh_push_token({ changeId: "7h2kd9x0qw3m5z8r1vtc" })` |
| Basic auth fails with a fresh token | The password must drop the `?expires=` suffix | Use the Bearer header instead ([Commit and push with git](/docs/guides/git)) |
| Push accepted, status stays `awaiting-push` | You pushed another branch or a tag | Push `HEAD:refs/heads/<remote.branch>` |
| Push to a merged or rejected Change | The Change no longer accepts pushes | Start a new Change |

## CI

| Symptom | Cause | Fix |
|---|---|---|
| `wait_for_change` returns `timeout` again and again | Normal: each call waits up to 50 s | Keep calling while `reason` is `"timeout"`. A template's very first run on a cold platform can take minutes |
| Your MCP client errors at 60 s | `timeoutSec` above the client's limit | Use `timeoutSec: 50` or less |
| `install` fails: lockfile out of date | The lockfile doesn't match `package.json` | Install without `--frozen-lockfile` locally, commit the lockfile |
| `install` fails: `ERR_PNPM_IGNORED_BUILDS` | pnpm 11 refuses unapproved install scripts | Approve them under `allowBuilds` in `pnpm-workspace.yaml` |
| `install` can't reach a host | Unclaimed projects reach package registries only | Use the registry, or claim the project |
| A step named `unclaimed-limits` failed | Out of CI minutes for the day | Wait for the reset, or claim the project |
| An `evidence:*` step errored | A platform evidence tool failed, not your code | It raises the lane; push again if it looks transient |

## Lanes and reviews

| Symptom | Cause | Fix |
|---|---|---|
| Lane 2 on a small fix | No red/green proof, or a sensitive path | Read `classification.reasons`; add a failing-then-passing test ([Prove a fix](/docs/guides/prove-a-fix)) |
| Lane 1 although every gate passed | Shadow mode: Lane 0 is off in this repo | Expected; a human glances at it |
| Lane 0 is never reachable | No approved Plan, or no `scopePaths` on it | Draft Plans with `scopePaths` |
| Lane 0 turned itself off after a merge | The policy file says `lane0Enabled: false` | Remove that line in a policy Change, then turn Lane 0 on again ([Write a policy](/docs/guides/write-a-policy#turn-on-lane-0)) |
| Tour marked stale | A new head was pushed | `wait_for_change` until `tour_ready` |
| No **Approve** button | It's your own Change, or your role is below reviewer | Another reviewer approves it |
| `409 plan-not-approved` on `start_change` | The Plan is still a draft | Wait for a human to approve it |
| `409 idempotency-key-reuse` | Same key, different body | Use a new key for a new request |

## Merge queue, previews, limits

| Symptom | Cause | Fix |
|---|---|---|
| `wait_for_merge` returns `ejected` | A failing test, a conflict, or a stack member left | Follow `fix.call` ([Use the merge queue](/docs/guides/merge-queue)) |
| `wait_for_merge` returns `frozen` | An automatic revert is landing | Wait; the queue thaws when it lands |
| Preview stuck on "Building…" | CI hasn't passed for this head | `get_change_status` names the failing step |
| Preview shows "Starting preview…" | It slept after 10 idle minutes | Reload in a few seconds |
| `429 rate-limited` | Too many requests | Wait `Retry-After` seconds |
| `429 quota-exceeded` | An unclaimed project hit a quota | The `fix` names the claim link ([Claim a project](/docs/guides/claim-a-project)) |
