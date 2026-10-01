# Decisions

ADR-style log. Newest at the bottom. Format: `## YYYY-MM-DD — title`, then Context / Decision / Consequences.

## 2026-10-01 — Monorepo, pnpm workspaces, TypeScript 6.0, vitest 4

**Context.** TypeScript 7 (native) is out, but our evidence tooling (`.d.ts` API diff, Stryker's
TS checker) needs the JS compiler API, and `@cloudflare/vitest-pool-workers@0.22` peers on vitest ^4.1.

**Decision.** pnpm 11 workspaces, TypeScript 6.0.3 everywhere, vitest 4.1.x. Packages are
source-first (`exports` → `src/index.ts`); bundling happens in the Worker/Vite build.

**Consequences.** One TS toolchain for both platform code and the sandbox's API-diff step.
Revisit TS 7 once the evidence tooling has a stable non-JS API path.

## 2026-10-01 — Evidence items carry an explicit status; added `llm-judgment` item

**Context.** "Unknown → escalate" needs the classifier to separate *measured and fine*,
*not applicable*, and *measurement failed*. The prompt's evidence union has no slot for model judgments.

**Decision.** Every `EvidenceItem` has `status: ok | skipped | error`. Added an `llm-judgment` kind
(scope drift / plan conformance / hidden behavior change) so model signals are signed and audited
with the rest of the evidence. The classifier may only use them to raise a lane.

## 2026-10-01 — Plans declare `scopePaths` and `affectedRoutes`

**Context.** Scope drift ("diff touches files outside the plan") must be decidable without a model.

**Decision.** `Plan.scopePaths` (globs) and `Plan.affectedRoutes` were added to the domain model.
An empty `scopePaths` is "not declared", which counts as unknown, so it blocks Lane 0 but does not by
itself force Lane 2.

## 2026-10-01 — Policy is read from the base branch

**Decision.** The policy that governs a Change is the one in `.platform/policy.ts` on the default
branch at `baseSha`, never the head. A Change that modifies the policy file is always Lane 2 and
needs a human approval from someone other than the author.

## 2026-10-01 — Git writes over raw smart HTTP from the Worker (`@app/gitwire`); containers only for running code

**Context.** Artifacts has no write API: no ref update, merge, or notes endpoint. A live probe confirmed
that a raw `git-receive-pack` request from `fetch` can fast-forward a branch with real compare-and-swap
(`ng … stale ref` on a wrong old SHA), and that it rejects updates whose objects are missing.

**Decision.** Ship a small pure-TS git wire client (`packages/gitwire`): pkt-line, sideband, receive-pack
with report-status, upload-pack v2 fetch, non-delta pack writer, and a notes writer. The Worker uses it
to (a) write `refs/notes/evidence`, (b) transfer a Change's objects from its fork into the main repo
under `refs/merge-queue/<changeId>`, and (c) fast-forward `refs/heads/main` with CAS from the merge-queue
Durable Object. Containers are only for steps that execute repository code (CI, evidence tools) and
for rebases when main moved.

**Consequences.** Merges and notes don't pay a container cold start. "Only the merge queue writes main"
is enforced in one place, the merge-queue DO, which is the only code path that sends a receive-pack
for `refs/heads/<default>`.

## 2026-10-01 — Artifacts namespace `gittifacts-eu` (EU jurisdiction), created explicitly

Implicitly created namespaces are unrestricted and the jurisdiction is immutable, so the platform
namespace is created explicitly with `jurisdiction: "eu"`. Tokens are treated as opaque strings: the
probe got `art_v2_e_…` while the docs show `art_v1_…`.

## 2026-10-01 — `WorkflowsCiEngine` is the default; `CloudflareCiEngine` is an opt-in adapter

**Context.** `@cloudflare/ci@0.2.0` is on npm and needs no allowlist, but it is built on the legacy
`@cloudflare/sandbox@0.12.1` `Sandbox` class (default-policy container). That conflicts with the
"use `ctx.container` only" rule. `HealingAgent` is example code, not part of the package, and the
package doesn't expose restart-from-step.

