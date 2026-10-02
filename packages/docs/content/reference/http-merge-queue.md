---
title: "HTTP API: merge queue"
nav: "HTTP: merge queue"
description: "HTTP endpoints for enqueue, status, wait, dequeue, reprioritize, the queue overview, events, freeze and thaw."
order: 34
audience: both
generated: true
---

# HTTP API: merge queue

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## merge-queue

### `GET /api/v1/changes/{changeId}/queue`

A Change's place in the merge queue (state, track, batch, position, ETA, why it waits)

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ status }`
- **Errors:** 401, 403, 404

### `POST /api/v1/changes/{changeId}/queue`

Enqueue options (priority, stack, plan group, land mode); the Change joins on approval

Records the options and answers where the Change stands. It never bypasses review: a Change joins the queue when its workflow admits it (Lane 0 auto-merge, or a human approval); options given earlier apply then. The incident class needs a human or an approved incident Plan.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ priority?, dependsOn?, plangroup?, landTogether?, groupSize?, landMode?, incidentPlanId? }`
- **200:** `{ changeId, admitted, state, position, track, etaSeconds, predictedPassProbability, reason }`
- **Errors:** 400, 401, 403, 404, 409

### `PATCH /api/v1/changes/{changeId}/queue`

Reprioritize a queued Change (incident needs a human or an approved incident Plan)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ priority, incidentPlanId? }`
- **200:** `{ status }`
- **Errors:** 400, 401, 403, 404, 409

### `DELETE /api/v1/changes/{changeId}/queue`

Take a Change out of the merge queue (its stack dependents leave too)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **200:** `{ status, removed }`
- **Errors:** 401, 403, 404, 409

### `GET /api/v1/changes/{changeId}/queue/wait`

Long-poll until the Change merges, is ejected or dequeued, or the queue freezes

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required), `timeoutSec` (query)
- **200:** `{ reason, status, frozen }`
- **Errors:** 401, 403, 404

### `GET /api/v1/repos/{repoId}/queue`

The merge queue: tracks, batches, landing, freeze state, entries with reasons and ETAs

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ repoId, mainSha, frozen, freezeReasons, halted, tracks, landing, entries, waiting, resolving, throughputPerHour, timeInQueueMs, ciDurationMs, quarantined, flakeRates, trains, updatedAt }`
- **Errors:** 401, 403, 404

### `GET /api/v1/repos/{repoId}/queue/events`

The merge queue's events as Server-Sent Events

`text/event-stream`. One `queue` event per §5 event (entered_batch, resolving_conflict, resolution_ready, ejected, merged, deployed, flag_killed, frozen, thawed); `id` is its sequence number: reconnect with `Last-Event-ID` (or `?since=`) to resume. `?changeId=` filters to one Change. Heartbeat comments while quiet; the stream ends after 15 minutes.

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required), `since` (query), `changeId` (query)
- **200:** Event stream
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/queue/freeze`

Freeze the queue: only reverts and incident fixes land (human-signed audit event)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `{ reason }`
- **200:** `{ frozen }`
- **Errors:** 400, 401, 403, 404

### `POST /api/v1/repos/{repoId}/queue/resume`

Resume a queue that halted on an invariant violation (after an operator checked it)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ resumed }`
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/queue/thaw`

Thaw the queue; batches built on the bad main are invalidated (human-signed audit event)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `{ reason }`
- **200:** `{ frozen }`
- **Errors:** 400, 401, 403, 404
