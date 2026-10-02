---
title: Create a project
description: Create a repo from a template, empty, or from an import, with CI, policy, AGENTS.md, a first CI run and a preview in one call.
order: 1
audience: both
---

# Create a project

A project is a repo plus everything the platform needs to run it. `create_project` does all of it in one call and returns before CI finishes.

## 1. Choose a starting point

| Template | What you get | Preview |
|---|---|---|
| `workers-api` | A JSON API on Workers: `GET /` returns `{ now }`, `GET /health`. Vitest, esbuild bundle, deployable | `/`, `/health` |
| `preact-app` | Preact + signals single-page app on Workers static assets, API under `/api/*` | `/`, `/api/time` |
| `ts-library` | An npm library with Vitest and emitted `.d.ts`, so every Change gets a public-API diff | none |
| `static-site` | Plain HTML and CSS on Workers static assets; tests check titles and links | `/`, `/about/` |
| *(none)* | An empty repo with `README.md`, `AGENTS.md` and `.platform/*`; no CI run until you push code | none |

Importing an existing GitHub repo is its own guide: [Migrate from GitHub](/docs/guides/migrate-from-github).

## 2. Create it

Over MCP:

```text
create_project({ template: "preact-app", name: "status-board", description: "Team status board" })
```

From the CLI (writes `.gittifacts.json` and clones):

```sh
gittifacts init --template preact-app --name status-board --clone
```

Over HTTP (an agent token or a session; send an idempotency key so a retry can't create two):

```sh
curl -s https://<host>/api/v1/projects \
  -H "Authorization: Bearer $GITTIFACTS_TOKEN" \
  -H "Idempotency-Key: status-board-1" \
  -H "Content-Type: application/json" \
  -d '{"template":"preact-app","name":"status-board"}'
```

## 3. Check the response

| Field | Use it for |
|---|---|
| `projectId` | The repo id in every later call |
| `bootstrapChangeId` | The Change running the first CI and preview (`null` for an empty project) |
| `remote` | A push grant for your first Change's fork: push there right away |
| `previewUrl` | The bootstrap preview; it shows "Building…" until CI is green |
| `token`, `claimUrl` | Set only for unclaimed projects |
| `nextSteps[]` | The calls to make next |

## 4. Wait for green

```text
wait_for_change({ changeId: "bs-3fk2q8wz7m1x0c5v9nbd", until: "evidence_ready", timeoutSec: 50 })
```

Call it again while `reason` is `"timeout"`. Expected within about a minute: `reached: true`. If CI fails, `get_change_status` names the failing step.

## What's in the repo

| File | Purpose | Edit it? |
|---|---|---|
| `.platform/ci.ts` | The pipeline | Yes, through a Change (Lane 2) |
| `.platform/policy.ts` | Lanes, thresholds, rollout | Yes, through a Change (Lane 2) |
| `AGENTS.md` | How to work on this platform, for any agent that opens the repo | Generated; updated through a Change |
| `template.json` | Template facts (preview command, build output) | Rarely |

Next: [Make a Change](/docs/guides/make-a-change).
