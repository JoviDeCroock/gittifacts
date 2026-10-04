# Testing

How gittifacts keeps regressions away from users: what runs, when it runs, what it covers, and how to
add to it. Owner's rule, 2026-10-04: **E2E > integration >>> unit.**

## The rule for new work

- Every bug fix and every feature lands with an **E2E or integration test that would have caught it**:
  a real journey through the real Worker (browser or agent), or a workerd test with real bindings.
- **Unit tests are for pure logic only**: the classifier, canonical JSON and attestation, diff and
  prose helpers, policy evaluation, and similar. Don't add a unit test for behaviour an integration or E2E
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
| **1. Pre-deploy gate** | GitHub Actions, `deploy-gate.yml` | Every deploy (`deploy-clean.sh --gate=ci`), on the exact commit | Job `gate`: generated artifacts fresh, `pnpm -r typecheck`, the platform workerd suite (58 files, 315 tests). Job `e2e`: the browser and HTTP journeys at 1280 and 390 px against the real Worker served locally | `gate` ≈ 8–10 min, `e2e` ≈ 6–8 min (the tests themselves take 15 s; install, build and browser setup take the rest). The two jobs run in parallel |
| **2. Post-deploy smoke** | GitHub Actions, `post-deploy-smoke.yml` | Right after every `wrangler deploy` (`deploy-clean.sh`), or on demand | Against the live URL: health and the deployed commit, the front door and docs, the E2E account signing in, anonymous `create_project` to first green and a preview within 120 s, the webhook's 401 | ≈ 2–3 min (the agent path takes ≈ 45–80 s) |
| **3. Nightly / weekly** | GitHub Actions, `e2e-nightly.yml` (and `github-live.yml`) | Nightly at 03:47 UTC; weekly on Sunday; on demand | Full live journeys as the E2E account: m1, remote workspace, merge queue with the resolver, the CLI and MCP agent journeys; weekly m4 (rollout regression → auto-revert) and the GitHub import. The GitHub live contract on ReSynapse/fixture-lib (`github-live.yml`, 03:17) | 5–40 min per suite, three in parallel |
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

`deploy-clean.sh` deploys with `wrangler deploy --tag <sha12>`. `GET /api/v1/health` returns that tag
as `commit`, and the smoke fails unless it equals the commit just deployed. A missing tag fails the
same way a wrong one does.

Before deploying, the script records the version that was live. If the smoke fails,
`scripts/rollback.sh` rolls back to it, but only while the failed deploy is still the live version,
so it never undoes someone's newer deploy. It then checks that the old version answers.

**Where the rollback runs (decision, 2026-10-04):**

- In the smoke workflow, when the repo has `CLOUDFLARE_API_TOKEN`. The rollback then happens even if
  this machine dies mid-deploy.
- Otherwise in `deploy-clean.sh`, with the operator's `wrangler login`. If the workflow already rolled
  back, this step does nothing.

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
gh workflow run e2e-nightly.yml -f suites=m1,merge-queue
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
     it's cheap and read-mostly (≤ 5 min in total), otherwise a nightly suite.
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

## Staging (recommended; built, not yet created)

A `gittifacts-staging` Worker in the same account, deployed first by `deploy-clean.sh --staging`. The
smoke runs against it with real bindings (Artifacts, containers, Workflows, D1, R2, queues), and a
failure there stops the production deploy. It catches what the hermetic E2E can't, such as a binding
that only fails remotely or a container image that doesn't start, before any user sees it.

- **The config is derived, never hand-written.** `scripts/staging/config.ts` generates it from
  `wrangler.jsonc`. Staging gets its own name, D1, R2 bucket, four queues, Artifacts namespace,
  rate-limit namespaces and metrics dataset. It has no zone routes, so there are no previews on
  `*-pv.resynapse.dev`. GitHub mode and the platform admins are off.
- **Setup:** `scripts/staging/setup.sh --yes-i-have-approval` creates the resources once, with
  generated secrets. **Per deploy:** `scripts/staging/deploy.sh`.
- **Cost:** no new plan. Everything is covered by the Workers Paid plan the account already has:
  - D1, Durable Objects, Workflows and Queues usage at staging volumes is a rounding error inside the
    included allowances.
  - R2 storage is cents.
  - Containers bill only while a staging CI run or preview runs: the smoke's single first-green, about
    1–2 container-minutes per deploy.
  - Model calls through the AI Gateway: one walkthrough per smoke.
  - Estimate: well under $5 a month at 10–20 deploys a day.
- **What it shares with production:** the Flagship app (flags are read-only from staging, but a
  separate Flagship app would be cleaner), the AI Gateway, and the account's container registry.
- **Status:** waiting for the owner to approve the resource list (2026-10-04). Until then,
  `--staging` is off and the smoke runs only against production, with automatic rollback.

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
