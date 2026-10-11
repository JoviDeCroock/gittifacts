---
title: "HTTP API: plans and claims"
nav: "HTTP: plans and claims"
description: "HTTP endpoints for plans (draft, approve, reject, withdraw, attempts and the pick) and claiming an unclaimed project."
order: 33
audience: both
generated: true
---

# HTTP API: plans and claims

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## plans

### `POST /api/v1/plans`

Draft a plan (intent, acceptance criteria, scope)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `PlanDraftInput { repoId, title, intent, acceptanceCriteria, outOfScope?, riskDeclarations?, scopePaths?, affectedRoutes?, supersedes? }`
- **201:** `{ plan: Plan }`
- **Errors:** 400, 401, 403, 404, 409

### `GET /api/v1/plans/{planId}`

A plan and the changes that implement it

- **Auth:** session cookie or bearer token
- **Parameters:** `planId` (path, required)
- **200:** `{ plan: Plan, changes, principals: PrincipalsMap }`
- **Errors:** 401, 403, 404

### `POST /api/v1/plans/{planId}/approve`

Approve a draft plan (human, plan:approve, not the author); signs the approval

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `planId` (path, required)
- **Body:** `{ comment? }`
- **200:** `{ plan: Plan }`
- **Errors:** 400, 401, 403, 404, 409

### `GET /api/v1/plans/{planId}/attempts`

Every change attempting this plan, ranked by evidence and lane, with the recommended one

Several agents may attempt the same approved plan. Ranked best first by: finished and green before the rest (still grading never ranks above finished), lane, tests, CI, red/green proof, scope drift, coverage, mutation, public API, diff size (smaller wins), time to green. Anything not measured ranks below measured. `recommended` is the best finished green attempt (provisional when nothing has finished). The newest 20 changes on the plan.

- **Auth:** session cookie or bearer token
- **Parameters:** `planId` (path, required)
- **200:** `Attempts { attempts, recommended, summary, planId, picked }`
- **Errors:** 401, 403, 404

### `POST /api/v1/plans/{planId}/attempts/{changeId}/pick`

Pick one attempt (human, change:review, not its author): approves it, closes the others

Approves the change through the normal review path (binds to `headSha`, or the current head; the change must be awaiting review, or already approved) and closes every other open change on the plan as superseded; their agents' wait_for_change answers `superseded`. One pick per plan (409 `already-picked`); the plan must be approved. Audited as `plan.attempt-picked` and `change.superseded`.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `planId` (path, required), `changeId` (path, required)
- **Body:** `{ headSha?, comment? }`
- **200:** `AttemptPicked { planId, picked: AttemptPick, change: Change, approved, superseded, notClosed }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `POST /api/v1/plans/{planId}/reject`

Reject a draft plan (human maintainer or owner; the author may withdraw)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `planId` (path, required)
- **Body:** `{ comment }`
- **200:** `{ plan: Plan }`
- **Errors:** 400, 401, 403, 404, 409

### `POST /api/v1/plans/{planId}/withdraw`

Withdraw a draft plan you drafted (its author only, agents included)

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `planId` (path, required)
- **Body:** `{ reason? }`
- **200:** `{ plan: Plan }`
- **Errors:** 400, 401, 403, 404, 409

### `GET /api/v1/repos/{repoId}/plans`

Plans of a repo, newest first

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ plans }`
- **Errors:** 401, 403, 404

## claims

### `GET /api/v1/claims/{token}`

An unclaimed project behind a claim link: name, creator, expiry, what claiming does

- **Auth:** none
- **Parameters:** `token` (path, required)
- **200:** `ClaimView { status, project, createdBy, claimedBy, claimedAt, claiming, limits, turnstile, viewer }`
- **Errors:** 404

### `POST /api/v1/claims/{token}`

Claim an unclaimed project (signed-in human + Turnstile); single-use, idempotent

The human becomes the owner, the project stops expiring and its unclaimed limits are lifted; the agent that created it is now owned by the human (same scopes). Retrying as the same human returns `alreadyClaimed: true`; anyone else gets 409. 403 `turnstile-failed` when the check did not pass, 410 when the project expired.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `token` (path, required)
- **Body:** `{ turnstileToken }`
- **200:** `ClaimResult { status, project, ownerId, claimedAt, alreadyClaimed, next }`
- **Errors:** 400, 401, 403, 404, 409
