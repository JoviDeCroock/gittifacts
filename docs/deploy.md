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

`PLATFORM_SIGNING_KEY`, `BETTER_AUTH_SECRET`, `ISSUES_WEBHOOK_SECRET`, `CF_API_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
