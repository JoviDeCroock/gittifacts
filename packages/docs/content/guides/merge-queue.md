---
title: Use the merge queue
nav: Merge queue
description: Enqueue with options, read where your Change stands, wait for the merge, stack Changes, land plan groups together, and fix an ejection.
order: 15
audience: agents
group: Daily work
---

# Use the merge queue

**You'll have:** your approved Change merged by the queue, and the tools to see why it waits or why it was ejected.

An approved Change (or an auto-merge Change with auto-merge on) joins the merge queue by itself. You call the queue tools to add options, to see why it waits, and to react when it is ejected. How the queue works: [Merge queue](/docs/concepts/merge-queue).

Status: built and tested; the live end-to-end run on the hosted platform is pending.

## 1. Add options (optional)

```text
enqueue({ changeId: "7h2kd9x0qw3m5z8r1vtc", priority: "normal", idempotencyKey: "enq-7h2kd9x0qw3m5z8r1vtc" })
```

Expected: `admitted` (`false` means registered: it joins once approved), `state`, `position`, `track`, `etaSeconds`, `predictedPassProbability` and `reason`. Enqueueing never skips review.

| Option | Use |
|---|---|
| `priority: "security"` | Ranks above normal Changes |
| `priority: "incident"` | Highest after reverts; needs a human or an approved incident Plan (`incidentPlanId`) |
| `dependsOn: ["<changeId>", "<otherChangeId>"]` | Stack: this Change lands after those |
| `landMode: "atomic"` | The whole stack lands as one unit, or none of it |
| `plangroup` + `landTogether: true` + `groupSize` | Changes of one Plan merge in a single update of main, or not at all |

## 2. See where it stands

```text
queue_status({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

Expected: `status.state` (`waiting`, `speculating`, `resolving`, `passed`, `merged`, `ejected`), `status.position`, `status.blocking[]` and `status.reason` in words, such as "waiting on conflicting Change 6f8a2kq9w3x7m0d1z5rb in track 2".

## 3. Wait for the merge

```text
wait_for_merge({ changeId: "7h2kd9x0qw3m5z8r1vtc", timeoutSec: 50 })
```

| `reason` | Do |
|---|---|
| `merged` | Done; it rolls out next if the repo has a deploy target |
| `timeout` | Call again |
| `ejected` | Read `status.ejectReason` and follow its `fix` (step 4) |
| `frozen` | A revert is landing; only reverts and incident fixes merge until it thaws |
| `dequeued`, `not-queued` | It isn't in the queue: check that it was approved |

## 4. Fix an ejection

An ejection carries `{ code, message, fix, failingTests, upstream }`. The usual codes:

| Code | Do |
|---|---|
| `tests-failed` | The failure reproduced on the queue's tree and not on main. Fix it on top of current main, push, re-enqueue |
| `textual-conflict`, `semantic-conflict` | The resolver agent couldn't fix it twice. Rebase onto current main (it already contains `upstream`), resolve, push |
| `dependency-ejected` | A Change you are stacked on left the queue: fix that one first |
| `infra-error` | Not your code: `enqueue` again |

`fix.call` is often `open_workspace({ changeId: "7h2kd9x0qw3m5z8r1vtc" })`, so you can fix it without a local checkout ([Remote workspaces](/docs/guides/remote-workspaces)). Every code: [Error codes](/docs/reference/errors#merge-queue-ejections).

A conflict the resolver fixes doesn't eject you. The Change gets a `conflict-resolution` evidence item and is re-classified; its lane can only stay or rise. A resolution outside the conflict hunks needs a fresh human approval.

## 5. Leave or change priority

```text
dequeue({ changeId: "7h2kd9x0qw3m5z8r1vtc" })
```

```text
reprioritize({ changeId: "7h2kd9x0qw3m5z8r1vtc", priority: "security" })
```

## 6. Watch the whole queue

```text
queue_overview({ repoId: "3fk2q8wz7m1x0c5v9nbd" })
```

Expected: tracks, batches, freeze state, throughput and p50/p95 time in queue, quarantined tests and flake rates. Humans see the same at `https://<host>/repos/<repoId>/queue`; events stream from `GET /api/v1/repos/<repoId>/queue/events` ([Events](/docs/reference/events#merge-queue-events)).

## For owners: freeze and thaw

`POST /api/v1/repos/<repoId>/queue/freeze` and `/thaw` (human owner, signed audit event). A thaw invalidates batches built on the bad main.
