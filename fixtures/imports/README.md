# Import fixtures

Standalone repositories for the onboarding flows that start from an **existing** repo
(`create_project({ from: <github url> })`, docs/prompts/02-onboarding.md §3 "Imported repos").
Unlike the change fixtures in `fixtures/<name>/`, each directory here is one whole repository
at one commit: no base/head overlays, no `fixture.json`, and no `.platform/` or `AGENTS.md`
(the platform proposes those as a Plan + Change after the import).

| Fixture | What it is | What an agent should find |
|---|---|---|
| `clock-api` | A Cloudflare Worker (`GET /?offset=<minutes>`), pnpm 11 + vitest + esbuild, `wrangler.jsonc` named `clock-api` | `pnpm test` has **one failing test**: `formatOffset(-210)` returns `-04:30` instead of `-03:30` (`Math.floor` on a negative offset). The fix is one line in `src/clock.ts`; the failing test is already there, so the Change gets red/green proof (fails on base, passes on head). |

Detection expectations for `clock-api` (checked by `apps/sandbox/test/detect.test.ts`):
pnpm (`packageManager: pnpm@11.27.0`, frozen lockfile), vitest, `pnpm run test`,
`pnpm run build`, `tsconfig.json` strict, one Worker `clock-api`, esbuild's install script already
approved in `pnpm-workspace.yaml` (`allowBuilds`), so nothing needs approval.

## Materializing

```sh
pnpm tsx scripts/materialize-import-fixture.ts clock-api              # → fixtures/.materialized/imports/clock-api
pnpm tsx scripts/materialize-import-fixture.ts clock-api --out /tmp/fx
```

The result is a git repository with one deterministic commit on `main`.

## Publishing for the eval (task 2)

Eval task 2 ("Import <fixture GitHub repo> and fix the failing test") needs the fixture at a
**public https URL**, because `Artifacts.import` only imports public remotes. Not done yet:

```sh
# once, with your own GitHub credentials, into an empty public repo:
pnpm tsx scripts/materialize-import-fixture.ts clock-api --push https://github.com/<org>/gittifacts-fixture-clock-api.git
```

Then point the eval at that URL. Re-publishing after an edit here must be a new commit on that
repo (the eval compares against the failing test, not a SHA).
