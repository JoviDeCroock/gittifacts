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

`CF_API_TOKEN` needs Workers Scripts Edit (versions and deployments for rollouts), Flagship Edit and Workers
Observability Read (telemetry). Artifacts goes through the binding, so the token needs no Artifacts permission.

## Deploy the platform Worker

Needs Docker running locally: wrangler builds `apps/sandbox/Dockerfile` (the CI runner image, ~690 MB) and pushes it
to the Cloudflare registry for the `Runner` container.

```sh
pnpm --filter @app/platform db:migrate:remote     # D1 migrations first
pnpm --filter @app/platform deploy:dry-run        # builds web + sandbox bundle, bundles the Worker, builds the image
pnpm --filter @app/platform deploy                # same, then uploads; registers the push trigger
```

`deploy` creates the four Workflows (`change-workflow`, `rollout-workflow`, `push-router`, `ci-run-workflow`), the
`runner` container application (`scheduling_policy: durable_object`) and the `cf.artifacts.repo.pushed` trigger
(namespace `gittifacts-eu` → `push-router`).

## M1 live check

```sh
pnpm tsx scripts/e2e/m1.ts --url https://gittifacts.<subdomain>.workers.dev --token gtf_…
```

The agent token comes from `POST /api/v1/principals/agents` (signed in as a human) or the web UI. The repo needs at
least one commit on its default branch, and `POST /api/v1/repos { name }` creates an empty one (only the merge queue
writes main). Until `create_project` seeds templates, import one instead:
`POST /api/v1/repos { "name": "m1", "importFrom": "https://github.com/<owner>/<public-repo>" }`.