**Decision.** `CiEngine` has two implementations, chosen by `CI_ENGINE` config:
- `WorkflowsCiEngine` (default): one Workflow step per pipeline step, a `Runner` Durable Object per step
  that drives `ctx.container` (`exec`, `snapshotContainer`), dependent steps start from the parent's
  snapshot, an R2 cache pointer keyed on input blob SHAs, and restart-from-step through
  `instance.restart({ from: { name } })`.
- `CloudflareCiEngine`: a `CIWorkflow` subclass that replays the same `PipelineSpec` through
  `ci.runner()`. It lives at the `@app/ci-engine/cloudflare` subpath and is only wired into a separate
  wrangler environment, so the default deployment never ships a legacy-Sandbox container.

Repo pipeline files (`.platform/ci.ts`) are evaluated *inside the sandbox* in a recording "plan mode"
that turns them into a static DAG. Repo code never runs in the platform Worker.

## 2026-10-01 — `wrangler.jsonc`, not `cloudflare.config.ts`

`cloudflare.config.ts` (beta) can't express the Artifacts push → Workflow trigger (`triggers.events`) or
D1 `migrations_dir`, and `cf` Previews don't support DO-managed containers. We use `wrangler.jsonc` and
use the `cf` CLI only for resource/API commands. Revisit once `cf` config covers triggers.

## 2026-10-01 — `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`)

The pool package has been superseded by `@cloudflare/vitest-plugin` (same `cloudflare:test` API,
including `introspectWorkflowInstance`). Pinned at 1.3.4 with vitest 4.1.

## 2026-10-01 — Preview deploys are uploaded by the platform, not the sandbox

Sandboxes hold no Cloudflare credentials. The sandbox builds the change's Worker bundle
(`wrangler deploy --dry-run --outdir`). The platform uploads it as a version tagged with the change id,
using preview-scoped bindings. Version preview URLs aren't generated for Workers that define Durable
Objects. For those repos, preview evidence is `skipped` with a note, which is an informational signal.

## 2026-10-01 — MCP tools declared with `mcp-tada-server`, typed clients with `mcp-tada`

**Context.** MCP is the main way agents use the platform, and the spec asks for tight tool descriptions
and JSON outputs. `mcp-tada-server@0.2.0` is built on `@modelcontextprotocol/server` v2 (our stack choice).
It declares each tool once with a JSON Schema `inputSchema`/`outputSchema`, types the handler from those
schemas, validates arguments before the handler runs (with a built-in validator: no `eval`, Workers-safe),
and publishes exactly those schemas on `tools/list`. `mcp-tada@0.4.0` derives a fully typed client from
`IntrospectionOf<typeof tools>`, with no codegen round trip.

**Decision.** `packages/mcp` defines every tool with `defineTools` and an `outputSchema`, so agents get typed
`structuredContent`. Handlers still zod-parse into domain types, as defence in depth. The package also
exports a typed client factory (`@app/mcp` → `createPlatformClient`) used by our e2e tests and offered to agent
authors. A committed `tools.introspection.d.ts` snapshot is checked against the deployed server with
`mcp-tada check` in CI, so tool contract drift fails the build.

## 2026-10-01 — Classifier judgment calls

Full table in `packages/classifier/README.md` (93 reason codes, 20 Lane-0 gates). The calls that go beyond the spec:

- **Sensitive paths.** The classifier re-checks the diff against the base `policy.sensitivePaths` itself instead of
  trusting the evidence item alone. Rename/copy sources count for sensitive paths, scope, migrations, `.platform/` and transforms.
- **Skips.** A skipped `public-api` or `coverage` signal is accepted only for docs, image or licence-only diffs (an allow-list).
  A skipped `mutation` signal is never accepted. A docs-only change needs a mutation item with score 1 and zero mutants.
