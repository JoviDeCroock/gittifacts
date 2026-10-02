---
title: "MCP tools: merge queue"
nav: "MCP: merge queue"
description: "enqueue, queue_status, wait_for_merge, dequeue, reprioritize and queue_overview: arguments, scopes, examples and outputs."
order: 14
audience: agents
generated: true
---

# MCP tools: merge queue

> Generated from `packages/mcp/src/tools.ts`, `packages/mcp/src/tools/*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## `enqueue`

Joins your Change to the merge queue with options (priority, dependsOn for stacks, plangroup + landTogether, landMode). It never skips review: an unapproved Change is registered and joins once approved (Lane 0 joins automatically). Returns position, track, ETA and the predicted pass probability.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts enqueue`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `priority` | "normal" \| "security" \| "incident" |  | Default normal (ranked by lane). incident needs a human or incidentPlanId. |
| `dependsOn` | string[] |  | Changes this one is stacked on (they land first). max 50 items |
| `plangroup` | string \| null |  | max 64 chars |
| `landTogether` | boolean |  | Plan-group members merge in one CAS or not at all. |
| `groupSize` | integer \| null |  | 1–100 |
| `landMode` | "atomic" \| "incremental" |  | A stack lands as one unit or one by one. |
| `incidentPlanId` | string \| null |  | max 64 chars |

```text
enqueue({ changeId: "<changeId>", priority: "normal" })
```

**Returns:** `changeId` (string), `admitted` (boolean), `state` (string), `position` (number), `track` (string | null), `etaSeconds` (number), `predictedPassProbability` (number), `reason` (string), `nextSteps` (object[]).

## `queue_status`

State, track, batch, position, ETA, the Changes it waits on and why (e.g. "waiting on conflicting Change X in track 2"), and for an ejected Change the reason with fix.call.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts queue-status`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |

```text
queue_status({ changeId: "<changeId>" })
```

**Returns:** `queued` (boolean), `status` (object | null), `nextSteps` (object[]).

## `wait_for_merge`

Long-polls until the Change merges, is ejected or dequeued, or the queue freezes (timeoutSec ≤ 55). Prefer this to polling; call again while reason is "timeout".

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts wait-for-merge`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `timeoutSec` | integer |  | Default 50 (your MCP client times out at 60 s). Call again while reason is "timeout". 1–55 |

```text
wait_for_merge({ changeId: "<changeId>" })
```

**Returns:** `reason` ("merged" | "ejected" | "dequeued" | "frozen" | "timeout" | "not-queued"), `frozen` (boolean), `status` (object | null), `nextSteps` (object[]).

## `dequeue`

Removes your Change from the merge queue (stack dependents leave with it). A Change that is landing right now leaves after its CAS settles.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts dequeue`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |

```text
dequeue({ changeId: "<changeId>" })
```

**Returns:** `removed` (boolean), `status` (object | null).

## `reprioritize`

Sets the priority class (normal, security, incident). The incident class needs a human or an approved incident Plan (incidentPlanId); reverts are prioritized automatically.

**Scope:** `change:create` · **Kind:** mutating (retry safely with `idempotencyKey`) · **CLI:** `gittifacts reprioritize`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `changeId` | string | yes | max 64 chars |
| `priority` | "normal" \| "security" \| "incident" | yes |  |
| `incidentPlanId` | string \| null |  | An approved incident Plan (required for the incident class unless you are human). max 64 chars |

```text
reprioritize({ changeId: "<changeId>", priority: "normal" })
```

**Returns:** `status` (object | null).

## `queue_overview`

Tracks (independent parallel queues) with their speculative batches, the landing pipeline, freeze state, throughput, p50/p95 time in queue, quarantined tests and every entry with its reason and ETA.

**Scope:** `repo:read` · **Kind:** read-only · **CLI:** `gittifacts queue-overview`

| Argument | Type | Required | Notes |
| --- | --- | --- | --- |
| `repoId` | string | yes | max 64 chars |

```text
queue_overview({ repoId: "<repoId>" })
```

**Returns:** `repoId` (string), `mainSha` (string), `frozen` (boolean), `freezeReasons` (object[]), `halted` ({ code, message, at } | null), `tracks` (object[]), `landing` (object[]), `entries` (object[]), `waiting` (number), `resolving` (number), `throughputPerHour` (number), `timeInQueueMs` ({ p50, p95 }), `ciDurationMs` (number), `quarantined` (string[]), `flakeRates` (object).
