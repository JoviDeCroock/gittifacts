# Deploy

## Cloudflare resources (account `c8a74ade336909a754b36a7379edca30`)

| Resource | Name | Id / notes |
|---|---|---|
| Artifacts namespace | `gittifacts-eu` | jurisdiction `eu` |
| D1 | `gittifacts` | `832e640d-ef87-482c-a20e-b0aa2df1e065`, jurisdiction `eu` |
| R2 | `gittifacts-blobs` | jurisdiction `eu` (binding needs `"jurisdiction": "eu"`) |
| AI Gateway | `gittifacts` | logs on, no cache |
| Flagship app | `gittifacts-changes` | `a829ecb3-7b1d-4640-9117-77d6fff4ca5d` |

Created with the `cf` CLI on 2026-10-01.

## Credentials

Wrangler's OAuth token on this machine is missing the `artifacts:write`, `flagship:write` and `browser:write` scopes.
Run `wrangler login` again before deploying. The `cf` CLI token has all of these scopes.

## Secrets (`wrangler secret put <NAME>`)

`PLATFORM_SIGNING_KEY`, `BETTER_AUTH_SECRET`, `ISSUES_WEBHOOK_SECRET`, `CF_API_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
Optional: `AI_GATEWAY_TOKEN` (HTTP fallback for the reviewer when the `AI` binding fails).
`CF_ACCOUNT_ID` is a plain var in `wrangler.jsonc`; don't also put it as a secret.

`CF_API_TOKEN` needs Workers Scripts Edit (versions and deployments for rollouts), Flagship Edit, Workers
Observability Read (telemetry) and Account Analytics Read (the time-to-first-green dashboard queries the Analytics
Engine SQL API; without it `/internal/ttfg` falls back to D1). Artifacts goes through the binding, so the token needs
no Artifacts permission.

## Deploy the platform Worker

Needs Docker running locally: wrangler builds `apps/sandbox/Dockerfile` (the CI runner image, ~690 MB) and pushes it
to the Cloudflare registry for the `Runner` container.

```sh
pnpm --filter @app/platform db:migrate:remote     # D1 migrations first
pnpm --filter @app/platform deploy:dry-run        # builds web + sandbox bundle, bundles the Worker, builds the image
pnpm --filter @app/platform deploy                # same, then uploads; registers the push trigger
```

`deploy:prepare` also regenerates `apps/platform/src/generated/templates.ts` from `templates/` (bundle-templates).
Migration `0006_onboarding_previews_ttfg` adds the `previews` and `project_onboarding` tables.

`deploy` creates the four Workflows (`change-workflow`, `rollout-workflow`, `push-router`, `ci-run-workflow`), the
`runner` and `preview` container applications (`scheduling_policy: durable_object`, both built from
`apps/sandbox/Dockerfile`), the `*-pv.resynapse.dev/*` route on the `resynapse.dev` zone (DNS: the proxied wildcard `*.resynapse.dev`; previous
`*.preview` AAAA `100::` record) and the `cf.artifacts.repo.pushed` trigger
(namespace `gittifacts-eu` → `push-router`).

## M1 live check

```sh
pnpm tsx scripts/e2e/m1.ts --url https://gittifacts.<subdomain>.workers.dev --token gtf_…
```

The agent token comes from `POST /api/v1/principals/agents` (signed in as a human) or the web UI. The repo needs at
least one commit on its default branch, and `POST /api/v1/repos { name }` creates an empty one (only the merge queue
writes main). Until `create_project` seeds templates, import one instead:
`POST /api/v1/repos { "name": "m1", "importFrom": "https://github.com/<owner>/<public-repo>" }`.

## After a deploy: warm the template caches

The first project per template should not pay a cold `pnpm install`. Once per template change (the seed repos are
named by content digest, so a re-run reuses them), as a human with repo:admin:

```sh
curl -X POST -H "Cookie: better-auth.session_token=…" https://gittifacts.<subdomain>.workers.dev/api/v1/admin/seed-cache
# one template: …/api/v1/admin/seed-cache?template=workers-api
```

It creates `seed-<template>-<digest8>` Artifacts repos and starts one `seedCache` CI run per template; each run
publishes the install snapshot under the global cache key every project from that template computes.

## O1 live check

`create_project({ template: "workers-api" })` over MCP, then `wait_for_change` on `bootstrapChangeId` with
`until: "evidence_ready"`, then open `previewUrl`. `GET /internal/ttfg` (or `/internal/onboarding` in the web app)
shows the measured time to first green.

## O3: claimable projects and abuse limits

Migration `0007_unclaimed_projects` adds `project_claims`, `unclaimed_creations` and `platform_settings`
(`db:migrate:remote` before the deploy). The deploy also adds the `AbuseLimiter` Durable Object class, the
`UNCLAIMED_TOKEN_LIMITER` rate-limit binding (namespace id `4301`, chosen by us; no resource to create) and the
`*/10 * * * *` cron that expires unclaimed projects.

What a human must create or set (nothing below was created by the agent that built O3):

| What | Where | Without it |
|---|---|---|
| Flagship flag `unclaimed-creation-enabled` (boolean, **on**) | app `gittifacts-changes` | The kill switch fails closed: credential-less `create_project` answers 503 `creation-disabled`, and /start + llms.txt say so. |
| Turnstile widget (managed) for the platform hostname(s) | Turnstile dashboard | The claim page uses Cloudflare's always-pass test keys (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`): claiming still needs a signed-in human, but no bot check. |
| `TURNSTILE_SITE_KEY` (var) and `TURNSTILE_SECRET_KEY` (`wrangler secret put`) | Worker | As above. |
| `PLATFORM_ADMINS` (comma-separated principal ids `hu_…` from `GET /api/v1/me`, not e-mails; var or secret) | Worker | Nobody can use `PUT /api/v1/admin/unclaimed-creation` (the D1 override); the Flagship flag stays the only switch. |

Optional: `UNCLAIMED_TTL_DAYS` (default 7, in `wrangler.jsonc`) and `UNCLAIMED_LIMITS` (JSON override of any limit
in `apps/platform/src/limits/config.ts`).

Kill switch, fastest first: set the flag to false in Flagship; or, if Flagship is unreachable,
`curl -X PUT -H 'content-type: application/json' --cookie '<admin session>' <host>/api/v1/admin/unclaimed-creation -d '{"mode":"off"}'`
(`"flag"` clears the override; `"on"` only bridges a Flagship that can't be evaluated).