- **Multiple items of one kind.** Any error escalates, the lowest coverage or mutation score wins, and the worst API classification wins.
- **Additions.**
  - `tests.failing` (L2): a test run reports failures while CI says passed.
  - `dependency.lockfile-only` (L1).
  - `transform.mismatch` (L2) applies to any claimed category.
  - Unrecognised runtime values are read as the worst case.
- **Plan approval** counts only with `status=approved`, `approvedBy` set, and approver ≠ author.
- **`dependency-patch` planless Lane 0** needs at least one patch bump, may only modify manifests and lockfiles, and each
  manifest's line churn is bounded by its recorded bumps, so script edits can't ride along.
- **Verified reverts.** Waived reasons stay visible as `revert.waived` (L0). The result is lane 0 and not shadowed.
- **Size.** Files fully reproduced by a verified transform don't count towards the line or file thresholds.
- **`blocked`** only covers CI failure, or evidence that is present but unverified. `requiresHumanApproval` is also set when
  diff stats are missing, because a policy change can't be ruled out.
- **Known limit.** Detaching a plan from a change would turn `scope.drift` (L2) into L1, so `Change.planId` is immutable
  once set. The API never allows changing it.

## 2026-10-01 — Reproducible transforms run the BASE copy of the transform script

A codemod added in the same change it claims to reproduce proves nothing: it could just write out head's files.
The platform runs `.platform/transforms/<name>` **from the base tree** against a clean base checkout and compares
the result byte-for-byte with head. A change that adds or edits a transform script touches `.platform/**`, which makes
it Lane 2 with a human approval. Once that script is on main, later changes can use it to reach Lane 0.

## 2026-10-01 — Evidence package semantics

- **Document signatures.** These sign `{document, purpose}`, so a plan-approval signature can't be replayed as an
  audit-entry or evidence signature.
- **Raw-input verification.** `verifyEvidence` verifies over the raw input, so fields injected after signing are caught.
- **Notes.** The last complete JSON document in a note wins. An appended forgery fails verification instead of falling
  back to an older valid document.
- **Unsigned fields.** `signedAt`, `signer` and `keyId` are not covered by the signature (the payload is exactly
  `{changeId, headSha, items}`, per the spec). A leaked retired key could therefore backdate a signature past its
  `notAfter`. Planned v2 note format: bind them.
- **Fail closed.** Producers emit `error` items for an empty coverage report, an unparseable manifest, an unknown
  mutant status or a bad glob. Changed files missing from a coverage report are listed as `unmeasuredFiles` instead of
  silently counting as non-executable.
- **Semver.** 0.x follows npm caret rules, so 0.2 → 0.3 counts as "major".
- **Policy globs.** These are gitignore-style: a pattern without `/` matches at any depth, and matching a directory
  matches everything under it.

**Resolved:** a mutation run with no mutants on changed lines is `skipped`. The classifier accepts that skip (`signal.skip-accepted.mutation`, L0) only for docs, image or licence-only diffs; anywhere else a skipped mutation run still counts as missing (L1).

## 2026-10-01 — Previews run in our containers behind a preview gateway on `*.preview.resynapse.dev` (user decision)

**Context.** Onboarding requires previews of untrusted code: unclaimed projects, on a separate, clearly marked domain,
with a banner on HTML responses and egress restricted. The account has no Workers for Platforms access ($25/month
add-on), and plain Worker scripts on workers.dev can't get a banner injected or their egress restricted.

**Decision (the user chose this option).**
- **Hosting.** Each preview runs the project's built Worker under workerd (`wrangler dev`) inside a `ctx.container`
  sandbox, started from the CI build snapshot.
- **Gateway.** A separate `preview-gateway` Worker owns `*.preview.resynapse.dev/*` and maps `<previewId>.preview.resynapse.dev`
  to a `PreviewHost` Durable Object. That DO proxies to the container port with `getTcpPort().fetch`.
- **Banner and egress.** The gateway injects the banner with HTMLRewriter, and the container's outbound HTTP is
  intercepted (`interceptAllOutboundHttp`) and checked against an allowlist.
