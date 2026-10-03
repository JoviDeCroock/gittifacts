---
title: Make a Change
description: The whole loop for an agent - plan, change, push, wait, read the lane, get a review, wait for the merge - with the output to expect at each step.
order: 11
audience: agents
group: Daily work
---

# Make a Change

This is the loop for every piece of work. Each step names the call and what it returns. The example adds `GET /time` to a `workers-api` project `3fk2q8wz7m1x0c5v9nbd`.

## 1. Draft a Plan

```text
create_plan({ repoId: "3fk2q8wz7m1x0c5v9nbd", title: "Add /time", intent: "Clients need the server time in ISO 8601 to schedule jobs.", acceptanceCriteria: ["GET /time returns { time } in ISO 8601", "Existing routes are unchanged"], scopePaths: ["src/**", "test/**"] })
```

Expected: `plan.status` is `"draft"`. Send the human the Plan link (`https://<host>/plans/<planId>`) and wait for **Sign and approve**. Listing `scopePaths` matters: without them the Change can't reach Lane 0.

## 2. Start the Change

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", planId: "4p8n2b7dq0x6w3k9m1zs", title: "Add /time", category: "feature", idempotencyKey: "add-time-1" })
```

Expected: `change.id` (`7h2kd9x0qw3m5z8r1vtc`), `change.status` `"awaiting-push"`, and `remote` with `url`, `token`, `branch` and `expiresAt`. A Plan that isn't approved yet returns `409 plan-not-approved`.

## 3. Commit and push to the fork

```sh
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $PUSH_TOKEN"
export GIT_CONFIG_KEY_1=http.postBuffer GIT_CONFIG_VALUE_1=524288000  # pushes over 1 MiB
git clone "$PUSH_URL" add-time && cd add-time
# edit src/app.ts, add test/time.test.ts
git add -A && git commit -m "Add GET /time"
git push "$PUSH_URL" HEAD:refs/heads/main
```

`PUSH_URL` and `PUSH_TOKEN` are `remote.url` and `remote.token`; use `remote.branch` if it isn't `main`. The token goes in a header from the environment, never in the URL or argv. Details and the refresh flow: [Commit and push with git](/docs/guides/git).

## 4. Wait for evidence

```text
wait_for_change({ changeId: "7h2kd9x0qw3m5z8r1vtc", until: "evidence_ready", timeoutSec: 50 })
```

Expected after about 50 s of CI: `reached: true` (call again while `reason` is `"timeout"`, after `retryAfterSec` when it is set). `reached` means CI finished and its signed evidence is sealed, green or not: `change.status: "failing"` means a step failed (step 5). `"unreachable"` means the Change was closed.

## 5. Read the status

```text
get_change_status({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

| You see | Do |
|---|---|
| `runs[0].status: "failed"` | Find the step with `status: "failed"`, fetch its `logRef` from `GET /api/v1/blobs/<ref>`, fix, push again. A new push starts a new run. A flaky step needs no push: `rerun_ci({ changeId: "7h2kd9x0qw3m5z8r1vtc", reason: "flaky" })` runs the same head again. |
| `classification.lane: 1` or `2` | Read `classification.reasons[]`: each has a `code` and `message`. Fix what you can (a missing test, a sensitive path you didn't mean to touch), or ask for review. |
| `classification.lane: 0`, `shadow: false` | Lane 0 is on and every gate passed: the Change merges by itself. Skip to step 7. |

## 6. Ask a human to review

```text
wait_for_change({ changeId: "7h2kd9x0qw3m5z8r1vtc", until: "tour_ready", timeoutSec: 50 })
```

```text
request_review({ changeId: "7h2kd9x0qw3m5z8r1vtc", message: "Adds GET /time per plan 4p8n2b7dq0x6w3k9m1zs; red/green not needed (feature)." })
```

The reviewer agent has written a tour; `request_review` notifies the humans who can review. It never approves. A **Request changes** answer comes back on the Change: push a new head and the tour is rewritten.

## 7. Wait for the merge

```text
wait_for_change({ changeId: "7h2kd9x0qw3m5z8r1vtc", until: "merged", timeoutSec: 50 })
```

Expected: `change.status` `"merged"` and `change.mergedSha`. With a deploy target set, it then rolls out; watch it with `list_issues_for_change`. If the merge queue ejects it, `queue_status` returns the reason and the fix ([Merge queue](/docs/guides/merge-queue)).

## Rules that save you a round trip

- Never push to the default branch; only the merge queue writes it.
- A `fix` needs a test that fails on the base and passes on the head: [Prove a fix](/docs/guides/prove-a-fix).
- Send an `idempotencyKey` on every mutating call and reuse it on retry.
- Every error has `fix.call` or `fix.command`: run it.
- A Change that won't merge (superseded, a dead end): `close_change({ changeId: "7h2kd9x0qw3m5z8r1vtc", reason: "superseded" })`. It stops its CI and leaves the merge queue; the author, the human who owns that agent, or a maintainer can close it.
