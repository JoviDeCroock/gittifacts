---
title: "HTTP API: projects, repos and plans"
nav: "HTTP: repos and plans"
description: "HTTP endpoints for create_project, repos, Lane 0, deploy targets, members, plans and claims."
order: 32
audience: both
generated: true
---

# HTTP API: projects, repos and plans

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## projects

### `POST /api/v1/projects`

Create a project in one call: repo + .platform/* + AGENTS.md + first CI + first preview

Template (workers-api, preact-app, ts-library, static-site), import (`from`: a public https git URL), import by push (`importMode: "push"`: private repos; a signed-in human owner gets an empty project and a one-time `importGrant`, closed at the first push, the first Change or after 30 minutes) or empty. Returns at once; CI and the preview finish in the background (wait on `bootstrapChangeId`). Not stored by the idempotency middleware (the response holds a push grant): the key is forwarded, so a retry with the same Idempotency-Key returns the same project with a fresh grant.

**No credentials needed**: without an Authorization header (and while the kill switch allows it) you get an *unclaimed* project, `token` (a Bearer token for that project only, valid until it expires) and `claimUrl` for a human. Unclaimed projects expire unless claimed and have hard limits (see /start). 429 `rate-limited` per IP, network or platform-wide; 503 `creation-disabled` when switched off. Without credentials an Idempotency-Key must be at least 16 characters.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `{ name?, template?, from?, description?, importMode? }`
- **201:** `ProjectCreated { repoId?, projectId, name, template, defaultBranch, remote, token, mcpUrl, previewUrl, claimUrl, bootstrapChangeId, nextSteps, importGrant? }`
- **Errors:** 400, 401, 403, 409, 429, 502, 503

## repos

### `GET /api/v1/repos`

Repos with lane counts and shadow-mode stats

- **Auth:** session cookie or bearer token
- **200:** `{ repos }`
- **Errors:** 401, 403

### `POST /api/v1/repos`

Create a repo, or import one from a public https git URL

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `{ name, importFrom?, defaultBranch?, template? }`
- **201:** `{ repo: Repo }`
- **Errors:** 400, 401, 403, 409, 502

### `GET /api/v1/repos/{repoId}`

A repo with shadow-mode stats and lane counts

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ repo: Repo, shadow: ShadowStats, counts: LaneCounts }`
- **Errors:** 401, 403, 404

### `PATCH /api/v1/repos/{repoId}/deploy-target`

Set or clear the Worker merged Changes roll out to (human repo admin, claimed projects)

The Worker is `gf-<repoId>-<script>` in the platform's account (namespaced, so a project can never target the platform's own Worker or another project's). The first rollout creates it with a workers.dev URL. 403 `unclaimed-limit` for unclaimed projects.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `{ script }`
- **200:** `{ repo: Repo, script }`
- **Errors:** 400, 401, 403, 404

### `GET /api/v1/repos/{repoId}/import-grant`

The project's import-by-push grant (state only, never the token)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ grant: ImportGrantStatus }`
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/import-grant`

Open a new import-by-push grant for a project that has no default branch yet

Human owners only. A live grant is closed (its token revoked) first. 409 `already-imported` once the default branch exists: from then on only the merge queue writes it.

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **201:** `{ grant, status: ImportGrantStatus }`
- **Errors:** 401, 403, 404, 409, 502, 503

### `DELETE /api/v1/repos/{repoId}/import-grant`

Close the import-by-push grant now (revokes its token)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ grant: ImportGrantStatus }`
- **Errors:** 401, 403, 404

### `PATCH /api/v1/repos/{repoId}/lane0`

Turn Lane 0 (auto-merge) on or off

409 (threshold-not-met) unless the shadow-mode agreement threshold is met.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `{ enabled }`
- **200:** `{ repo: Repo }`
- **Errors:** 400, 401, 403, 404, 409, 502

### `GET /api/v1/repos/{repoId}/platform-config`

The repo's latest .platform proposal (null when none was made)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ proposal }`
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/platform-config`

Propose .platform/ci.ts, .platform/policy.ts and AGENTS.md from import detection

Runs detection in a sandbox on the default branch and opens a draft Plan (authored by the platform, every doubt listed as a risk) plus a Change with the files on a fork. Lane 2: a human approves both; nothing is applied silently. Idempotent per default-branch commit unless `rerun`.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `{ rerun?, waitSec? }`
- **202:** `{ proposal: PlatformConfigProposal }`
- **Errors:** 400, 401, 403, 404, 409, 502

## members

### `GET /api/v1/repos/{repoId}/members`

A repo's members and their roles (anyone who can read the repo)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ repoId, members, viewerRole, canManage }`
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/members`

Add a member by e-mail or principal id, or change a member's role (human owner)

Only humans are members (agents act with their owner's role). 409 when the change would leave the repo without an owner.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required)
- **Body:** `{ email?, principalId?, role }`
- **200:** `{ member: RepoMember }`
- **Errors:** 400, 401, 403, 404, 409

### `DELETE /api/v1/repos/{repoId}/members/{principalId}`

Remove a member (human owner), or leave the repo (your own principal id)

409 when it would leave the repo without an owner.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required), `principalId` (path, required)
- **200:** `{ removed, principalId }`
- **Errors:** 401, 403, 404, 409

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