- **No direct exposure.** Containers have no public hostname, so a preview can't be reached without the banner.
- **Idle and lifetime.** Previews sleep when idle (cold start of a few seconds) and expire with their Change, or after
  the unclaimed project's TTL.

**Consequences.** No extra spend, and previews match the abuse-limit requirements. The preview runtime is workerd in a
container rather than the edge runtime, so production-only behaviour can differ. Production rollout (claimed projects
with a deploy target) still uses real Worker versions and gradual deployments.

## 2026-10-01 — Onboarding plan (docs/prompts/02-onboarding.md)

Work order:
1. Core platform M1–M4 integration together with O1 (front door, templates, `create_project`, `AGENTS.md`) and
   O2 (fix-hint errors, idempotency, `wait_for_change`, `whoami`, CLI).
2. Deploy.
3. O3 (claimable projects + abuse limits), O4 (MCP OAuth + device flow), O5 (import detection + remote workspaces).
4. O6 eval loop and dogfooding.

`projectId` is the repo id: a project is a repo plus its preview, claim state and quotas. One source of truth
(`packages/conventions`) generates `AGENTS.md`, `/start`, `/llms.txt` and the `nextSteps` texts.

## 2026-10-01 — Reviewer agent (`@app/tour`) choices

- **Planless judgments.** With no plan, the judge marks the plan-conformance questions `skipped` (not `unsure`), so planless
  Lane-0 categories stay possible. A `concern` still raises the lane.
- **Gateway 429.** A gateway HTTP 429 counts as budget exceeded: spend-limit and rate-limit 429s are indistinguishable,
  and treating it as exceeded escalates.
- **Cost estimate.** Cost is tokens × a price table for the routed model. Unknown models are charged at the most
  expensive known price (a conservative estimate).
- **Readability.** `estimatedReadSeconds` is words/180 wpm + 3 s per stop, carried in a wrapper around the domain `Tour`.
  With the Lane-1 caps (450 words, 7 stops) the worst case is 171 s, under the 3-minute target.
- **Riskiest stop.** When the top-ranked hunk is anchored to a Lane-2 reason, the first `risk` stop must reference it.
  Post-processing moves the model's stop up, or inserts a deterministic one. That makes the M3 acceptance
  (breaking export first) a guarantee rather than a hope.
- **Author summary.** The prompt input types have no field for the author's summary; only id, title and SHAs are
  copied from the Change.

## 2026-10-01 — CI engine: hermetic global cache, egress gateway, per-step tokens

- **Global cache, hermetic steps.**
  - Install-like root steps default to `cacheScope: "global"`. The key is image, command, cwd, env and input blob SHAs;
    the repo is left out.
  - Global steps run *hermetically*, with only their cache-input files in `/workspace`. A shared snapshot therefore never
    contains another repo's source or `.git`, and a repo can't poison a shared entry through files outside the inputs.
  - If the hermetic run fails, the step falls back to a repo-scoped run.
  - `cache.global` is `read-write | read-only | off` per run; unclaimed projects get `read-only`.
  - `seedCache(template)` pre-publishes template installs, which is what the 60-second time-to-first-green target needs.
- **Egress.** `network: "registries-only"` starts containers with internet off and sends every HTTP(S) request
  through a `CiEgressGateway` Worker entrypoint (`interceptAllOutboundHttp` + `interceptOutboundHttps("*")`).
  - Allowed: GET/HEAD to the npm/yarn registries and codeload.github.com, plus git fetch (not push) to the repo's own
    git host. Everything else gets a 403 and a log line.
  - It needs Cloudflare's interception CA, which goes in via `NODE_EXTRA_CA_CERTS`; non-Node tools with their own CA
    bundles fail closed.
  - The `@cloudflare/ci` engine refuses `registries-only`, so unclaimed projects always use `WorkflowsCiEngine`.
