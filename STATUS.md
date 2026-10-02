# Status

_Last updated: 2026-10-02_

Specs:
- `docs/prompts/01-platform.md`: platform, M1–M5
- `docs/prompts/02-onboarding.md`: agent onboarding, O1–O6
- `docs/prompts/03-merge-queue.md`: agent-native merge queue, Q1–Q6

## Milestones
| Milestone | State |
|---|---|
| M1 Vertical slice | **integrated, passes locally** (workerd vertical slice: MCP start_change → push event → ChangeWorkflow → CI → evidence → lane); `wrangler deploy --dry-run` + sandbox image build pass; deploy pending a `wrangler login` refresh, then `scripts/e2e/m1.ts` |
| M2 Evidence | **acceptance passes locally**: sandbox e2e, real red/green on a seeded bug fix, attestation verified with the standalone CLI |
| M3 Classifier + tour | **acceptance passes locally**: all 9 fixtures classify exactly, and the breaking-api tour puts `formatMoney` as its riskiest stop |
| M4 Merge, rollout, revert | coordinator merge/rollout/revert built (152 tests); live e2e after deploy |
| M5 Mutation, transforms, screenshots, dogfood | mutation + transforms done in the sandbox; screenshots and dogfood pending |
| O1 Front door + templates | **acceptance passes locally** (workerd, fakes): front door discovery, `create_project` per template → initial commit → bootstrap CI → preview through the gateway with banner → `evidence_ready`; TTFG metrics + dashboard; live check after deploy (docs/deploy.md) |
| O2 Ergonomics | errors with `fix`, idempotency, `wait_for_change`, `whoami` done; CLI in progress |
| O3 Claimable projects + abuse limits | **built and tested locally** (workerd): credential-less `create_project` (MCP + HTTP) → unclaimed project + token + claimUrl; claim flow (`/claim/<token>`, Turnstile, single-use, idempotent); TTL expiry cron; quotas (CI minutes per project/IP/global, storage, Artifacts ops, open Changes, previews, workspaces); IP/ASN/global creation limits; per-token limits; kill switch (Flagship + D1 override, fail closed); every limit has a test. Needs before going live: Flagship flag `unclaimed-creation-enabled`, Turnstile widget keys, `PLATFORM_ADMINS` (docs/deploy.md) |
| O4 Delegated auth (MCP OAuth, device flow) | **built and tested locally**: MCP OAuth (code + PKCE S256, CIMD, RFC 8707 audience), device flow, per-session agent principals with repo scoping, consent/device/sessions screens; deploy pending |
| O5 Import detection + remote workspaces | **built and tested locally**: `gittifacts-runner detect` + `inspectRepo`, `propose_platform_config` (Plan + Lane 2 Change via a system workspace), `open_workspace` + `ws_*` on a Workspace DO (blobless fork checkout, idle sleep, TTL, quotas, registries-only egress); remote-only acceptance test over MCP passes; live: `scripts/e2e/remote-workspace.ts` after deploy |
| O6 Onboarding eval | planned |
| Q1–Q6 Merge queue | **Q1 integrated, passes locally**: the MergeQueue DO is the agent-native queue (SQLite outbox loop around the pure core, InvariantViolation halts), scratch-repo batch trees, BatchRunWorkflow on CiEngine (fail fast), CAS on main (stale old-oid → retry), refs/queue GC; resolver + approval binding; deploy trains in the DO; MCP/HTTP queue API + SSE; web queue view. Tests: Q1 over fakes (speculation, bisection, CAS-stale, resolver through the ChangeWorkflow, re-approval, main never red), workerd (real DO + BatchRunWorkflow, platform HTTP + MCP). Live: `scripts/e2e/merge-queue.ts` after deploy. Simulator p95 gate still being tuned (core) |

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
| `@app/conventions` | `AGENTS.md`, `/start`, `/llms.txt`, MCP discovery, fix hints, next steps, `.platform` generators | 226 |
| `@app/mcp` | 27 tools (incl. `create_project`, workspaces, merge queue, `search_tools`) on mcp-tada-server, typed client, contract snapshot | 20 |
| `apps/platform` | the one Worker: Hono API + OpenAPI, better-auth, D1, AuditLog DO, MCP, SSE, Ports per role wiring the coordinator, CI engine (Runner container) and reviewer; front door, `create_project`, preview gateway + PreviewHost container, TTFG metrics; M1 and O1 integration tests | 116 |
| `apps/sandbox` | `gittifacts-runner` (plan, policy, evidence ×9, diff, preview) and its container image | 57, incl. 9-fixture e2e |
| `@app/web` | 9 screens, mock backend, 45 screenshots in `docs/screenshots/` | 35 |

Also: `templates/` (4 templates, CI path 5–8 s each) and `fixtures/` (9 change fixtures, verified end to end).

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
- **Fixed by dogfooding:**
  - container label keys must be ≤ 16 bytes;
  - previews needed first-level hosts for TLS;
  - the `test-run` evidence step was missing;
  - screenshot R2 puts needed a known length;
  - third-party models fail through the binding without credits, so the reviewer now uses Workers AI;
  - CI plans are now cached by `ci.ts` content.

## Mocked / not yet real
- Merge queue (new) not yet wired live; rollout/revert (M4) needs `CF_API_TOKEN` (Versions/Flagship/Observability REST).

## Next
1. Deploy (`pnpm --filter @app/platform deploy`, docs/deploy.md) → seed template caches → `scripts/e2e/m1.ts` → O1 live check (time-to-first-green) → M4 live e2e.
2. O1 `create_project` + preview gateway; O3 claimable projects and abuse limits; O5; O6 eval loop.
3. Merge queue Q1–Q6: DO shell + BatchRunWorkflow around the pure core, MCP tools, queue UI, deploy trains.
4. **Final phase (requested):** large-scale dogfooding of everything, a large-scale UI/UX review, and recorded videos of
   every journey for review.
