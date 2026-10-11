---
title: "HTTP API: changes"
nav: "HTTP: changes"
description: "HTTP endpoints for changes, push tokens, diffs, evidence, tours, reviews, rollouts, the kill switch, blobs and the audit log."
order: 34
audience: both
generated: true
---

# HTTP API: changes

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## changes

### `POST /api/v1/changes`

Start a change: fork the repo and get a push token for the fork only

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `StartChangeInput { repoId, planId?, title, category, summary?, agentTraceId?, paths? }`
- **201:** `{ change: Change, remote: GitRemote, overlaps }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `GET /api/v1/changes/{changeId}`

A change with its plan, pipeline runs and classification for the current head

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ change: Change, plan, runs, classification: ClassifyResult, principals: PrincipalsMap }`
- **Errors:** 401, 403, 404

### `POST /api/v1/changes/{changeId}/close`

Close (abandon) a change that won't merge (author or maintainer)

Stops its CI, takes it out of the merge queue and deletes its fork later. `reason` is audited (`change.abandoned`). Closing a closed change returns it unchanged; a merged change can't be closed (kill it instead).

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ reason? }`
- **200:** `{ change: Change }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `GET /api/v1/changes/{changeId}/diff`

Diff of the current head against the base

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ diff: ChangeDiff }`
- **Errors:** 401, 403, 404

### `GET /api/v1/changes/{changeId}/events`

The change as Server-Sent Events, one `change` event per update

`text/event-stream`. Each `change` event's data is `{ change }` and its id is the change version: reconnect with `Last-Event-ID` (or `?since=`) to resume. Comment lines are heartbeats. The stream ends after 15 minutes or once the change reaches a final status.

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required), `since` (query)
- **200:** Event stream
- **Errors:** 401, 403, 404

### `GET /api/v1/changes/{changeId}/evidence`

Signed evidence for the current head, re-verified against the platform keys

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ evidence: Evidence, verification: Verification }`
- **Errors:** 401, 403, 404

### `GET /api/v1/changes/{changeId}/issues`

Workers Issues attributed to the change (or its rollout version)

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ issues }`
- **Errors:** 401, 403, 404

### `POST /api/v1/changes/{changeId}/kill`

Kill switch: flag off, roll back, open a revert change (human maintainer or owner)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ reason }`
- **200:** `{ change: Change }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `GET /api/v1/changes/{changeId}/overlaps`

Open Changes in the same repo that share this change's Plan or touch the same paths

Compared on the change's diff at its current head (before a push: its Plan's scopePaths) against the changed paths of the newest open Changes. A change with nothing pushed yet is listed when it shares the Plan (`paths-unknown`); any other whose overlap can't be decided is in `unchecked`.

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ changeId, overlaps: OverlapReport }`
- **Errors:** 401, 403, 404

### `GET /api/v1/changes/{changeId}/qa`

The change's QA runs, newest first

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ runs }`
- **Errors:** 401, 403, 404

### `POST /api/v1/changes/{changeId}/qa`

Ask for QA in a browser on the current head (on request only; idempotent per head)

An agent drives the app built from the head in a real browser against the Plan's acceptance criteria, with a screenshot per step, a replay GIF and a pass / fail / couldn't-test verdict per criterion, signed into the evidence. A failure raises the lane; nothing lowers it. Needs green CI on the head; at most 6 runs an hour and 30 a day per repo.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ force?, via? }`
- **202:** `{ run: QaRunView, reused }`
- **Errors:** 400, 401, 403, 404, 409, 429, 502, 503

### `POST /api/v1/changes/{changeId}/request-review`

Ask for a human review of a change (author or its owner): recorded in the audit log, no message is sent; never approves

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ message? }`
- **200:** `{ change: Change, requested }`
- **Errors:** 400, 401, 403, 404, 409

### `POST /api/v1/changes/{changeId}/rerun`

Re-run CI, evidence, lane and walkthrough on the current head (author or maintainer)

No push needed: a fresh workflow instance and CI run for the same head (a flaky step). Only while the change is running, failing or awaiting review; audited as `change.rerun-requested`.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ reason? }`
- **202:** `{ change: Change, headSha, instanceId, superseded }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `GET /api/v1/changes/{changeId}/resolution`

The merge queue's conflict resolution of this change (null when it needed none): what lands, what each side had

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ resolution: Resolution }`
- **Errors:** 401, 403, 404

### `POST /api/v1/changes/{changeId}/review`

Review a change (human, change:review, not the author); binds to a head

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **Body:** `{ decision, humanLane?, comment?, headSha? }`
- **200:** `{ change: Change }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `GET /api/v1/changes/{changeId}/reviews`

Human reviews of a change, oldest first (each bound to a head)

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ reviews, principals: PrincipalsMap }`
- **Errors:** 401, 403, 404

### `GET /api/v1/changes/{changeId}/rollout`

Rollout state and the change's audit timeline

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ rollout: RolloutState, timeline, policy, policySha, principals: PrincipalsMap }`
- **Errors:** 401, 403, 404

### `POST /api/v1/changes/{changeId}/token`

Fresh short-lived push token for the change's fork (author only)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `changeId` (path, required)
- **200:** `{ remote: GitRemote }`
- **Errors:** 401, 403, 404, 409, 502

### `GET /api/v1/changes/{changeId}/tour`

The reviewer agent's walkthrough (tour) for the current head

- **Auth:** session cookie or bearer token
- **Parameters:** `changeId` (path, required)
- **200:** `{ tour: Tour, stale }`
- **Errors:** 401, 403, 404

### `GET /api/v1/repos/{repoId}/changes`

Changes of a repo (with plan title and author), most recently updated first

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required), `status` (query), `lane` (query)
- **200:** `{ changes, principals: PrincipalsMap }`
- **Errors:** 400, 401, 403, 404

## blobs

### `GET /api/v1/blobs/{ref}`

Raw bytes of an R2 reference (logRef, beforeRef, afterRef), authorized by the owning repo

- **Auth:** session cookie or bearer token
- **Parameters:** `ref` (path, required)
- **200:** The object (images, JSON or text; anything else as an attachment)
- **Errors:** 400, 404

## audit

### `GET /api/v1/audit`

Audit log, newest first, with hash-chain verification

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (query), `subject` (query), `actor` (query), `action` (query), `cursor` (query), `limit` (query)
- **200:** `{ events, nextCursor, chain: ChainStatus, principals: PrincipalsMap, subjects: AuditSubjectsMap }`
- **Errors:** 400, 401, 403, 404
