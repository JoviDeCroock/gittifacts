# Status

_Last updated: 2026-10-02_

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
| M4 Merge, rollout, revert | **acceptance passes live** (`scripts/e2e/m4.ts`, 2026-10-02, deploy trains): a Change that throws for 40% of traffic behind its flag is detected 32.5 s after its first error; flag off + rollback within 0.5 s; verified pure revert opened 4.5 s after detection, auto-merged (Lane 0, judge skipped) 77.5 s later and deployed; no human after the review |
| M5 Mutation, transforms, screenshots, dogfood | mutation + transforms done in the sandbox; screenshots and dogfood pending |
| O1 Front door + templates | **acceptance passes locally** (workerd, fakes): front door discovery, `create_project` per template → initial commit → bootstrap CI → preview through the gateway with banner → `evidence_ready`; TTFG metrics + dashboard; live check after deploy (docs/deploy.md) |
| O2 Ergonomics | errors with `fix`, idempotency, `wait_for_change`, `whoami` done; CLI built, served by the platform as an npm tarball (`npx -y https://<host>/cli/gittifacts.tgz`; not on npm yet) |
| O3 Claimable projects + abuse limits | **live** (creation flag on, verified with the CLI, 2026-10-02); **built and tested locally** (workerd): credential-less `create_project` (MCP + HTTP) → unclaimed project + token + claimUrl; claim flow (`/claim/<token>`, Turnstile, single-use, idempotent); TTL expiry cron; quotas (CI minutes per project/IP/global, storage, Artifacts ops, open Changes, previews, workspaces); IP/ASN/global creation limits; per-token limits; kill switch (Flagship + D1 override, fail closed); every limit has a test. Configuration: Flagship flag `unclaimed-creation-enabled`, Turnstile widget keys, `PLATFORM_ADMINS` (docs/deploy.md) |
| O4 Delegated auth (MCP OAuth, device flow) | **built and tested locally**: MCP OAuth (code + PKCE S256, CIMD, RFC 8707 audience), device flow, per-session agent principals with repo scoping, consent/device/sessions screens; deploy pending |
| O5 Import detection + remote workspaces | **built and tested locally**: `gittifacts-runner detect` + `inspectRepo`, `propose_platform_config` (Plan + Lane 2 Change via a system workspace), `open_workspace` + `ws_*` on a Workspace DO (blobless fork checkout, idle sleep, TTL, quotas, registries-only egress); remote-only acceptance test over MCP passes; live: `scripts/e2e/remote-workspace.ts` after deploy |
| O6 Onboarding eval | planned |
| Integrations (deploy platforms) | **built and tested locally** (workerd, mock deploy platform): developer portal (register, hashed client secrets with rotation, sealed webhook secrets), OAuth install on the O4 authorization server (`gtic_` clients, client_secret_basic/post or public, PKCE S256, audience `<origin>/api`, install screen with repo picker → installation + `integration` principal, `gti_`/`gtir_` rotating tokens), read-only `/git/<owner>/<repo>.git` proxy (receive-pack refused), signed webhooks through `WEBHOOK_QUEUE` (retries, delivery log, redeliver), deployments API (preview → signed `preview` evidence, production → rollout timeline), UI (Settings → Integrations, developer portal, delivery log, `/integrations/install`), guide in `packages/docs/content/guides/integrations/`. Needs before going live: migration 0008, queues `gittifacts-webhooks` + `gittifacts-webhooks-dlq` (docs/deploy.md). Not yet: a `checks:write` endpoint |
| Q1–Q6 Merge queue | **Q1 integrated, passes locally**: the MergeQueue DO is the agent-native queue (SQLite outbox loop around the pure core, InvariantViolation halts), scratch-repo batch trees, BatchRunWorkflow on CiEngine (fail fast), CAS on main (stale old-oid → retry), refs/queue GC; resolver + approval binding; deploy trains in the DO; MCP/HTTP queue API + SSE; web queue view. Tests: Q1 over fakes (speculation, bisection, CAS-stale, resolver through the ChangeWorkflow, re-approval, main never red), workerd (real DO + BatchRunWorkflow, platform HTTP + MCP). Live: `scripts/e2e/merge-queue.ts` after deploy. Simulator: every gate passes except gate-200 p95 (20.8/18.7/20.0 min vs 20 on seeds 1–3; direct carrying, early landing, result cache — DECISIONS 2026-10-02) |
| Two modes M1 (core + host adapters) | **done, passes locally**: `@app/host` (HostAdapter, capabilities + explicit degradations, ChangeRef, normalized events, LaneVerdict), `@app/core` (`gradeChange`, which the ChangeWorkflow now runs with durable stages, same step names), `@app/host-artifacts` (native adapter), `@app/host-contract` (9 scenarios; native 10/10). GitHub adapter: M2 |
| Two modes M2 (GitHub App, shadow grading) | **phase A built and tested** (workerd, 17 tests): encrypted App credential store (`GITHUB_APP_KEK`), manifest flow (`/settings/github`, Reader App; Actor App behind `GITHUB_ACTOR_APPS`), install verification through user authorization, `/github/webhooks` (per-App HMAC, dedupe, `gittifacts-github-events` queue). Phase B (grading, check run, contract suite): next |

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
- **M4 live** (`scripts/e2e/m4.ts`, run 4 on ce82c695, project `j0r358cwx6dehxm2bvw5`, deploy trains).
  - Setup: a human created a `workers-api` project. The agent's Lane-2 rollout policy change (stages 50/100,
    2-minute stages, 3-minute watch) was approved by the human and merged by the agent-native queue. The human set
    the deploy target, and `GET /version` became the first deploy, creating `gf-<repoId>-api` on workers.dev with
    logs and Issues on.
  - The bad Change made `/?n=…` throw 2 in 5 times behind `isChangeEnabled`. After human approval it merged and
    deployed as train t2 at 50/50, once t1's 5-minute window ended.
  - From there, with no human (t = 0 at the merge): first 5xx +155.9 s; telemetry regression +188.4 s (32.5 s
    after the first error); flag off +0.0 s, rollback +0.5 s and revert `rv-…` opened +4.5 s after detection.
  - The revert was verified pure with an identical tree, so the judge was skipped. It merged on its own in Lane 0
    77.5 s after it opened, then deployed.
  - After the rollback: 0/177 5xx, and `/version` serves the previous version again. The `regression-detected`
    and `reverted` notifications were sent, the audit chain verifies, and the test Worker was deleted.
  - Run 3 (before the judge fix) passed with the same latencies, within ±2 s.
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
1. Deploy (`pnpm --filter @app/platform deploy`, docs/deploy.md) → seed template caches → `scripts/e2e/m1.ts` → O1 live check (time-to-first-green) → M4 live e2e.
2. O1 `create_project` + preview gateway; O3 claimable projects and abuse limits; O5; O6 eval loop.
3. Merge queue Q1–Q6: DO shell + BatchRunWorkflow around the pure core, MCP tools, queue UI, deploy trains.
4. **Final phase (requested):** large-scale dogfooding of everything, a large-scale UI/UX review, and recorded videos of
   every journey for review.
