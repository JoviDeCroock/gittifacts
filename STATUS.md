# Status

_Last updated: 2026-10-04_

Specs:
- `docs/prompts/01-platform.md`: platform, M1–M5
- `docs/prompts/02-onboarding.md`: agent onboarding, O1–O6
- `docs/prompts/03-merge-queue.md`: agent-native merge queue, Q1–Q6
- `docs/prompts/04-integrations.md`: external integrations (deploy platforms connect to gittifacts)

## Milestones
| Milestone | State |
|---|---|
| M1 Vertical slice | **integrated, passes locally** (workerd vertical slice: MCP start_change → push event → ChangeWorkflow → CI → evidence → lane); `wrangler deploy --dry-run` + sandbox image build pass; deploy pending a `wrangler login` refresh, then `scripts/e2e/m1.ts` |
| M2 Evidence | **acceptance passes locally**: sandbox e2e, real red/green on a seeded bug fix, attestation verified with the standalone CLI |
| M3 Classifier + tour | **acceptance passes locally**: all 9 fixtures classify exactly, and the breaking-api tour puts `formatMoney` as its riskiest stop |
| M4 Merge, rollout, revert | **acceptance passes live** (`scripts/e2e/m4.ts`, 2026-10-03 run 8 on 3b4b4d6: deploy trains, one Flagship app per project, Workers Issues webhook + Workers Logs poll): a Change that throws for 40% of traffic behind its flag is detected 23.9 s after its first error (by the poll; the Issues webhook came 4 s later, and it won runs 5 and 7 at 27-30 s); flag off 0.1 s and rollback 1.1 s after detection; a verified pure revert opened 6.8 s after detection, auto-merged (Lane 0, judge skipped) 81.5 s later and deployed. The project Worker binds only its own Flagship app. The in-plan `GET /version` is Lane 1 with no judge concern. No human acts after the review |
| M5 Mutation, transforms, screenshots, dogfood | mutation + transforms done in the sandbox; screenshots pending; **dogfood live (2026-10-03)**: this repo imported by push as project `gittifacts` (`4okfnz50jaf0xzzt4uiu`), a monorepo pipeline adopted through its own Lane 2 Change, six agent Changes (2 after requested changes) planned, gated, toured, reviewed and merged by the queue, then cherry-picked to GitHub (canonical until cut-over). Fixed on the way: fork copies (Artifacts forks of large repos answered 500), pipeline adoption, queue replays without blobs, a dropped build stalling the queue 90 min, evidence logs with `:`. Open: evidence costs 13–17 min per Change; pre-existing failures put every Change in Lane 2; CI step attempts lost to `WorkflowInternalError`. Report: `docs/dogfood/m5-2026-10-03.md` |
| M5 follow-up: CI engine + evidence (dogfood frictions 5–7, 10, 17–18) | **built and tested locally, deploy pending**: durable CI steps (Runner `start` + long `poll` ≤30 s, retries re-attach to the running job instead of restarting; heartbeat alarm; sandbox/queue/detect jobs too); evidence runs only the tests that reach the Change (`@app/affected` targets incl. Workers pools; whole suite when impact is unknown) and records `selection`; failures identical on the base commit (confirmed twice, same signature) are `preExisting` and don't count (`tests.preexisting`, only with a usable baseline of the Change's base; else every failure counts); red/green no longer blocked by an identical pre-existing failure; base results cached per Change + base; mutation of untested code is a measured `mutation.no-coverage`; ANSI stripped from reasons, notes and served step logs; live run steps (queued/running + elapsed) in the API; classifier property tests 120 s budget; ci-engine's 3 unhandled rejections fixed. Open: user steps failing on main still count; a shared (cross-Change) main baseline needs a job that never runs head code; a Runner DO restart (deploy) still loses the process; `signal.error.public-api` from unmeasurable fixture packages unchanged (needs a decision). DECISIONS 2026-10-03 |
| O1 Front door + templates | **acceptance passes locally** (workerd, fakes): front door discovery, `create_project` per template → initial commit → bootstrap CI → preview through the gateway with banner → `evidence_ready`; TTFG metrics + dashboard; live check after deploy (docs/deploy.md) |
| O2 Ergonomics | errors with `fix`, idempotency, `wait_for_change`, `whoami` done; CLI built, served by the platform as an npm tarball (`npx -y https://<host>/cli/gittifacts.tgz`; not on npm yet) |
| O3 Claimable projects + abuse limits | **live** (creation flag on, verified with the CLI, 2026-10-02); **built and tested locally** (workerd): credential-less `create_project` (MCP + HTTP) → unclaimed project + token + claimUrl; claim flow (`/claim/<token>`, Turnstile, single-use, idempotent); TTL expiry cron; quotas (CI minutes per project/IP/global, storage, Artifacts ops, open Changes, previews, workspaces); IP/ASN/global creation limits; per-token limits; kill switch (Flagship + D1 override, fail closed); every limit has a test. Configuration: Flagship flag `unclaimed-creation-enabled`, Turnstile widget keys, `PLATFORM_ADMINS` (docs/deploy.md) |
| O4 Delegated auth (MCP OAuth, device flow) | **built and tested locally**: MCP OAuth (code + PKCE S256, CIMD, RFC 8707 audience), device flow, per-session agent principals with repo scoping, consent/device/sessions screens; deploy pending |
| O5 Import detection + remote workspaces | **built and tested locally**: `gittifacts-runner detect` + `inspectRepo`, `propose_platform_config` (Plan + Lane 2 Change via a system workspace), `open_workspace` + `ws_*` on a Workspace DO (blobless fork checkout, idle sleep, TTL, quotas, registries-only egress); remote-only acceptance test over MCP passes; live: `scripts/e2e/remote-workspace.ts` after deploy |
| O6 Onboarding eval | planned |
| Integrations (deploy platforms) | **built and tested locally** (workerd, mock deploy platform): developer portal (register, hashed client secrets with rotation, sealed webhook secrets), OAuth install on the O4 authorization server (`gtic_` clients, client_secret_basic/post or public, PKCE S256, audience `<origin>/api`, install screen with repo picker → installation + `integration` principal, `gti_`/`gtir_` rotating tokens), read-only `/git/<owner>/<repo>.git` proxy (receive-pack refused), signed webhooks through `WEBHOOK_QUEUE` (retries, delivery log, redeliver), deployments API (preview → signed `preview` evidence, production → rollout timeline), UI (Settings → Integrations, developer portal, delivery log, `/integrations/install`), guide in `packages/docs/content/guides/integrations/`. Needs before going live: migration 0008, queues `gittifacts-webhooks` + `gittifacts-webhooks-dlq` (docs/deploy.md). Not yet: a `checks:write` endpoint |
| Q1–Q6 Merge queue | **Q1 integrated, passes locally**: the MergeQueue DO is the agent-native queue (SQLite outbox loop around the pure core, InvariantViolation halts), scratch-repo batch trees, BatchRunWorkflow on CiEngine (fail fast), CAS on main (stale old-oid → retry), refs/queue GC; resolver + approval binding; deploy trains in the DO; MCP/HTTP queue API + SSE; web queue view. Tests: Q1 over fakes (speculation, bisection, CAS-stale, resolver through the ChangeWorkflow, re-approval, main never red), workerd (real DO + BatchRunWorkflow, platform HTTP + MCP). Live: `scripts/e2e/merge-queue.ts` after deploy. Simulator: every gate passes except gate-200 p95 (20.8/18.7/20.0 min vs 20 on seeds 1–3; direct carrying, early landing, result cache — DECISIONS 2026-10-02) |
| Two modes M1 (core + host adapters) | **done, passes locally**: `@app/host` (HostAdapter, capabilities + explicit degradations, ChangeRef, normalized events, LaneVerdict), `@app/core` (`gradeChange`, which the ChangeWorkflow now runs with durable stages, same step names), `@app/host-artifacts` (native adapter), `@app/host-contract` (9 scenarios; native 10/10). GitHub adapter: M2 |
| Two modes M2 (GitHub App, shadow grading) | **live on ReSynapse/fixture-lib 2026-10-03** (installation 167500140, allowlisted): linked 15:08Z; PRs graded with the full evidence and a `gittifacts/lane` run; time-to-grade 158–193 s (target 120 s missed; the tour is 56–87 s of it, DECISIONS "live, part 2"); unrecorded installations adopted from GitHub instead of dropped; fixtures carry a lockfile, red-green proven live. Live contract 2026-10-04: 5/6 pass, codemod-rename computed Lane 1 (judge unsure on a transform Plan; stop-and-ask); lane in 95–117 s, graded median 128 s. Earlier: App credentials sealed under `GITHUB_APP_KEK`, manifest flow (`/settings/github`), install verification, `/github/webhooks` (per-App HMAC, dedupe, queue, redelivery cron). `@app/host-github` (App JWT, per-job scoped tokens, write-gate DO ≤80/min ≤500/h, ETag REST, normalize, GitHubHost, GithubSync); Artifacts mirror per repo (`ghm-*`); ChangeWorkflow on a HostAdapter via FlowDeps; `gittifacts/lane` shadow check run; MCP/CLI `github: "owner/repo#123"`; UI. Contract suite on recorded fixtures 10/10 (same expectations as native, every commit in Actions); workerd end-to-end test. Next: test org → time-to-grade, nightly live contract run (`github-live.yml`) |
| Two modes M3 (tours in GitHub + Plans) | **verified live on fixture-lib PR #2 (2026-10-03)**: tour review with inline stops, summary edited in place, stale + minimized review after a push, author self-approval refused; check-run buttons verified (author's Approve refused; author's full-review request fixed and recorded); a second writer's approval untested. Earlier: the tour as one COMMENT review per head (≤20 inline stops; older reviews staled + minimized), one summary comment edited only on change, PR writes on once the installation is linked (per-repo off switch), one approval record from GitHub reviews / check-run buttons / the platform (humans with write access, never the author), Plans from labelled closing issues (signed), plan files and PR-body refs, re-grading on edits, plan labels and plan approval. Contract suite: `approval-binds-to-head` + published tour (native 16/16, GitHub 11/11, host-github 39 tests) |
| GitHub PR presentation (quiet by default) | **live 2026-10-04 (0bc3081), measured on fixture-lib #10**: by default only the `gittifacts/lane` check run and one summary comment, edited in place (a push posts nothing new: 0 notifications, was 1; first push 1, was 2); summary = 3–5 line headline + `<details>`, optional QA section for on-demand QA; inline stops (≤ 3: risk, not covered, not proven) only with the `gittifacts:walkthrough` label or Request full review, minimized (not rewritten) on a new head; check-run title = lane + one reason (≤ 60), detail folded in `text`, verdict as hidden JSON (old table still read); the lane published in the open run after classify (in progress, never Lane 0; live: lane at 147 s / 106 s, graded at 164 s / 124 s on the first / second push; conversation 557 → 53 words unfolded, 11 → 2 things). Terms from `host-github/src/terms.ts`. DECISIONS 2026-10-04 |
| App home `/dashboard` + first-run checklist | **live (2026-10-03, 33603889)**; a brand-new account measured sign-up → first green check + preview through "Try it now" in 57.6 s desktop / 57.4 s phone (create → green 54 s; journey 13): `/` is always the landing page (nav: "Open dashboard" when signed in, one session check), the app home is `/dashboard`; sign-in/up without `next` lands there, signed-out app routes go to `/signin?next=`, sign-out goes to `/`; getting-started checklist (connect your agent, try it now, bring a repo) ticked from `GET /api/v1/me/getting-started`. DECISIONS 2026-10-03 |
| Docs rework (onboarding paths) | **live 2026-10-03 (1cfca4f)**: docs home "pick your path" (agent, 2-minute CLI, move from GitHub, connect GitHub; reviewers' hub), glossary; 5 getting-started pages as You'll have → 3-5 steps → Next; splits `use-the-cli`, `import-a-private-repo`, `register-github-app`, `approve-a-plan`; guides grouped; word budget in `@app/docs check` (400/700). Re-measured live: agent 49 s, CLI 61 s (no account), import 107 s; GitHub path not timed (allowlist). Audit: `docs/ux-review/docs-audit-2026-10-03.md` |
| User-facing terms (2026-10-04) | **built and tested locally, deploy pending**: lanes by name with the Lane N badge (Auto-merge · Quick review · Full review) from `@app/domain/vocabulary` in the web app, landing, CLI, `/start`, llms.txt, AGENTS.md templates, MCP descriptions and the review notification; calibrating / report-only instead of shadow mode; walkthrough; repo (`create_project` returns `repoId`, `projectId` deprecated); push token; first Change; actor; switch off; deploy batch; docs glossary + `BANNED_TERMS` in the docs check. GitHub PR text: `host-github/src/terms.ts`. DECISIONS 2026-10-04 |
| E2E regression testing (2026-10-04) | **built and tested, on branch `e2e-testing` (merge to main pending the owner; the deploy wiring and the scheduled workflows take effect once it is on main)** (`docs/testing.md`). Tier 1, in `deploy-gate.yml` on every deploy: generated artifacts fresh; browser and HTTP E2E (42 tests, desktop and phone, about 15 s of tests) against the real Worker served by `wrangler dev --local` with the integration fakes, including agent push → walkthrough → approve through the real pipeline. Tier 2, after every `deploy-clean.sh` deploy: `post-deploy-smoke.yml` (health and deployed commit, front door, E2E sign-in, anonymous create_project → first green and a preview within 120 s, webhook 401), with automatic rollback and a `deploy-rollback` issue. Tier 3: `e2e-nightly.yml` (m1, remote workspace, merge queue, CLI and MCP journeys nightly; m4 and import weekly). Found and fixed two production bugs (sign-in `next` lost, plan card overflow). Waiting for approval: repo secrets for the E2E account and the rollback token, and the staging resources. DECISIONS 2026-10-04 |
| Agentic QA on request (2026-10-04) | **built and tested locally, deploy pending**: Run QA (Change page, MCP `request_qa`/`get_qa`, CLI `gittifacts qa`, GitHub `run_qa` button and `/gittifacts qa`) → QaRunWorkflow boots the head as a private `q-` preview (no public address; Browser Run's requests answered by the Worker) → plan / run / repair / review loop on the default model → signed `qa-run` item, classifier gate `qa` (fail → Lane 2, couldn't test → 1, never lowers) → Change page section, `qa-finished` notification, GitHub summary QA section + check run, signed 72 h thumbnails. Tests: `@app/qa` 13, classifier qa 7, host-github qa 3, CLI qa 3, workerd integration 3, E2E gate spec (1280 + 390). Design docs/research/agentic-qa.md, guide `guides/ask-for-qa`. Open: the App's Issue comment event for `/gittifacts qa` |

- **Product gap (2026-10-04): import-by-push has no UI.** A private repo can only come in by push, and only a
  signed-in human can open the import (`POST /api/v1/projects {"importMode":"push"}` with a browser session); the
  app has no button for it, so a person can't bring a private repo in from the app. Scheduled by the coordinator.

## What works (tested)
| Package | What it does | Tests |
|---|---|---|
| `@app/evidence` | canonical JSON, Ed25519 attestations, git-notes, pure producers, standalone verify CLI; conflict-resolution + quarantine items | 318 |
| `@app/classifier` | pure lanes, 104 reason codes, shadow agreement, `neverLower` lane floor | 452 |
| `@app/gitwire` | git smart-HTTP client for Workers; live-verified on Artifacts (CAS, notes, cross-repo transfer) | 58 |
| `@app/ci-engine` | Workflows + `ctx.container` engine, hermetic global cache, egress gateway, opt-in `@cloudflare/ci` adapter | 150 |
| `@app/coordinator` | ChangeCoordinator DO, ChangeWorkflow, MergeQueue DO, RolloutWorkflow, PushRouter, Cloudflare adapters, fakes | 152 |
| `@app/tour` | reviewer agent; AI binding + gateway clients; budget; risk-ordered, evidence-anchored tours; conflict-resolution stop | 116 |
| `@app/resolver` | merge-queue conflict resolver (`system:resolver`): verified patches, mechanical scope, ejections with fixes; 14-case conflict corpus | 68 |
| `@app/conventions` | `AGENTS.md`, `/start`, `/llms.txt`, MCP discovery, fix hints, next steps, `.platform` generators; `TOOL_NAMES` = the live MCP tools | 265 |
| `@app/mcp` | 28 tools (incl. `create_project`, workspaces, merge queue, `search_tools`) on mcp-tada-server, typed client, contract snapshot, examples validated against schemas | 50 |
| `apps/platform` | the one Worker: Hono API + OpenAPI, better-auth, D1, AuditLog DO, MCP, SSE, Ports per role wiring the coordinator, CI engine (Runner container) and reviewer; front door, `create_project`, preview gateway + PreviewHost container, TTFG metrics; M1 and O1 integration tests | 116 |
| `apps/sandbox` | `gittifacts-runner` (plan, policy, evidence ×9, diff, preview) and its container image | 57, incl. 9-fixture e2e |
| `@app/web` | 9 screens, mock backend, 45 screenshots in `docs/screenshots/` | 35 |

Repo access (membership): `repo_members` with reader < reviewer < maintainer < owner, one chokepoint in
`apps/platform/src/access/` used by `requirePrincipal` (every route's repo/plan/change param, body and audit subject),
the services, listings (repos, capabilities, audit, consent picker, principals), blobs, SSE, the MCP backend and the
coordinator facade (`RepoAccess` port). Non-members get 404; unclaimed projects have no members (nobody reviews or
approves them until claimed); claiming makes the claimer owner; `PLATFORM_AUDITORS` read everything, write nothing.
Membership API + `list_members` + web repo → Members. Deploy needs migration 0009 (backfills owners).
Tests: `apps/platform/test/access*.test.ts`, `test/integration/access-claim.test.ts`, coordinator `repo-access`.

Also: `templates/` (4 templates, CI path 5–8 s each) and `fixtures/` (9 change fixtures, verified end to end).

Landing page: `/` serves a prerendered marketing page to visitors without a session (the app to signed-in
people, the machine guide to agents); `packages/web/landing.html` + `src/landing/`, HTML+CSS ~22 KB gzip,
screenshots in `docs/screenshots/landing-*`, tests in `packages/web/test/landing.test.ts` and
`apps/platform/test/front-door.test.ts`.

CLI: `deploy:prepare` packs `packages/cli` (`pack:assets`) into the static assets; `/cli/gittifacts.tgz` (+ `gittifacts-<version>.tgz`,
`latest.json`) is served as `application/gzip` by `routes/cli.ts`. `/start`, `/llms.txt`, AGENTS.md, the device-flow hint and the
web app say `npx -y https://<host>/cli/gittifacts.tgz --host https://<host> …`.

Docs: `/docs` serves task-first documentation built by `packages/docs` (get started, concepts, 18 guides plus the
integrations guide, 21 generated reference pages, security model) as HTML in the product's design system, markdown
twins (`.md` or `Accept: text/markdown`) and `/docs/llms-full.txt`. Linked from `/start`, `/llms.txt`, the landing
footer and the app shell. `pnpm --filter @app/docs check` gates links, samples, generated pages and style; screenshots
in `docs/screenshots/docs-*`.

## Live infrastructure (see docs/deploy.md)
- Artifacts namespace `gittifacts-eu` (EU)
- D1 `gittifacts` (EU)
- R2 `gittifacts-blobs` (EU)
- AI Gateway `gittifacts`
- Flagship app `gittifacts-changes`
- DNS `*.preview.resynapse.dev`, the preview gateway target

## Live, verified on the deployed platform (2026-10-02)
- **Deploy:** https://gittifacts.decroockjovi.workers.dev with secrets set and D1 migrations applied. Every deploy
  goes through `scripts/deploy-clean.sh` (origin/main from a clean worktree).
- **Front door:** `/start`, `/llms.txt`, `/openapi.json`, OAuth/MCP discovery and the server card all serve.
- **`create_project` (CLI → MCP):** an Artifacts repo with the template commit, a bootstrap change, real container
  CI and a preview. Time-to-first-green was 48 s, then 36 s with a warm plan cache. The first-ever run took ~6 min
  because of the container image cold start.
- **M1 live:** clone fork → push → CI (cached install, lint/typecheck/test/build) → 7 evidence steps → 9-10
  signed items, verified with the platform key. About 50 s from push to evidence, with test results and logs
  returned through MCP.
- **Lane + tour:** the LLM judge and the classifier route the change to Lane 1 (no plan). A 5-stop tour comes from
  Kimi K2.7 Code (Workers AI via AI Gateway) at $0.015 per change.
- **Previews:** `p-<change>-pv.resynapse.dev` serves the container preview with valid TLS, the banner and
  hardened headers. `/cdn-cgi` is blocked, and the zone's other subdomains are untouched.
- **M4 live** (`scripts/e2e/m4.ts`, run 8 on 3b4b4d6, project `u55e2x3pjdfpdtbimy4o`, deploy trains, 2026-10-03).
  - Setup: a human created a `workers-api` project. The agent's Lane-2 rollout policy change (stages 50/100,
    2-minute stages, 3-minute watch) was approved by the human and merged by the agent-native queue.
  - The human set the deploy target, which created the project's own Flagship app (`gf-<repoId>`).
  - The agent drafted the `GET /version` plan, and the human approved it. The change came out Lane 1: the judge
    answered `no-concern` to all three questions, and Lane 0 is off for the repo. It became the first deploy.
    `cf workers versions get` shows that both deployed versions bind `FLAGS` to the project's app and nothing else.
  - The bad Change made `/?n=…` throw 2 in 5 times behind `isChangeEnabled` (Lane 2: `llm.concern`, no plan).
    After human approval it merged and deployed as train t2 at 50/50.
  - From there, with no human (t = 0 at the merge):
    - t2 deployed +154.3 s and the first 5xx came +161.7 s;
    - the Workers Logs poll detected the regression +185.6 s, 23.9 s after the first error. The Workers Issues
      webhook arrived 27.9 s after the first occurrence, 4 s after the poll;
    - flag off +0.1 s, rollback +1.1 s and revert `rv-…` opened +6.8 s after detection.
  - The revert was verified pure with an identical tree, so the judge was skipped. It merged on its own in Lane 0
    81.5 s after it opened, then deployed.
  - After the rollback: 0/186 5xx, and `/version` serves the previous version again. The audit chain verifies.
    The Worker and its Flagship app were deleted.
  - In runs 5 and 7 the webhook won: it was attributed 30.3 s and 27.1 s after the first occurrence, before the
    next poll.
  - Run 7 found a gap. A platform deploy landed 2 s before the regression, and the revert's Artifacts fork stuck
    "in progress". The revert was never opened, and the dropped command told no one. Stuck forks are now deleted
    and forked again, and a revert that can't be opened is escalated to a human (DECISIONS 2026-10-03).
- **Fixed by dogfooding:**
  - the deployments API rejects the `workers/triggered_by` annotation (10210), so every split and rollback failed;
  - a deploy train whose deploy failed held its Worker forever (now `TrainDeployFailed`, not re-queued);
  - generated `.platform/ci.ts` never uploaded the `bundle` artifact (rollouts were always skipped);
  - telemetry filtered versions with `in`, whose value must be a scalar (now grouped by version);
  - the route auto-merged any verified revert, even one the classifier held in Lane 2; the LLM judge flagged a
    revert's own diff (now skipped only for tree-identical verified reverts);
  - container label keys must be ≤ 16 bytes;
  - previews needed first-level hosts for TLS;
  - the `test-run` evidence step was missing;
  - screenshot R2 puts needed a known length;
  - third-party models fail through the binding without credits, so the reviewer now uses Workers AI;
  - CI plans are now cached by `ci.ts` content.

## Mocked / not yet real
- Workers Issues webhooks are not wired for project Workers (no Notifications destination, policy or automation per
  script). Rollout health polls Workers Logs telemetry every 30 s instead.
- One Flagship app serves every project, so project code can read (not write) other projects' change flags.

## Next
0. M5 dogfood follow-ups (docs/dogfood/m5-2026-10-03.md §5): only new failures count (tests.failing, red/green, the
   queue); scope evidence to affected packages; CI steps that start a job and poll it instead of one long DO RPC;
   a CI re-run tool; automate the GitHub → mirror sync.
1. Deploy (`pnpm --filter @app/platform deploy`, docs/deploy.md) → seed template caches → `scripts/e2e/m1.ts` → O1 live check (time-to-first-green) → M4 live e2e.
2. O1 `create_project` + preview gateway; O3 claimable projects and abuse limits; O5; O6 eval loop.
3. Merge queue Q1–Q6: DO shell + BatchRunWorkflow around the pure core, MCP tools, queue UI, deploy trains.
4. **Final phase (requested):** large-scale dogfooding of everything, a large-scale UI/UX review, and recorded videos of
   every journey for review.
