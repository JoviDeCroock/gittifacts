# Security audit — 2026-10-11

Pre-open-source review of the whole monorepo: secrets in tree and history, workflows, auth/authz, webhooks and
GitHub mode, CI sandbox and merge queue, MCP/CLI/LLM trust boundaries, web UI, evidence crypto, audit log.
Read-only; nothing was changed. "Verified" = the code path was re-read after the finding was reported.

## Status after the fixes (same day)

| Finding | Status |
|---|---|
| H1 installation link grants every repo | **Fixed**: per-repo grants from the linker's own GitHub access (`github_link_repos`, migration 0024). Memberships granted before the fix are not revoked automatically |
| H2 CLI token follows `.gittifacts.json` | **Fixed**: `packages/cli/src/host-trust.ts` (token only to a trusted host, `mcpUrl` same-origin, no plain http) |
| H3 Lane 0 evidence forgeable | **Partly fixed**: no stdout evidence channel, hardened git, tracked files reset; dependencies/policy evidence can't be forged. **Open**: test-run, red-green, coverage, mutation still run as the author's uid — Lane 0 trusts the author's test environment (SECURITY.md) |
| M1 framing / same-site tenant Workers | **Fixed** (headers on every response, `__Host-` session cookies). A separate domain for tenant Workers remains the stronger fix |
| M2 auth rate limiting | **Fixed** (AUTH/AUTH_EMAIL/OAUTH limiters; authorization rows purged by retention) |
| M3 unverified e-mail member add | **Fixed**: an e-mail resolves to an account only when verified; otherwise a single-use invite (the link is the proof) |
| M4 login-based self-approval | **Fixed** (numeric GitHub user id; old links count as "is the author") |
| M5 shared plan cache | **Fixed** (`v2/<repo>/<sha>`, 7-day TTL) |
| M6 freeze bypass via incident | **Fixed** (only a human's incident class or a revert lands during a freeze) |
| M7 unchecked lockfiles | **Fixed** (lockfile verified against the recorded patch bumps, else Lane 1) |
| M8 conflict resolution drops lines | **Fixed** (`droppedLines`; re-approval when > 0) |
| M9 audit verify DoS | **Fixed** (checkpointed, ≤ 200 entries per read; admin full re-verify) |
| M10 lone surrogate skips audit | **Reproduced and fixed** (refused at the boundary; audit DO never throws on it) |
| M11 Turnstile fails open | **Fixed** (fails closed; `TURNSTILE_TEST_KEYS=1` opt-in) |
| M12 policy separation of duties | **Fixed** (maintainer+, not the authoring agent's owner unless the only human) |
| M13 cookie CSRF | **Fixed** (same-origin guard on cookie-authenticated `/api` mutations) |
| Lows | Fixed: git global config, evidence v2 signs `signedAt`, deployment read check, `redirect_uri`, webhook URL checks, CLI escapes and clone token, eval signature scope, npm-name docs, workflow pinning/permissions/URL allowlist, error text. Open: previews share `resynapse.dev` (infrastructure) |

## Secrets and history: clean

Every unique blob in every ref (791 commits, incl. local checkpoint refs) was scanned. Only test placeholders
(`MII` stub PEM, GitHub's documented example `ghs_16C7…` token, `test-secret-…` strings). No `.dev.vars`, `.env`,
keys or logs were ever committed. Identifiers (not credentials) are public: Cloudflare account id, D1 database id,
admin/auditor principal ids in `apps/platform/wrangler.jsonc`, the `decroockjovi.workers.dev` host, and an old
`.cloudflare/cache/cloudflare-account.json` (account id + name) in `b78911b`, removed in `950f8fb`.

## Findings, ranked

### High

**H1. A GitHub installation link grants every repo in the installation (verified).**
`apps/platform/src/github/callbacks.ts:44-79`, `github/grading.ts:87-112` (`grantLinkedRepos`, `grantInstallationMembers`).
The setup callback only checks the installation appears in the user's `/user/installations` — GitHub lists it for
anyone with read access to *one* repo in it. `grantLinkedRepos` then makes the linker claim-owner of every unclaimed
graded repo of the installation (maintainer otherwise). A read-only outside collaborator on one public repo of an org
gains owner/maintainer on the org's private graded repos (clone mirrors, read diffs, approve Changes, add members).
Fix: grant per repo from `userInstallationRepos(token, id)`, map GitHub permission → role, owner only for
installation-account admins, re-check on `member`/`installation_repositories` events.

**H2. CLI sends the bearer token wherever a committed `.gittifacts.json` points (verified).**
`packages/cli/src/config.ts:80-84` (`mcpUrlFor`), `:66` (`resolveHost`), `:287` (`resolveToken`).
The project file is documented as safe to commit and is read from cwd or any parent. `mcpUrl` is used whenever
`project.host` matches, without checking it is on that host; `GITTIFACTS_TOKEN` is returned for whatever host the
project file names; `http:` is accepted for any host. Running any `gittifacts` command in a hostile checkout (or a
malicious Change's checkout) sends the user's token to the attacker.
Fix: require `new URL(mcpUrl).origin === host` (or drop `mcpUrl`), bind the env token to `--host`/`GITTIFACTS_HOST`
/login host, refuse non-loopback `http:`, warn on first use of an unknown project host.

**H3. Lane 0 evidence can be forged by the code under test (verified).**
`packages/ci-engine/src/runner/runner-do.ts:1288-1305` (`captureEvidence`), `shell.ts:51`.
Evidence steps run the head's own install and test commands as the same uid that can write
`/tmp/gittifacts/evidence.json`; if the file is absent the last `::evidence::` stdout line is accepted. The platform
then signs it. A test/postinstall can print or overwrite perfect coverage/mutation/red-green evidence and, with Lane 0
on, auto-merge with no human. (Sensitive paths, `.platform/**`, migrations and diff size are recomputed in the Worker,
so policy and protected paths are not reachable this way.)
Fix: separate uid + root-owned evidence dir, no stdout fallback; treat container-produced coverage/mutation as
advisory or document that Lane 0 trusts the author's test environment.

### Medium

**M1. User Workers share a site with the platform; no frame/security headers (verified).**
`apps/platform/src/app.ts:63-91`; `packages/coordinator/src/adapters/workers-deployer.ts:204-213` enables
`workers.dev` for every project Worker, so tenant code lives on `*.decroockjovi.workers.dev` — same site as the
platform. Only previews send `frame-ancestors`. A tenant Worker can clickjack `/oauth/consent` or plan approval in a
framed page (Lax cookies are sent same-site) and toss cookies onto the parent domain (login CSRF).
Fix: `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` on all
responses incl. `ASSETS.fetch`; put tenant Workers on a separate registrable domain or the platform on a custom
domain with `__Host-` cookies.

**M2. No rate limiting on sign-in/sign-up, OAuth authorize, device code (verified).**
`apps/platform/src/auth/better-auth.ts:63` disables better-auth limiting in favour of "Cloudflare rules", but the only
`ratelimits` bindings cover unclaimed tokens, integrations and GitHub webhooks, and `workers.dev` has no zone WAF.
`GET /api/oauth/authorize` also inserts an `oauth_requests` row per call that retention never purges.
Fix: a Rate Limiting binding keyed by IP (+email for sign-in) on `/api/auth/*`, `/api/oauth/*`, device routes;
purge expired `oauth_requests`/device codes in `runRetention`.

**M3. Adding a member by e-mail trusts unverified e-mails (verified).**
`apps/platform/src/access/members.ts:111-118` matches `user.email` without `emailVerified`; sign-up does not verify.
An attacker pre-registers `bob@corp.com`; when the owner adds Bob, the attacker gets the role.
Fix: require `emailVerified` (enable verification) or add by principal id / invite link.

**M4. Self-approval guard for GitHub PRs matches by login, which is renamable (verified).**
`apps/platform/src/github/review-hooks.ts:28-36` (`isHostAuthor`), `github/plans.ts:41-51`. An author who renames
their GitHub account approves their own PR on the platform; a re-registered old login is attributed to the old
principal. Fix: store `github_user_id` on the link and compare numeric ids.

**M5. Shared CI plan cache is keyed only on the bytes of `.platform/ci.ts` (verified).**
`packages/coordinator/src/adapters/container-sandbox-jobs.ts:219-228`; R2 `plan-cache/v1/<sha256(ci.ts)>`, shared
across tenants, no expiry. `ci.ts` can import sibling files and `node_modules`, so the plan isn't a function of
`ci.ts` alone: edits to `./steps.ts` are ignored while `ci.ts` is unchanged, and an attacker who commits the same
`ci.ts` text with a malicious `./steps.ts` first poisons the plan another tenant gets.
Fix: key on the bundled module hash plus repo id (or cache per repo) and add a TTL.

**M6. An agent can land during a human freeze by citing any approved Plan as "incident" (verified).**
`packages/coordinator/src/queue/agent-api.ts:119-131` checks only that the Plan is approved and in the same repo.
Fix: require an incident-tagged Plan approved after the freeze, or forbid agent `incident` moves while frozen.

**M7. `dependency-patch` planless Lane 0 never checks lockfile contents (agent-reported).**
`packages/classifier/src/classify.ts:285` skips lockfiles; `packages/tour/src/diff.ts:208-221` hides lockfile hunks
from the judge. A one-line patch bump in `package.json` can ship a rewritten `pnpm-lock.yaml` resolution/integrity
pointing at an attacker tarball, auto-merged. Fix: parse the lockfile diff and require every entry change to match a
recorded patch bump from the registry; otherwise escalate.

**M8. AI conflict resolution keeps the human approval while dropping upstream lines (agent-reported).**
`packages/coordinator/src/queue/resolve.ts:258-292`, `packages/evidence/src/producers/conflicts.ts:221-229,339-398`.
"Novel lines" ignores deletions/reordering, so a resolution that keeps base and drops upstream's `requireAuth()`
counts as 0 novel lines. Fix: require the resolved region to be an in-order merge with nothing removed from either
side, else re-approval for Lane ≥ 1.

**M9. `GET /api/v1/audit` re-verifies the whole chain in the global audit DO (verified).**
`apps/platform/src/services/audit.ts:63-66` → `audit/audit-log-do.ts:145-183`. Any `repo:read` token can poll it;
O(N) Ed25519 verifies block the DO every write goes through. Fix: verified-through checkpoint, incremental checks,
full re-verify as an admin job; rate-limit the route.

**M10. Lone UTF-16 surrogate commits a state change but skips its audit entry (agent-reported, needs a test).**
`packages/evidence/src/canonical.ts:42-45` rejects lone surrogates; plans/changes write D1 first and append audit
second (`apps/platform/src/services/plans.ts:253-256`, `packages/coordinator/src/change-coordinator.ts:155-165`).
Fix: refine request strings with `isWellFormed()` at the boundary; append audit atomically with or before state.

**M11. Turnstile passes everything when `TURNSTILE_SECRET_KEY` is unset (verified).**
`apps/platform/src/claim/turnstile.ts:44-49`. Self-hosters who forget the secret silently lose the human check on
claims. Fix: fail closed unless an explicit dev flag is set.

**M12. Separation of duties on `.platform/**` (agent-reported, design).** A reviewer-role human can approve a policy
change their own agent authored (`packages/coordinator/src/service.ts:713-800`). Consider requiring a non-owner
maintainer+ when `requiresHumanApproval` is set.

**M13. No CSRF/Origin check on cookie-authenticated REST mutations (agent-reported, deployment-dependent).**
Only `/mcp` checks Origin. Body-less POSTs (approve, withdraw, close, revoke…) validate as `{}`. Not exploitable on
the reference deployment (previews on `resynapse.dev`, platform on `workers.dev`), but a self-host on one zone is.
Fix: require same-origin `Origin`/`Sec-Fetch-Site` for non-GET cookie requests; document previews need their own
registrable domain.

### Low

- **Previews share `resynapse.dev`**: preview JS can set `domain=resynapse.dev` cookies for siblings
  (`apps/platform/src/previews/gateway.ts:91-101`). Use a PSL-listed preview domain.
- **Git global config not neutralised** while a write token is in env (`apps/platform/src/workspace/scripts.ts:121-160`,
  ci-engine `shell.ts:73-91`): set `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `-c core.fsmonitor=false`.
- **Evidence `signedAt`/`signer` are unsigned** (`packages/evidence/src/attest.ts`), so retired-key `notAfter` can be
  bypassed by backdating. Sign them; revoke compromised keys instead of setting `notAfter`.
- **`GET /api/v1/deployments/{id}`** has no repo access check (`integrations/deployments.ts:336-352`); ids are random.
- **Integration token exchange** skips `redirect_uri` when absent (`integrations/tokens.ts:303`).
- **Outbound integration webhooks** POST to any https host and store 2 KB of response (`integrations/delivery.ts`).
- **CLI**: terminal escape sequences in `--human` output (`packages/cli/src/human.ts`); login token sent as git auth
  to the Artifacts host on clone fallback (`commands/init.ts:246-251`).
- **Eval HMAC header** sent to every preview host (`apps/evals/src/env.ts:95`).
- **npm name `gittifacts` is unregistered** but docs say `npx gittifacts` will work — squattable once public.
- **Workflows**: no `permissions:` on `deploy-gate.yml`; actions pinned by tag not SHA; E2E secrets go to a free-text
  `url` input (`e2e-nightly.yml`, `post-deploy-smoke.yml`) — allowlist it.
- **Error text**: SSE change-watch sends raw `e.message`; `StoreDataError` exposes R2 key names.
- **Dependencies** (`pnpm audit --prod`): 3 high (extract-zip, basic-ftp via `@cloudflare/puppeteer` browser download,
  not reachable from a Worker), 4 moderate (esbuild via drizzle-kit, qs via stryker).

## Checked and sound

Route table (~100 OpenAPI + raw routes) all behind `requirePrincipal` → `assertRouteAccess` with service-level
re-checks; agent tokens (32 B random, SHA-256 at rest, audience, revocation, scope intersection); OAuth (S256 PKCE,
exact redirect match, single-use codes, refresh rotation with reuse revocation); claim flow; MCP tools mirror HTTP
authz, human-only actions have no MCP tool; LLM "only raise" holds on every traced path (errors/budget/parse
failures escalate, author summary excluded from prompts); classifier escalates on every missing signal; GitHub
webhook HMAC over raw bytes, constant time, delivery dedupe; App JWT/installation tokens scoped per repo and revoked;
gitwire ref/sha validation and bounded pack parsing; policy and pipeline read from base; no eval in the Worker; merge
queue pins the reviewed head and lands by CAS; no platform secrets in containers; deployer can't target other
tenants or the platform; no XSS sinks in the web UI; canonical JSON (RFC 8785) and signature verification; audit
hash chain; parameterised SQL everywhere; workflows have no fork-triggered jobs or `${{ }}` shell interpolation.

## Before flipping the repo public

1. Add `.gittifacts.json` to `.gitignore` (it names the live project and Artifacts remote).
2. Push only `main` (and branches you mean to publish) — never `git push --mirror`: local `refs/t3/*`,
   `refs/codex/*`, `refs/probe`, `refs/stash` are working-tree snapshots.
3. Delete old Actions runs and artifacts (they become public), especially anything before the 2026-10-04 rotation.
4. Register (or remove mentions of) the `gittifacts` npm name.
5. Decide whether the commit author e-mail on all commits is fine to publish.
6. Prune stale remote branches (`ci-durable`, `dx-onboarding`, `hotfix/insert-repo-membership`).
7. Add a `SECURITY.md` with a contact and link this file as known issues for people copying the code.