- **Tokens.** Each Runner step mints its own 15-minute read token. Tokens never sit in Workflow state, where they could
  outlive `restartFrom`.
- **Retries and cancellation.** A non-zero exit is not retried; only infrastructure errors are. `cancel()` terminates
  the Workflow and aborts every Runner DO, because terminating the Workflow alone leaves containers running.
- **Plan-mode inference** is exact for sequential awaits, fan-out/fan-in and chaining. Interleaved independent chains
  inside one `Promise.all` may gain extra ordering edges, which costs parallelism but never correctness.

## 2026-10-01 — Coordinator choices

- **Write roles.** `Ports` are built per role (`default | merge-queue`). Only the merge-queue role's `GitHost` may write main
  repos. Main-repo write tokens live ≤ 300 s and are never returned.
- **Policy and plan from BASE.** Both `.platform/policy.ts` and `.platform/ci.ts` are read at BASE. If policy evaluation
  fails, the change gets `policy-unavailable`, which raises it to at least Lane 1. A policy file can force Lane 0 off but
  can never turn it on: only the owner's `setLane0` toggle (gated by shadow agreement) does that.
- **Rebased merges.** `rebasedFrom` is not part of the signed evidence payload, which stays fixed at
  `{changeId, headSha, items}`. The link is recorded as a separately signed document (purpose `evidence-rebase`) in the audit log.
- **Merge conflicts.** These reach the ChangeWorkflow by polling (30-minute rounds). The queue marks the change `failing`
  and notifies immediately. Racing two `waitForEvent`s isn't replay-deterministic, so it's avoided.
- **Rebase/revert sandbox jobs** get a *fork-only* write token (≤ 600 s, passed via env, never argv). This is a deliberate,
  narrow exception to "sandboxes get read tokens only": they must push the rebased commit to the change's own fork.
- **Review flow.**
  - `request-changes` sends the change back to `awaiting-push`.
  - Review requests expire after 4 × 7 days, with reminders.
  - A pure revert of a `.platform/**` change still needs a human.
- **Unclaimed projects.** These never enqueue automatically and never start a RolloutWorkflow. The rule is enforced in the
  coordinator (`restrictForClaim`), not just in the UI.

## 2026-10-01 — Platform Worker, templates and sandbox choices

- **Agent tokens.** Agents use our own `agent_tokens` table, not better-auth's api-key plugin.
  - Plugin keys point at a better-auth user, and agents aren't users.
  - The plugin would add a second scope vocabulary next to our `Scope` enum.
  - Its default rate limit is 10 requests/day per key, and it writes to D1 on every check.
  - Ours: `gtf_` + 32 random bytes, only the SHA-256 stored, one indexed read. Agents can only ever hold `repo:read`,
    `plan:create`, `change:create`.
