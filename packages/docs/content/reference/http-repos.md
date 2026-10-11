---
title: "HTTP API: projects, repos and members"
nav: "HTTP: repos and members"
description: "HTTP endpoints for create_project, repos, Lane 0, deploy targets, import grants, members and invites."
order: 32
audience: both
generated: true
---

# HTTP API: projects, repos and members

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## projects

### `POST /api/v1/projects`

Create a project in one call: repo + .platform/* + AGENTS.md + first CI + first preview

Template (workers-api, preact-app, ts-library, static-site), import (`from`: a public https git URL), import by push (`importMode: "push"`: private repos; a signed-in human owner gets an empty project and a one-time `importGrant`, closed at the first push, the first Change or after 30 minutes) or empty. Returns at once; CI and the preview finish in the background (wait on `bootstrapChangeId`). Not stored by the idempotency middleware (the response holds a push grant): the key is forwarded, so a retry with the same Idempotency-Key returns the same project with a fresh grant.

**No credentials needed**: without an Authorization header (and while the kill switch allows it) you get an *unclaimed* project, `token` (a Bearer token for that project only, valid until it expires) and `claimUrl` for a human. Unclaimed projects expire unless claimed and have hard limits (see /start). 429 `rate-limited` per IP, network or platform-wide; 503 `creation-disabled` when switched off. Without credentials an Idempotency-Key must be at least 16 characters.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Body:** `{ name?, template?, from?, description?, importMode? }`
- **201:** `ProjectCreated { repoId?, projectId, name, template, defaultBranch, remote, token, mcpUrl, previewUrl, claimUrl, bootstrapChangeId, samplePlanId?, nextSteps, importGrant? }`
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

### `GET /api/v1/invites/{token}`

What an invite link offers: the repo, the role, who sent it (no sign-in needed)

- **Auth:** none
- **Parameters:** `token` (path, required)
- **200:** `InviteLink { status, repo, role, invitedBy, emailHint, expiresAt, viewer }`
- **Errors:** 404

### `POST /api/v1/invites/{token}/accept`

Accept an invite: a signed-in person whose e-mail is the invited one joins the repo

Needs the link and the invited e-mail. 403 `invite-email-mismatch` for another account; 409 `invite-closed` once used, revoked or expired.

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `token` (path, required)
- **200:** `{ repoId, role, alreadyMember }`
- **Errors:** 401, 403, 404, 409

### `DELETE /api/v1/repos/{repoId}/invites/{inviteId}`

Revoke an open invite (human owner); its link stops working

- **Auth:** session cookie or bearer token
- **Idempotency-Key:** accepted
- **Parameters:** `repoId` (path, required), `inviteId` (path, required)
- **200:** `{ revoked, inviteId }`
- **Errors:** 401, 403, 404

### `GET /api/v1/repos/{repoId}/members`

A repo's members and their roles (anyone who can read the repo)

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ repoId, members, viewerRole, canManage, invites }`
- **Errors:** 401, 403, 404

### `POST /api/v1/repos/{repoId}/members`

Add a member by e-mail or principal id, or change a member's role (human owner)

Only humans are members (agents act with their owner's role). An e-mail no account has verified (nobody signed up with it, or e-mail sign-up, which doesn't prove the address) gets a pending invite (202): `inviteUrl` is shown once, and works once, for a person signed in with that e-mail. 409 when the change would leave the repo without an owner.

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
