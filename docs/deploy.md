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

## Integrations (deploy platforms)

Migration `0008_integrations` adds `integrations`, `integration_secrets`, `installations`, `installation_repos`,
`integration_authorizations`, `webhook_deliveries`, `deployments`, `deployment_statuses` and `account_handles`
(`db:migrate:remote` before the deploy). The deploy also adds the `WEBHOOK_QUEUE` producer + consumer, the
`INTEGRATION_LIMITER` rate-limit binding (namespace id `4302`, chosen by us; nothing to create) and a webhook sweep
on the existing `*/10` cron.

What a human must create (nothing below was created by the agent that built integrations):

| What | How | Without it |
|---|---|---|
| Queue `gittifacts-webhooks` | `wrangler queues create gittifacts-webhooks` | The deploy fails (the binding points at a missing queue). |
| Queue `gittifacts-webhooks-dlq` (dead letters) | `wrangler queues create gittifacts-webhooks-dlq` | The deploy fails (the consumer names it). |
| `BETTER_AUTH_URL` = the public origin (var or secret), if not set already | Worker | Webhook payloads built outside a request (pushes, Change events) use `https://gittifacts.decroockjovi.workers.dev`. |

`BETTER_AUTH_SECRET` also seals webhook secrets (AES-GCM): rotating it makes stored webhook secrets unreadable, and
every integration developer must generate a new one in the developer portal.

## M4 live check (rollout, regression, automatic revert)

```sh
pnpm tsx scripts/e2e/m4.ts --url https://gittifacts.<subdomain>.workers.dev \
  --agent-file agent.json --cookie-jar cookies.txt [--keep]
```

`agent.json` holds `{ "token": "gtf_…" }` (an agent owned by the human); `cookies.txt` is a human session
(`curl -c cookies.txt …/api/auth/sign-in/email`). The script creates a `workers-api` project, merges a faster
rollout policy (human-approved), sets the deploy target, ships `GET /version` (first deploy) and then a Change
that throws for 40% of `/?n=…` requests behind its flag, with a traffic generator running. It asserts that the
platform switches the flag off, rolls back, opens a verified pure revert and that no human acted after the review,
prints the audit timeline with latencies, and deletes the project's Worker (`wrangler delete`) unless `--keep`.

**Project Workers.** `PATCH /api/v1/repos/{repoId}/deploy-target { "script": "api" }` (human repo admin,
claimed projects only) makes rollouts deploy to `gf-<repoId>-api` in the platform's account. The first rollout
creates the script with workers.dev on (`https://gf-<repoId>-api.<account>.workers.dev`), Workers Logs and
Workers Issues on. Every version gets the `FLAGS` (Flagship app `FLAGSHIP_APP_ID`) and `VERSION`
(`version_metadata`) bindings; bundles may declare plain vars only. Delete a project's Worker with
`pnpm --filter @app/platform exec wrangler delete --name gf-<repoId>-<script> --force`.

## O6: signed eval traffic (`EVAL_TRAFFIC_SECRET`)

The onboarding eval's agents reach the platform from Cloudflare's Worker egress (shared addresses, one network),
so a 40-run matrix would exhaust the per-IP (3/hour, 10/day) and per-ASN creation limits of credential-less
`create_project`. The evals Worker signs its agents' platform requests (`x-gittifacts-eval-run: <runId>`,
`x-gittifacts-eval-sig: hex(HMAC-SHA-256(EVAL_TRAFFIC_SECRET, runId))`). When the platform has the same secret and the
signature verifies, the creation limits key on `eval:<runId>` (3 projects per run, `UNCLAIMED_LIMITS.creation.evalRun`)
instead of the IP and ASN; the global caps and everything else (quotas, egress, TTL, no Lane 0, no production) are
unchanged. A missing or wrong signature, or no secret on the platform, means the normal limits.

Generate one value and set it on **both** Workers (never commit or print it):

```sh
openssl rand -hex 32                                                  # ≥ 32 characters; shorter ones are ignored
pnpm --filter @app/platform exec wrangler secret put EVAL_TRAFFIC_SECRET
pnpm --filter @app/evals exec wrangler secret put EVAL_TRAFFIC_SECRET
```

Rotate by setting a new value on both (in-flight runs fall back to the normal limits until the evals Worker has it).
Without it on the platform, eval traffic is limited like anyone else's. Eval-keyed creations are audited
(`project.unclaimed-created` with `creator.evalRun`); unverified signatures go to Workers Logs
(`eval-traffic-unverified`), never to the audit log.
