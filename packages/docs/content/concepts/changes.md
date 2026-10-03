---
title: Changes
description: A Change is intent plus diff plus evidence, worked on in its own fork. It replaces the pull request.
order: 2
audience: both
---

# Changes

A **Change** is the unit of work: an intent (usually a Plan), a diff, and the evidence that proves it. It is not a pull request. Nobody reads a diff because a human wrote it; the platform proves what it can and routes the rest to the cheapest safe review.

## How a Change is built

1. `start_change` forks the repo in Artifacts (`task-<changeId>`) and returns a **push grant** for that fork only, valid for at most an hour.
2. The author pushes commits to the fork. Each push starts a pipeline for the new head and cancels the run for the older one.
3. CI runs your steps, then the platform's evidence steps, and signs the evidence.
4. The classifier assigns a lane; Lanes 1 and 2 get a tour and wait for a human.
5. The merge queue lands it on the default branch. Only the merge queue writes the default branch.

The author declares a `category`: `fix`, `feature`, `refactor`, `dependency`, `transform`, `revert`, `docs` or `chore`. It is a claim, an input to the classifier, never the decision. A `fix` needs red/green proof to reach Lane 0.

## Statuses

| Status | Meaning | What to do |
|---|---|---|
| `awaiting-push` | Fork created, nothing pushed yet | Push to the fork |
| `running` | Pipeline in flight for the head | `wait_for_change` until `evidence_ready` |
| `failing` | Pipeline red | Fix the failing step and push again; a flaky step: `rerun_ci` (same head, no push) |
| `awaiting-review` | Lane 1 or 2, tour ready | `request_review`; a human decides |
| `approved` | A human approved the tour (or Lane 0 is on) | Wait for `merged` |
| `queued` | In the merge queue | `queue_status` explains any wait |
| `merged` | On the default branch | Watch for issues |
| `rolling-out` | Gradual deploy in progress | `list_issues_for_change` |
| `released` | Watch window closed clean | Done |
| `reverted` | Rolled back after a regression | Read the issues, start a follow-up |
| `rejected`, `abandoned` | Closed (`close_change` abandons one that won't merge) | Start a new Change to try again |

Reviews bind to a specific head. A push after an approval needs a fresh approval.

## Start one

```text
start_change({ repoId: "3fk2q8wz7m1x0c5v9nbd", planId: "4p8n2b7dq0x6w3k9m1zs", title: "Add /time", category: "feature" })
```

Expected: `change.status` is `awaiting-push` and `remote` holds `url`, `token`, `branch` and `expiresAt`. Next: [Make a Change](/docs/guides/make-a-change).
