---
title: "HTTP API: GitHub mode"
nav: "HTTP: GitHub"
description: "HTTP endpoints for the GitHub App overview, install verification and the GitHub webhook receiver."
order: 36
audience: both
generated: true
---

# HTTP API: GitHub mode

> Generated from `apps/platform/src/app.ts`, `apps/platform/src/**/routes*.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## github

### `GET /api/v1/github`

GitHub mode: our GitHub App (or which config is missing) and the installations you linked

- **Auth:** session cookie or bearer token
- **200:** `GithubOverview { app: GithubApp, missing, installations, webhookUrl }`
- **Errors:** 401, 403

### `POST /api/v1/github/repos/{repoId}/backtests`

Repo owners: backtest the repository's merged PRs (lanes, later reverts and patches, calibration)

Grades the newest settled merged PRs of the window with the live pipeline (no tours, nothing written to GitHub). One at a time per repo.

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **Body:** `{ days?, maxPrs? }`
- **202:** `{ id, started }`
- **Errors:** 400, 401, 403, 404

### `GET /api/v1/github/repos/{repoId}/backtests/latest`

The repository's latest backtest and its report

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **200:** `{ backtest: GithubBacktest }`
- **Errors:** 401, 403, 404

### `PUT /api/v1/github/repos/{repoId}/pr-writes`

Repo owners: turn the walkthrough review and summary comment on GitHub PRs on or off

The gittifacts/lane check run is always posted. Off: nothing else is written to the repo's pull requests.

- **Auth:** session cookie or bearer token
- **Parameters:** `repoId` (path, required)
- **Body:** `{ value }`
- **200:** `{ repoId, prWrites }`
- **Errors:** 400, 401, 403, 404

### `GET /github/oauth/callback`

User authorization callback: links the installation if it is yours

- **Auth:** none
- **Errors:** 302, 303

### `GET /github/setup`

GitHub redirect after installing an App; verified through user authorization

- **Auth:** none
- **Errors:** 302, 303

### `POST /github/webhooks`

GitHub App webhooks (HMAC-SHA-256 per App, deduplicated by delivery id, queued)

- **Auth:** none
- **Parameters:** `x-github-hook-installation-target-id` (header, required), `x-hub-signature-256` (header, required), `x-github-delivery` (header, required), `x-github-event` (header, required)
- **202:** Queued (or a duplicate delivery, acknowledged)
- **Errors:** 401, 429, 503