- **Signatures.** Detached signatures are purpose-scoped: `gittifacts/plan-approval`, `gittifacts/audit-entry`, `gittifacts/document`.
- **Idempotency.** Only successful responses are stored, and push grants (tokens) never are.
- **Templates.** These are standalone pnpm projects (own lockfile and workspace file). They build with esbuild (~0.1 s,
  versus ~1.3 s for `wrangler deploy --dry-run`) and don't depend on wrangler; the sandbox image ships wrangler 4.145.0 globally.
  Measured CI work per template is 5–8 s, so container start and snapshot reuse are what decide the 60 s target.
  `ts-library` has no preview (it's a library); its "preview" is the generated API docs page (TODO).
- **MCP discovery** (see `docs/research/mcp-discovery.md`). Spec 2026-07-28 has no ratified `.well-known/mcp`.
  - We serve RFC 9728 `/.well-known/oauth-protected-resource[/mcp]`, but only once an authorization server exists.
  - We serve a draft SEP-2127 Server Card at `/mcp/server-card`, plus a draft `/.well-known/ai-catalog.json`.
  - We do not serve the dead `/.well-known/mcp*` proposals.
- **Sandbox image.** `node:22-bookworm-slim` + git, tini, procps, wrangler 4.145.0, stryker, coverage-v8. 686 MB
  uncompressed, ~194 MB gzipped.
  - Evidence commands, wrangler builds and previews all work with `--network none`; only installs need a registry.
  - Coverage: the runner symlinks its own `@vitest/coverage-v8` into the checkout when the repo can't resolve one. A
    non-zero exit with all tests passing becomes an error item, never 0%.
- **pnpm 11 build-script approval** (`ERR_PNPM_IGNORED_BUILDS`) breaks installs of imported repos that have
  unapproved build scripts. Import detection must surface this in the generated Plan, and the sandbox must not
  auto-approve build scripts for unclaimed projects.

## 2026-10-01 — Agent-native merge queue replaces the serial queue (docs/prompts/03-merge-queue.md)

**CAS on main.** Artifacts enforces the receive-pack old-oid. A stale old-oid is rejected with `ng <ref> stale ref`,
and a commit missing from the target repo with `unpack reachable object is missing`. Both were verified live on 2026-10-01
(the probe in docs/research/artifacts.md §12, and `@app/gitwire`'s `scripts/live-smoke.ts`, steps "fastForward with stale
old SHA -> StaleRefError" and "fastForward to an absent commit -> MissingObjectError").

We still keep the DO-only-writer rule as defence in depth. Main-repo write tokens are minted only inside the `MergeQueue`
DO, live ≤ 300 s, and are never returned. `refs/queue/*` are written only by the DO as well.

**Structure.**
- A pure, IO-free scheduling core in `packages/merge-queue` covers the conflict graph, tracks, speculative batches,
  bisection, priority/aging, stacks, plan groups, fair share, prediction, flake handling and freezes.
- The `MergeQueue` DO and the `BatchRunWorkflow` are thin IO shells around it.
- `sim/merge-queue/` drives the *same* core with a seeded discrete-event simulator and enforces the §6 gates in CI.
- The coordinator's earlier `MergeQueueCore` (serial) remains the "strictly serial" baseline in the simulator report.

**Preview DNS.** `*.preview.resynapse.dev` AAAA `100::` (proxied) was created on the resynapse.dev zone for the preview
gateway route.

## 2026-10-01 — Platform integration: one Worker wires coordinator, CI engine and sandbox

- **Ports per role** (`apps/platform/src/runtime/ports.ts`). `buildPorts(env, role)` builds every port from
  bindings. Only `role: "merge-queue"` gets `ArtifactsGitHost({ canWrite: () => true })`; every other role keeps
  the adapter's default fork-only guard, so "only the merge queue writes main" holds in one place.
- **Lazy ports.** The CI engine (`selectCiEngine` by `CI_ENGINE`), the reviewer (`createReviewer(reviewerLlmFromEnv)`)
  and the signer (`PLATFORM_SIGNING_KEY`) are built on first use. A missing binding or secret fails the call
  that needs it, and the coordinator treats that as an errored signal (escalate), not every request.
- **Reviewer model.** The `Reviewer` port takes no policy, so the platform uses `"auto"` (the policy default).
  A repo's `ai.reviewerModel` is not honoured yet.
- **One bucket.** `CI_BUCKET` is a second binding to `gittifacts-blobs` (eu), so the engine's `ci-logs/<runId>/…`
  refs are served by `GET /api/v1/blobs/:ref` through `BLOBS`. `PipelineRun.id` is the CI run id the coordinator
  gives the engine (`run-<changeId>-<head12>`), which is what makes those refs attributable to a change.
- **Bundle seam.** The engine reports the build artifact as `RunSummary.artifacts.bundle.key`; the coordinator's
  run sink reads `outputs.bundleRef`. The platform's `ChangeCoordinator` subclass maps one onto the other until
  the coordinator reads the engine's field itself. `loadBundle` only accepts `ci-artifacts/<runId>/<step>/<name>.tgz`.
- **SSE.** `GET /api/v1/changes/:id/events` streams the change (`event: change`, `id` = change version, resumable with
  `Last-Event-ID`), built on `watchChange` so the DO holds each long-poll; it ends after 15 minutes or at a final status.
- **Node types in the platform tsconfig.** `@app/ci-engine`'s sources call `clearTimeout(undefined)`, which only Node's
  timer typings accept; the Worker runs with `nodejs_compat`.
- **Integration test fakes** (apps/platform/test/integration). Real: Hono app, MCP server, auth, D1, AuditLog,
  signing key, coordinator facade, ChangeCoordinator/MergeQueue DOs, PushRouter/ChangeWorkflow. Fake:
  Artifacts (`FakeGitHost`; no local simulator), containers (`FakeSandboxJobs` and a CI fake that reports a
  schema-checked ci-engine `RunSummary` through `COORDINATOR.onRunFinished` exactly like `CiRunWorkflow`, and
  validates requests against the engine's strict `RunRequest`), and the reviewer model (`FakeReviewer`).

## 2026-10-01 — Affected sets for the merge queue (`@app/affected`, `gittifacts-runner affected`)

- **Pure library, own marker.** `packages/affected` holds the analysis: a tolerant scanner with no TS compiler, a
  resolver, the module graph, test impact, a cheap public-API check, Workers, and `conflictBetween`. Its only
  dependency is zod. The sandbox command `affected` reads git objects only and prints `::affected::<AffectedSet>`.
  It is not an EvidenceItem, so it gets its own marker.
- **`modules` = touched + reverse closure − test files + targets of *added* import edges.** Each Change's closure
  is computed on its own tree. A new caller of an existing module (fixture `semantic-conflict`) would otherwise
  never overlap a Change to that module. Test files go to `testTargets`, so "shared test only" is a distinct
  conflict reason. Closures that meet at a shared importer (a Worker entry, a barrel) conflict, as the spec asks.
  This limits parallelism inside one app, and it is what the simulator should measure.
- **`*config*` sentinel.** Touching any of the following puts `*config*` in `modules`, selects all tests, and keeps
  `complete: true`. The core treats `*config*` as conflicting with everything.
  - manifests, lockfiles, tsconfig
  - runner, bundler and lint configs
  - wrangler configs, Dockerfiles, `.platform/**`
- **Completeness is fail-closed and narrow.** `complete: false` (conflict with everything) when:
  - a touched file has no analyzer that understands its dependents and nothing imports it (fs-read data,
    scripts, unknown types);
  - the closure reaches a package with unresolvable references (an unmapped local package entry, or an
    unresolved `@/`/`~/` alias);
  - an analyzer crashed, or a scanned file was unreadable.

  These do *not* make a set incomplete; they are noted only:
  - computed `import(x)` with no static prefix (in practice these load runtime paths);
  - relative imports of files not in the tree (generated: no Change can touch them).

  Making those incomplete would have serialized every repo with one plugin loader.
- **Test impact with a coverage map.** The targets are the tests that executed a *touched* file on main's last run
  (classic coverage TIA), not tests that executed something in the closure. Static selection covers what the map
  can't know: touched files no test executed, and test files missing from the map. Accepted gap: a test that imports
  a module but never executes a statement in it is not selected by coverage. Barrels never show statement hits,
  which is why the selection is not closure-based.
- **Static test impact** uses the test files in the reverse closure. A runner config's `setupFiles`/`globalSetup`
  in the closure selects every test under that config. Other string literals in configs, such as aliases, are
  ignored on purpose.
- **Stacked Changes** are analysed against their parent's head (the queue passes `--base <parent head>`).
- **Fixtures.** `fixtures/queue/` has seven scenarios: independent, textual-conflict, overlapping-closure,
  shared-test-only, stack, semantic-conflict and flaky-test. Each has an exact conflict matrix, merge cleanliness
  and vitest outcomes on merged trees. The flaky test is deterministic under `QUEUE_FLAKE_SEED`.
