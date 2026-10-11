# Testing

How gittifacts keeps regressions away from users: what runs, when it runs, what it covers, and how to
add to it. Owner's rule, 2026-10-04: **E2E > integration >>> unit.**

## The rule for new work

- Every bug fix and every feature lands with an **E2E or integration test that would have caught it**:
  a real journey through the real Worker (browser or agent), or a workerd test with real bindings.
- **Unit tests are for pure logic only**: the classifier, canonical JSON and attestation, diff and
  prose helpers, policy evaluation, and similar. One kind of static check sits with them: the web
  design rules (`packages/web/test/design-rules.test.ts`), which read the stylesheets and fail on a
  broken DESIGN.md rule. Don't add a unit test for behaviour an integration or E2E
  test already covers.
- **Deploys gate on E2E and integration first.** Typecheck and the generated-artifacts check run
  alongside them.
- Assert on **roles, test ids (`data-testid`) and data the test created**. Never assert on copy that
  is being renamed. The shared wording lives in `@app/domain/vocabulary` (`LANE_LABELS`).

## Why

These regressions reached production before this plan existed. The second column says what catches
each one now.

| Escaped regression | Caught by |
|---|---|
| A `db.batch` bug that only showed in workerd | The platform workerd suite, in the gate on every deploy |
| A deploy without Docker | `deploy-clean.sh` starts Docker; the post-deploy smoke then fails on a broken Worker and rolls back |
| A button that did nothing for the PR author | E2E page guard: any uncaught page error or platform 5xx fails the test. Every approve and sign button is clicked through to a server-side check |
| Stale generated docs | `scripts/check-generated.sh` in the gate: docs references, the MCP snapshot, bundled templates and the docs check |
| A flaky fixed-window test that failed the gate | Fixed (bursts that can't straddle a window), plus the flake policy below |

On its first run, the new E2E found two production bugs. Both are fixed in `bb4d371`:

- **A printed `/changes/<id>` link lost its target after sign-in.** `RedirectHome` ran again while the
  target's lazy chunk loaded, and sent the person to the dashboard.
- **The plan's signed-approval card pushed the page sideways** when a name was long.

## Tiers

| Tier | Where it runs | When | What | Runtime |
|---|---|---|---|---|
| **1. Pre-deploy gate** | GitHub Actions, `deploy-gate.yml` | Every deploy (`deploy-clean.sh --gate=ci`), on the exact commit | Job `gate`: generated artifacts fresh, `pnpm -r typecheck`, the web design rules and unit tests (`pnpm --filter @app/web test`: DESIGN.md's named rules and the palette's agent twins against the MCP contract), the platform workerd suite (58 files, 315 tests). Job `e2e`: the browser and HTTP journeys at 1280 and 390 px against the real Worker served locally | `gate` ≈ 8–10 min; `e2e` ≈ 2 min (42 tests in 39 s on a runner, server start included; run 37183803438). The two jobs run in parallel |
| **2. Post-deploy smoke** | GitHub Actions, `post-deploy-smoke.yml` | Right after every `wrangler deploy` (`deploy-clean.sh`), or on demand | Against the live URL: health and the deployed commit, the front door and docs, the E2E account signing in, anonymous `create_project` to first green and a preview within 120 s, the webhook's 401 | ≈ 2–3 min (the agent path takes ≈ 45–80 s) |
| **3. Live journeys** | By hand, `scripts/e2e/nightly.sh` (and `github-live.yml` on Actions) | On demand; the scheduled `e2e-nightly.yml` is off for now (DECISIONS 2026-10-11) | Full live journeys as the E2E account: m1, remote workspace, merge queue with the resolver, the CLI and MCP agent journeys, m4 (rollout regression → auto-revert) and the GitHub import. The GitHub live contract on ReSynapse/fixture-lib (`github-live.yml`, nightly at 03:17) | 5–40 min per suite |
| Contract | GitHub Actions, `host-contract.yml` | Every push that can change a lane | Native and GitHub hosts give the same lane, evidence and walkthrough | ≈ 2 min |

### Tier 1: the hermetic E2E server

`apps/e2e/server/serve.ts` runs `wrangler dev --local` on a config generated from
`apps/platform/wrangler.jsonc` (`server/config.ts`), so new bindings arrive without anyone copying
them over. The entry point is `apps/platform/test/e2e-entry.ts`.

**Real:** the Hono API, better-auth, D1 (migrated from empty on every run), the Durable Objects, the
Workflows (PushRouter → ChangeWorkflow → classify → walkthrough → request review), the queues, R2, the
static assets (web, docs, CLI tarball) and the signing key.

**Fake:** the same fakes the workerd M1 test uses (`apps/platform/test/integration/fakes.ts`):
FakeGitHost for Artifacts (the binding is remote-only), EngineShapedCi for the Runner container, and
FakeReviewer for the model.

**Seeding:** `POST /__e2e/*` (`test/e2e-seed.ts`) seeds data. The routes exist only in the e2e entry,
and they need the run's `E2E_SEED_TOKEN`:

- `seed` writes a review-ready world straight to D1.
- `git/seed`, `git/push` and `ci/finish` play Artifacts and the CI container, so an agent's Change goes
  through the real pipeline over HTTP (`lib/world.ts`, `agentChange`).

Nothing reaches the Cloudflare account. Remote bindings and containers are removed from the
generated config.

### Tier 2: smoke, rollback, and where the rollback runs

`deploy-clean.sh` first re-runs itself from the commit it deploys, so a stale checkout or an
edit in progress can't change what runs. It then deploys with `wrangler deploy --tag <sha12>`. `GET /api/v1/health` returns that tag
as `commit`, and the smoke fails unless it equals the commit just deployed. A missing tag fails the
same way a wrong one does.

Before deploying, the script records the version that was live. If the smoke fails,
`scripts/rollback.sh` rolls back to it, but only while the failed deploy is still the live version,
so it never undoes someone's newer deploy. It then checks that the old version answers.

**Where the rollback runs (decision, 2026-10-04):** in `deploy-clean.sh`, with the operator's
`wrangler login`. The owner chose not to give CI a Cloudflare token. The smoke workflow can also roll
back if a `CLOUDFLARE_API_TOKEN` secret is ever added; then the step in `deploy-clean.sh` does nothing,
because the previous version is already live. The cost of this choice: if this machine dies between the
deploy and the smoke's verdict, nobody rolls back. The issue still gets opened, so a person does it.

Either way, the run fails and an issue labelled `deploy-rollback` is opened.

D1 migrations are not rolled back, so migrations must stay backwards compatible with the previous
Worker version.

## The matrix

Each journey that matters, and the tier that covers it today:

- ✓ covered
- ◐ partly covered
- — not covered

| Journey | Unit | Integration (workerd / contract) | E2E pre-deploy (local Worker) | Smoke (live) | Nightly (live) |
|---|---|---|---|---|---|
| Landing `/`, signed out and signed in ("Open dashboard") | ◐ landing.test (HTML) | ✓ front-door.test | ✓ both widths | ✓ signed out | — |
| Sign-in, `next=` redirects, `/dashboard` home | ◐ nav helpers | ✓ auth.test | ✓ form sign-in, next kept, open redirect refused | ✓ E2E account | ✓ (cookie sign-in) |
| Dashboard and first-run checklist | — | ✓ getting-started.test | ✓ steps from real state | ✓ real data | — |
| Change page: walkthrough, evidence, approve bar | ◐ evidence helpers | ✓ routes.test, m1 | ✓ approve through the real pipeline, checked on the server | — | ✓ m1, mcp-journey |
| Plan approval | — | ✓ plans.test | ✓ read, sign and approve; status checked | — | ✓ m4 (weekly) |
| Merge queue page | ◐ queue helpers | ✓ merge-queue.test | ✓ renders, no error state | — | ✓ merge-queue |
| Merge queue with the resolver | — | ✓ merge-queue.test (fakes) | — | — | ✓ merge-queue |
| Settings: agents (create a token), integrations, developer, GitHub, audit | — | ✓ integrations, github-install, access | ✓ token shown once and listed by the API | — | — |
| Docs home, a getting-started page, `.md` twins, `llms.txt` | ✓ docs build/check | ✓ docs.test | ✓ (+ every listed URL resolves) | ✓ | — |
| `/start`, `/llms.txt`, OpenAPI, MCP card, AI catalog, keys, `/cli` tarball | ✓ conventions | ✓ front-door.test | ✓ markdown for agents, HTML for browsers | ✓ | — |
| Agent over MCP: status, evidence, wait_for_change; agents can't approve | ✓ mcp | ✓ m1, mcp.test | ✓ | ✓ (anonymous) | ✓ m1, mcp-journey |
| Anonymous create_project → first green + preview | — | ✓ unclaimed-create, onboarding | — (kill switch off locally) | ✓ within 120 s | ✓ cli-journey |
| Remote-only agent (workspace) | — | ✓ remote-workspace.test | — | — | ✓ remote-workspace |
| CLI onboarding (`npx …/cli/gittifacts.tgz init`) | ✓ cli | — | ◐ tarball served | ◐ tarball served | ✓ cli-journey |
| GitHub import | — | ✓ import-* | — | — | ✓ import-journey (weekly) |
| GitHub App PR grading | ✓ host-github | ✓ github-*, host-contract | — | ✓ webhook rejects a bad signature | ✓ github-live |
| Rollout regression → auto-revert | ✓ coordinator | ◐ coordinator rollout tests | — | — | ✓ m4 (weekly) |
| Claim an unclaimed project (Turnstile) | ✓ claim helpers | ✓ unclaimed-claim | ◐ unknown claim link renders | — | — (headed only: journey 02) |
| Deployed version is the commit just deployed | — | — | ✓ health | ✓ | — |
| Generated artifacts fresh | ✓ docs/mcp tests | — | ✓ check-generated.sh in the gate | — | — |

**Gaps still open (E2E first):**

- The claim page through Turnstile. Turnstile refuses headless browsers, so this stays a manual
  journey (02).
- The rollout page with real rollout data in the pre-deploy E2E.
- Members, and the OAuth consent and device screens, in a browser.
- A GitHub PR's walkthrough link opened in a browser.

## Running each tier locally

This machine is shared and heavily loaded. Run targeted checks here and leave full suites to Actions.

```sh
# Tier 1, E2E: build what the Worker serves once, then run the suite. Playwright starts the local
# server (or reuses one already running on :8799).
pnpm --filter @app/e2e prepare-assets
pnpm --filter @app/e2e exec playwright install chromium     # once
pnpm --filter @app/e2e gate                                 # both widths
pnpm --filter @app/e2e gate --project=desktop -g "plan"     # one test
pnpm --filter @app/e2e serve                                # just the server, for poking around

# Tier 1, the rest
scripts/check-generated.sh                                  # generated artifacts fresh
cd apps/platform && pnpm exec vitest run test/plans.test.ts --maxWorkers=1

# Tier 2 against any deployment
SMOKE_BASE_URL=https://gittifacts.decroockjovi.workers.dev pnpm --filter @app/e2e smoke
gh workflow run post-deploy-smoke.yml -f url=https://…                       # on Actions
scripts/rollback.sh --url https://… --deployed <id> --to <id> --dry-run     # what a rollback would do

# Tier 3: one suite at a time, as the E2E account (credentials from the environment only)
scripts/e2e/nightly.sh cli-journey
```

## Adding a test

1. **Name the journey a user or agent takes** and find its row in the matrix.
2. **Put it in the cheapest tier that would have caught the bug:**
   - UI, routing, redirects, or anything a person clicks: an E2E spec in `apps/e2e/tests/gate/`.
     Seed with `world` (direct D1) or `agentWork` (the real pipeline).
   - API, storage, Durable Object or Workflow behaviour: a workerd test in `apps/platform/test/`
     with real bindings. Fakes are only for what has no local equivalent (Artifacts, containers, the
     model).
   - Something only production has (real containers, Artifacts, previews, GitHub): a smoke test if
     it's cheap and read-mostly (≤ 5 min in total), otherwise a tier-3 suite in `scripts/e2e/nightly.sh`.
   - Pure logic only: a unit test.
3. **Import `test`/`expect` from `apps/e2e/lib/fixtures.ts`.** That gives you a fresh account, the
   page guard (uncaught errors and 5xx fail the test), quarantine handling, and
   `expectNoHorizontalScroll` for 390 px.
4. **Assert on roles, `data-testid`s and the data you created.** If an element has no stable handle,
   add a `data-testid` to the component in the same commit. When something changes on the server
   (an approval, a token), check it through the API too, not only on screen.
5. **Make the data unique** (`uniqueName`, the fixtures) and **never share it between tests.**

## Flake policy

- **No fixed sleeps.** Use web-first assertions (`expect(locator)…`) or `pollUntil` in
  `apps/e2e/lib/poll.ts`, which polls against a deadline with backoff and gives an error that names
  what it waited for.
- **At most one retry, and it's reported.** CI allows one retry. A test that passes only on its retry
  is marked *flaky* in the job summary (`scripts/e2e-summary.mjs`), never shown as plain green. The
  local runs and the platform workerd suite don't retry.
- **Quarantine needs an owner and an expiry.** Add an entry to `apps/e2e/quarantine.json`:
  `{ "test": "<title substring>", "owner": "<who>", "reason": "<why>", "expires": "YYYY-MM-DD" }`,
  at most 14 days out. A quarantined test is skipped and the summary says why. Once the date passes it
  fails until someone fixes it or re-justifies the entry.
- **Each test gets unique data.** Every test signs up its own account and seeds its own repo, Plan and
  Change. The local server starts from an empty database on every run.
- **Time windows.** Never race a fixed window (rate limits, minute boundaries). Make the test hold
  whichever way the boundary falls. See the burst test in `unclaimed-create.test.ts`.
- **Shared spies.** A `vi.spyOn(globalThis, "fetch")` stub sees other tests' background work. Assert
  only on calls your test owns (filter by its installation or repo id), and restore mocks `afterEach`.

## Secrets in reports

Reports, traces and logs leave the runner as artifacts, so no secret may ever reach them. On
2026-10-04 the E2E account's password leaked into a smoke report's `error-context.md`, which held
the aria snapshot of a sign-in form the test had filled in. Since then:

- **Real accounts sign in through the API only.** `apps/e2e/lib/auth.ts` (`signInWithApi`) calls
  better-auth's sign-in from a private, untraced request context, and only the session cookie
  reaches the browser. No test types a real password into a form. The form itself is tested in the
  gate, with throwaway local accounts.
- **The smoke records no traces and no page snapshots.** It sets `trace: "off"` and
  `PLAYWRIGHT_NO_COPY_PROMPT=1`. Failure screenshots stay: after an API sign-in, no page renders a
  secret.
- **Workflows mask every credential** with `::add-mask::` (smoke, the gate's canary).
- **Every report is scanned before upload.** `scripts/check-report-secrets.mjs` searches every file
  for each secret's value: raw, URL-encoded, JSON-escaped and base64. It also refuses trace archives
  wherever real credentials ran. On a hit it names the file, deletes the report and fails the job, and
  the upload step only runs after a clean scan.
- **A canary proves it in every gate.** `tests/gate/secrets.spec.ts` signs up with a password that is
  random and masked per run, signs in through `signInWithApi`, and attaches the page's aria snapshot,
  HTML and a screenshot. The gate then scans its whole report for that password.
- **If a secret ever leaks:**
  1. Delete the artifacts.
  2. Neutralise the account with its old credentials: revoke its agents' tokens and scramble its
     password with a random value nobody keeps.
  3. Create a new account through normal sign-up and `gh secret set` it without printing it.

## Staging

`gittifacts-staging` (https://gittifacts-staging.decroockjovi.workers.dev) is a second Worker in the
same account. `deploy-clean.sh` deploys every commit there first (`--staging` is the default;
`--no-staging` skips it, and you say why). The post-deploy smoke runs against staging with real
bindings: Artifacts, containers, Workflows, previews, D1, R2 and queues. If it fails, production is not
touched, not even its migrations. Staging catches what the hermetic E2E can't: a binding that only
fails remotely, a container image that doesn't start, or a migration that fails on a real D1.

- **The config is derived, never hand-written.** `scripts/staging/config.ts` generates it from
  `wrangler.jsonc`. Staging gets its own:
  - name, D1 (the id is in that file; it isn't a secret), R2 bucket and four queues;
  - Artifacts namespace, rate-limit namespaces and metrics dataset;
  - container application names (`gittifacts-staging-runner`, `-preview`, `-workspace`). These names
    are account-wide.
- **Previews** run on `p-…-pvs.resynapse.dev`. That's the same zone as production but a disjoint
  first-level pattern, so Universal SSL covers it.
- **GitHub mode and the platform admins are off.** The smoke expects the webhook to answer 503
  `github-not-configured` there.
- **The smoke account.** Staging's database is its own, so it has its own E2E account, created through
  staging's normal sign-up. Its credentials are the secrets `STAGING_E2E_EMAIL`, `STAGING_E2E_PASSWORD`
  and `STAGING_E2E_AGENT_TOKEN`. `post-deploy-smoke.yml` picks them, and `SMOKE_GITHUB=off`, whenever
  the URL is staging.
- **Workflow names are account-wide**, and a deploy reassigns them. So staging's Workflows are
  `gittifacts-staging-*`, and `assertNothingShared` refuses any staging config that reuses one of
  production's names. See the DECISIONS entry of 2026-10-04 for the incident behind this.
- **Setup** (done 2026-10-04): `scripts/staging/setup.sh --yes-i-have-approval`.
- **First end-to-end run** (2026-10-04, dcc09cf): `deploy-clean.sh --gate=ci --staging --smoke=ci`
  took 17 minutes in all.
  1. The gate took 11 min (run 37189534247).
  2. Staging deployed, and its smoke passed. That included the anonymous agent path to first green
     plus a preview on `-pvs`, in ≈ 1.5 min.
  3. Production deployed with the tag `dcc09cf5dcd4`, and its smoke passed (run 37190322943,
     2 min).

  `wrangler workflows list` showed all of production's Workflows still owned by `gittifacts`, both
  before and after.
- **Per deploy:** `scripts/staging/deploy.sh <checkout> <sha12> [--smoke=ci|local|off]`. It needs
  the assets that `deploy:prepare` builds.
- **Cost:** no new plan. Everything is covered by the Workers Paid plan the account already has:
  - D1, Durable Objects, Workflows and Queues usage at staging volumes is a rounding error inside the
    included allowances.
  - R2 storage is cents.
  - Containers bill only while running, about 1–2 container-minutes per smoke.
  - One walkthrough per smoke goes through the AI Gateway.
  - Estimate: well under $5 a month at 10–20 deploys a day.
- **What it shares with production:** the Flagship app (read-only use from staging), the AI Gateway,
  the container image registry and the `resynapse.dev` zone.

## Dead weight (candidates, nothing deleted)

Per the owner's rule, these tests duplicate higher-tier coverage or cost more than they catch. Review
them before deleting anything:

- **The platform suite's per-file D1 setup.** It takes 654 s of setup for 72 s of tests (gate run
  37182471067, 2026-10-04). That isn't a test to delete, but sharing migrated storage between files
  would roughly halve the gate's longest job.
- **`packages/web/test/fixtures.test.ts`** checks the mock-mode demo data. The E2E now exercises the
  real backend, so this guards only the demo.
- **`packages/web/test/consent-copy.test.ts`** (11 tests) and the copy assertions in
  **`landing.test.ts`** assert literal wording that the terminology renames keep changing. Keep the
  structural checks (links agents rely on, the size budget) and drop the copy checks.
- **The happy paths in `packages/coordinator/test/unit/change-workflow.test.ts`** replay the M1
  pipeline on in-memory fakes. The workerd `apps/platform/test/integration/m1.test.ts` and the E2E
  `agentWork` fixture now run the same pipeline on real D1, Durable Objects and Workflows. Keep the
  edge cases (CI timeouts, malformed reports, escalation rules) and drop the happy-path duplicates.
- **`packages/web/test/queue.test.ts` and `queue-stalls.test.ts`** test view helpers that the merge
  queue E2E renders. Keep them only where they cover stall states the E2E doesn't seed.
