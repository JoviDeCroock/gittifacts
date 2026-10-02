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
- **Reviewer model.** The coordinator passes the base policy's `ai.reviewerModel` to the `Reviewer` port (`model`);
  the platform keeps one model client per model (`lazyReviewer`). *(Updated 2026-10-02, O1.)*
- **One bucket.** `CI_BUCKET` is a second binding to `gittifacts-blobs` (eu), so the engine's `ci-logs/<runId>/…`
  refs are served by `GET /api/v1/blobs/:ref` through `BLOBS`. `PipelineRun.id` is the CI run id the coordinator
  gives the engine (`run-<changeId>-<head12>`), which is what makes those refs attributable to a change.
- **Bundle seam.** The engine reports the build artifact as `RunSummary.artifacts.bundle.key`, and the coordinator's
  run sink reads it directly (the platform subclass shim is gone, 2026-10-02); it also forwards `snapshots` (previews
  start from `snapshots.build`). `loadBundle` only accepts `ci-artifacts/<runId>/<step>/<name>.tgz`.
- **SSE.** `GET /api/v1/changes/:id/events` streams the change (`event: change`, `id` = change version, resumable with
  `Last-Event-ID`), built on `watchChange` so the DO holds each long-poll; it ends after 15 minutes or at a final status.
- **Workers types only.** `@app/ci-engine` guards its `clearTimeout` calls, so the platform tsconfig dropped Node's
  types (2026-10-02); config files type-check with `tsconfig.node.json`.
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

## 2026-10-01 — Merge queue Q3: agent conflict resolution (resolver, evidence, lane floor, tour stop)

- **Evidence.** Two new item kinds in `@app/evidence`.
  - `conflict-resolution`: upstream Changes, `conflictHunks`, `outsideHunks`, a resolution diff
    capped at 64 KB on a line boundary (`truncated`), `touchesOutsideConflictHunks`, `novelLines`,
    the semantic culprit, the resolver's model, principal and prompt version, and attempts.
  - `quarantine` is a separate item rather than a field on `test-run`. The quarantine list and the
    affected set belong to the queue, not to the test runner. An unknown affected set counts every
    quarantined test as affected.
- **"Within the conflict hunks" is computed exactly, never reported by the model.** `resolutionScope`
  accepts a resolution only if it equals the mechanical merge with each region (markers included)
  replaced and every clean line kept verbatim and in order: a wildcard match, solved greedily.
  - Unparseable markers, edits to files that were not in conflict, and edits with no conflict hunk
    (every semantic fix) count as outside.
  - `novelLines` counts resolved lines found on neither side. It is recorded and shown, not classified.
- **Classifier.** Resolution and quarantine items only add reasons:
  - `resolution.within-conflict` (L0), `resolution.outside-conflict` / `.semantic` / `.truncated` / `.skipped` (L1);
  - `signal.error.conflict-resolution` (L2);
  - `tests.quarantined` (L1, tests gate unknown) and `signal.error.quarantine` (L1).

  New gate: `conflict-resolution`, which makes 21 gates. `neverLower(previous, next)` keeps lane and
  computed lane at least at the previous values. When it raises, it adds `resolution.lane-kept` at
  the previous lane, drops shadow mode, and keeps `requiresHumanApproval`. `reclassifyAfterResolution`
  composes it with `classify`, so the queue shell cannot forget the floor. The merge-queue core
  keeps the max as well (defence in depth).
- **Runner.** git 2.39 in the sandbox image has no `merge-tree --merge-base`, so `merge-attempt`
  cherry-picks a synthetic commit (head's tree, parent = the Change's base). That makes the merge
  base exactly `--base`.
  - Content conflicts are re-merged with `git merge-file --diff3 --marker-size=13 -L upstream -L base -L change`,
    so the markers can't be confused with file content.
  - The conflicted tree is committed (`conflictSha`, deterministic).
  - `apply-resolution` commits the resolution on top as `gittifacts-resolver`. It accepts an empty
    patch (keeping a modify/delete survivor), so the resolution stays its own attributable commit.
    The queue may squash the two commits; that is its choice.
- **Resolver.** Principal `system:resolver`, not configurable. Its prompt input type has no author
  summary, claim or trace. The model answers per region, and whole files only for edits outside
  the regions. Every answer is validated, the patch is verified in memory, there is one
  regeneration, and every failure ejects with a machine-readable `fix` for the author.
  - The per-change budget is shared with the reviewer (`@app/tour` `BudgetTracker`).
  - A model's culprit claim on a textual conflict is ignored.
  - The resolver can only edit files it was shown in full.
- **Eval.** The corpus is `fixtures/conflicts`: 11 textual and 3 semantic cases. `pnpm test` runs
  it with a scripted model through the real runner and the cases' checks (all pass, 0 downgrades).
  The real-model `eval` script gates on ≥ 80% textual success and 0 downgrades. It has **not been
  run yet**: no AI Gateway credentials were available in this environment.

## 2026-10-01 — Conflict resolution (Q3) semantics

- **Evidence items.** `conflict-resolution` and `quarantine` are separate kinds (not fields on `test-run`): the
  quarantine list and the affected set belong to the queue, not to the test runner.
- **"Within the conflict hunks" is decided mechanically.** A resolution is *within* only if it equals the mechanical
  merge with each conflict region replaced and every clean line kept in order. Edits outside the regions, to
  non-conflicted files, or with unparseable markers count as *outside*, and so does every semantic fix.
- **Lanes only rise.** The queue shell must classify a resolved Change with `reclassifyAfterResolution(previous, …)`,
  which is `neverLower(previous, classify(...))`. The pure merge-queue core keeps the max lane as a second guard.
- **Human approvals bind to what lands (lead decision).** A Lane ≥ 1 approval covers `(headSha, resolutionSha)`.
  - A within-hunk resolution with **zero novel lines** (purely picking/combining existing lines) keeps the approval.
  - A resolution with novel lines, outside-hunk edits, or a semantic fix **invalidates** the earlier approval. The
    change goes back to `awaiting-review` with a tour whose `resolution` stop comes first.
  - Lane-0 changes keep Lane 0 for within-hunk resolutions (per spec); novel lines are shown in the tour.
- **Resolver identity.** The resolver always acts as `system:resolver`. It never sees the author's summary, claim or
  trace, and it may answer `cannot-resolve` or (semantic only) `not-a-conflict`. After two failed attempts or an
  exhausted budget it ejects with `fix.call = open_workspace({ changeId })`.
- **Real-model eval pending.** The ≥ 80% resolver gate needs live AI Gateway access. `packages/resolver/scripts/eval.ts`
  runs it after the deploy; the scripted-model pipeline test passes all 14 corpus cases with 0 downgrades.

## 2026-10-01 — Delegated auth for agents (O4): MCP OAuth + device flow

- **The platform is its own authorization server, hand-rolled for the code flow.** `@better-auth/oauth-provider`
  / `@better-auth/mcp` were read and not used for authorization code + PKCE:
  - Their tokens are issued to the better-auth *user* (the human). Every O4 grant must instead become a **new agent
    principal** with the scopes, repos and expiry the human picked. The plugin caches consent per (user, client) and
    re-issues codes without showing consent again, so there would be no new principal and no repo choice. Mapping
    tokens back to principals through `postLogin.consentReferenceId` is fragile, and a slip would hand a client
    the human's identity.
  - CIMD needs `@better-auth/cimd`, which isn't installed. Without it, `mcp()` only offers DCR (deprecated by MCP
    2026-07-28) or pre-registered clients.
  - JWT access tokens need the `jwt` plugin (JWKS table, key rotation). Immediate revocation needs a DB check
    anyway, so they'd add a second token format next to `gtf_` for no gain.
  - What we built (`apps/platform/src/oauth/*`) is about 1,500 lines with 35 Workers tests. It has one token type
    (`gtf_` in `agent_tokens`, now with an RFC 8707 `audience` and a `session_id`) and one verification path.
- **Device flow uses better-auth `device-authorization`, with session minting cut off.** The plugin's
  `/device/token` returns a *session for the approving human* (all scopes, including `plan:approve`), so as shipped
  it is a way for a CLI to act as the human. Two guards stop that:
  1. A `grant` whose `assertSessionRedemption` always throws.
  2. `disabledPaths` for `/device/token`, `/device/approve`, `/device/deny` and `/device`.

  Codes come from the plugin's `/api/auth/device/code`. Redemption goes through a server-only endpoint that runs
  the plugin's `redeemDeviceCode` state machine (expiry, `slow_down`, denial, atomic claim). Our token endpoint then
  issues an agent token. Approval only happens through `/api/v1/oauth/device/{userCode}/approve`, which records the
  human's choices before calling the plugin.
- **One principal per session.** The first token exchange creates `Principal { kind: "agent", ownerId: human,
  scopes, repoIds }` and an `agent_sessions` row, re-checking that the scopes are still delegable and still held by
  the human. Scopes and repos live on the principal; the session holds the client, audience and hard end.
- **Scope model.** Only `repo:read`, `plan:create` and `change:create` can be delegated (`AGENT_ALLOWED_SCOPES`).
  - `plan:approve`, `change:review`, `policy:admin` and `repo:admin` are rejected everywhere: authorize, device
    code, consent body and refresh. `createAgentPrincipal` throws as a last line of defence.
  - Generic OIDC scopes (`openid profile email offline_access`) are ignored.
  - Default: `repo:read change:create`, i.e. "can open Changes on repo X".
- **Per-repo scoping.** `Principal.repoIds?: string[] | null` (additive and optional in `@app/domain`; absent or
  `null` means every repo the owner can access). The consent API *requires* `repoIds` (specific ids, or `null`
  picked on purpose). It is enforced in:
  - `requirePrincipal`: `{repoId|planId|changeId}` params, a JSON body's `repoId/planId/changeId`, and the audit
    `subject`. The global audit list is refused.
  - The MCP backend, for every tool that names a repo, plan or change.
  - The services: capabilities/whoami, list_repos, blobs and create_plan.

  Violations get `403 repo-not-granted` with a fix.
- **Audience.** OAuth `resource` must be `<origin>/mcp` (the default for the code flow) or `<origin>/api`. Device
  tokens cover both by default. `/mcp` refuses tokens not bound to it, and the HTTP API refuses tokens bound only to
  `/mcp`. Manual tokens (`audience` NULL) work on both, as before.
- **Clients.** Client ID Metadata Documents (an https `client_id`, fetched with no redirects, max 16 KB, 5 s
  timeout, `client_id` must equal the URL, public clients only) plus one first-party client, `gittifacts-cli`.
  DCR is not offered and `registration_endpoint` is not advertised.
- **Tokens.** Access tokens last 1 h and never outlive the session; sessions last 1, 7, 30 or 90 days, as the human
  picks. Refresh tokens (`gtr_`, which never pass as a bearer token) rotate on every use. Replaying a rotated one
  revokes the whole session (strict, with no grace window). A replayed authorization code revokes the session it
  created. Codes are single-use and live 5 minutes; requests last 10 minutes.
- **Revocation.** One click (`POST /api/v1/agent-sessions/{principalId}/revoke`) revokes the access and refresh
  tokens and sets `principals.disabled_at`, and it is audit-logged. `verifyAgentToken` joins `disabled_at`, so the
  next request fails. RFC 7009 `/api/oauth/revoke` with a refresh token ends the session too.
- **Errors.** Platform JSON endpoints use `{ error: { code, message, fix } }` (fixes from `@app/conventions`
  `fixFor`). OAuth protocol endpoints answer in RFC 6749 form (`{ error, error_description }`) plus a `fix`
  extension member, because stock OAuth clients parse `error` as a string.
- **Deviations from the MCP 2026-07-28 authorization spec:**
  - Insufficient scope or a repo outside the grant comes back as an MCP *tool* error (`insufficient-scope` /
    `repo-not-granted`), not an HTTP 403 `insufficient_scope` step-up challenge. Scopes are checked per tool, after
    JSON-RPC parsing.
  - A missing `resource` at authorize defaults to the MCP server instead of being rejected.
  - The root PRM (`/.well-known/oauth-protected-resource`) keeps `resource=<origin>/mcp`, as documented in mcp-discovery.md.
  - Refresh reuse is strict (no overlap window).
- **Known follow-ups.** Expired `agent_tokens` rows (one per refresh) need a periodic purge. The sessions list
  aggregates in SQL, so the extra rows only cost storage.

## 2026-10-02 — Onboarding O1: front door, create_project, bootstrap Change, preview gateway

- **Front door** (`apps/platform/src/routes/front-door.ts`): `/start` (markdown; JSON on `Accept: application/json`),
  `/llms.txt`, `/openapi.json` (alias), `/mcp/server-card` and `/.well-known/ai-catalog.json` from `@app/conventions`.
  The OAuth routes keep RFC 9728/8414 metadata. `/` carries RFC 8288 `Link` headers (service-doc, describedby,
  service-desc, mcp-server-card, ai-catalog) and the same `<link>` tags; `Accept: application/json|text/markdown` on `/`
  gets the guide itself.
- **`run_worker_first: true`.** The preview gateway shares the Worker, and asset patterns are path-only, so a preview's
  `/about/` would otherwise be answered with the platform's SPA. Platform hosts fall back to `ASSETS` in `notFound`.
- **Templates in the Worker.** `scripts/bundle-templates.ts` writes `src/generated/templates.ts` (183 KB, committed,
  formatted by biome); `deploy:prepare` and `test` regenerate it.
- **Initial commit = the one main-repo write outside the merge queue.** `GitHost.writeInitialCommit` pushes a root
  commit with old SHA = zero, so it can create a branch but never move one; every role may call it. `createRepo` takes
  the files from an `InitialCommitProvider` (template rendered with placeholders + conventions `.platform/*` and
  AGENTS.md, or README + AGENTS.md + `.platform/*` for an empty project), called before anything is created so an
  unknown template has no side effects. The generated policy's value (`defaultPolicyValue`) is cached for the initial
  sha, so the bootstrap needs no policy sandbox job. `createRepo` is idempotent per (actor, key) and adopts its own
  empty Artifacts repo after a partial failure. `seed-` is a reserved repo prefix.
- **Bootstrap Change** (`bs-<repoId>`, author `system`, category chore, base = head = initial commit, `forkName` = the
  main repo: no fork, CI gets a read token). Started through the ChangeCoordinator DO (`startBootstrap`) so
  `registerRun` accepts its run. The ChangeWorkflow runs it with `evidenceSteps: []`, seals evidence (with the
  preview), skips judge/note/classify/tour/route and sets `released` with `mergedSha` = head. `lane_assigned` and
  `tour_ready` are unreachable for it; `kill` refuses it. Empty projects get no bootstrap.
- **`create_project` returns** `remote` = a push grant for a fresh `task-` fork (the caller's "First change",
  category feature, planless), so an agent can push at once; `token` stays null for authenticated callers (O3's
  unclaimed bearer token; the CLI stores `token` as a bearer, so it must not be a git token); `previewUrl` =
  `https://p-<bootstrapId>.preview.resynapse.dev`, known up front ("Building…" until green); `claimUrl` null.
  Callers need repo:read + change:create; repo-restricted agent sessions cannot create projects. Idempotency rides on
  the coordinator's derived ids (the response holds a push grant, so it is never stored).
- **Preview gateway in the platform Worker** (supersedes "a separate `preview-gateway` Worker"): route
  `*.preview.resynapse.dev/*`, `p-<changeId>` = latest head, `p-<changeId>-<sha8>` = pinned. HTMLRewriter injects a
  banner (custom element, inline `!important` position/z-index, closed declarative shadow root) at the start of
  `<body>`; `/cdn-cgi/*` is blocked; `Set-Cookie` with a `Domain` attribute is dropped; `X-Robots-Tag: noindex`,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`. D1 `previews` maps ids to snapshots.
- **PreviewHost DO** with its own container application (`preview`) on the same sandbox Dockerfile: wrangler allows a
  container to back only one DO class. It restores the CI `build` snapshot (else `install` + a checkout through
  `CiEgressGateway`, git host only), runs `gittifacts-runner preview --port 8787`, proxies with `getTcpPort().fetch`,
  sleeps after 10 min idle and wakes on the next request ("Starting preview…" page for HTML, 503 + Retry-After
  otherwise). Internet is off for every preview for now. **Risk:** restoring a Runner snapshot in another container
  application needs both to resolve to the same image digest; if a restore fails the preview evidence is `error`.
- **Previews are Worker-side evidence.** The ChangeWorkflow starts the preview before sealing (so `evidence_ready`
  means CI green *and* preview serving), then screenshots `policy.previewRoutes` ∪ plan `affectedRoutes` ∪ template
  routes with Browser Run (desktop + mobile, after-only for now) into R2 `screenshots/<changeId>/…` and re-seals.
  Browser Run missing or rate-limited → `skipped`; a preview that fails to start → `error` (raises to Lane 1).
- **Time-to-first-green**: D1 `project_onboarding` (request start, response, evidence, preview ready, outcome) plus
  Analytics Engine points (`indexes [projectId]`, `blobs [projectId, template, outcome, "ttfg"]`,
  `doubles [msToGreen, msToPreview, msToRespond]`). `GET /internal/ttfg` (human, repo:admin) reads the AE SQL API
  when `CF_API_TOKEN` can (Account Analytics Read), D1 otherwise; the web page is `/internal/onboarding`.
- **Template cache seeding**: `POST /api/v1/admin/seed-cache` writes each template once into `seed-<id>-<digest8>`
  and calls `ciEngine.seedCache`, so the first project per template hits a published install snapshot.

## 2026-10-02 — O5: import detection as a Plan + Change, and remote workspaces

**Import detection.**
- `inspectRepo` (pure, `@app/conventions`) is the single source: `detectProject` plus test-runner configs,
  tsconfig, every wrangler config's `name`, workspaces and pnpm 11 build-script approvals. `gittifacts-runner
  detect` only lists tracked files and reads them (`::detect::<DetectReport>`); nothing is installed or run.
- pnpm lockfiles don't record install scripts, so `buildScriptsNeedingApproval` = lockfile packages on a
  well-known install-script list, minus `allowBuilds`/`onlyBuiltDependencies`. That is a heuristic and the
  report says so in `uncertain`. Detection never approves build scripts.
- **Platform service, not the coordinator.** `proposePlatformConfig` lives in `apps/platform/src/import/`: it
  needs a sandbox job, a Plan (plans are platform-owned, not coordinator-owned), a Change (through the
  coordinator facade like any caller) and a push. No coordinator change was needed.
- It is a Workflow (`PlatformConfigWorkflow`, one instance per `(repo, default-branch sha)` unless `rerun`):
  base → detect (Runner job on the main repo, read-only, `registries-only`) → Plan (draft, author `system`,
  deterministic id) → Change (`chore`, idempotency key = proposal id) → commit → record. The commit step opens a
  **system workspace** on the Change's fork, writes the files and pushes them: the same fork-only push path agents
  use, so no new GitHost write primitive was added. The push starts the normal flow; `.platform/**` makes it
  Lane 2 with `requiresHumanApproval`.
- The Plan lists every doubt as `{ area: "detection", description: "Detection is unsure: …" }`, plus install
  scripts needing approval and low confidence. Existing `.platform/*` files are kept; a non-generated AGENTS.md
  gets the platform section appended (and a risk says so). Nothing to propose → status `not-needed`.
- Until it merges, CI uses the default pipeline (verified: `ci-run.ts` and `gittifacts-runner plan` fall back to
  `defaultPipeline(facts)` without `.platform/ci.ts`; the policy falls back to `defaultPolicy()`).
- `create_project({ from })` should call `startPlatformConfigProposal(svc, { repoId, requestedBy })` after the
  import (exported from `apps/platform/src/import/service.ts`; returns at once).

**Remote workspaces.**
- **Blobless clone, not ArtifactFS.** ArtifactFS needs FUSE (`SYS_ADMIN` + `/dev/fuse`); `ContainerStartupOptions`
  has no capabilities or devices, so it can't be granted on `ctx.container`. `git fetch --depth=50
  --filter=blob:none` (verified on Artifacts, artifacts.md §12) checks the fork out; the base commit is fetched
  with blobs so `ws_diff` needs no credentials. Lazy fetches of old blobs from agent commands fail (no token).
- **One `Workspace` DO per Change** (`ws-<changeId>`), own container app on the sandbox image (a container backs
  one DO class). Start order: its sleep snapshot → the Change's CI dependency snapshot (`snapshots.install` of the
  head's run, else the bootstrap run at base) → the image; an unrestorable snapshot falls back to the next.
- **Tokens.** Minted just in time by the DO through the default-role GitHost (fork-only write guard), never
  stored: a **read** token for the checkout exec, a **write** token for the commit-push exec only, both in
  `GIT_CONFIG_*` env. Agent `ws_exec` commands never see a token. Before pushing, the script rewrites
  `.git/config` from scratch (repo code could add `insteadOf`, credential helpers, fsmonitor or filters to
  redirect or read the token) and disables hooks.
- **Who.** Only the Change's author may open/use its workspace (it pushes to the fork, like `refresh_push_token`),
  only for `task-*` forks (bootstrap Changes have none), only while the Change accepts pushes; the DO re-checks
  the opener on every call. Delegated agents' `repoIds` are enforced before (MCP backend, via the Change).
- **Lifecycle.** Idle `idleMs` (10 min claimed, 5 unclaimed) → DO alarm snapshots the root filesystem and stops
  the container (`sleeping`); the next call resumes from it. `setInactivityTimeout(idle + 10 min)` is only a
  backstop. Hard TTL from open: 2 h claimed, 30 min unclaimed (`WORKSPACE_TTL_*_MIN` vars) → `expired`;
  `open_workspace` starts a fresh session from the fork's head.
- **Quotas.** `ProjectLedger` DO per project: vCPU-seconds of container time per UTC day (container wall time ×
  instance vCPUs, the closest to "CPU minutes" `ctx.container` exposes): 600 vCPU-min claimed, 30 unclaimed;
  open workspaces: 5 claimed, 1 unclaimed. `ws_exec` timeouts are clamped to the remaining budget and TTL.
  Platform-owned (proposal) workspaces don't count against the open limit.
- **Egress.** Claimed: open, unless `policy.sandbox.network = "registries-only"` (new optional RepoPolicy field).
  Unclaimed: always registries-only through `WorkspaceEgressGateway`, which reuses the CI engine's
  `egressDecision`/`REGISTRY_HOSTS` and adds exactly one rule: `git-receive-pack` to the workspace's own fork path
  (CI's gateway is fetch-only, which would block `ws_commit_push`). Denials are counted on the Workspace DO.
- **Not a lane bypass.** The workspace pushes to the fork's branch; the PushRouter → ChangeWorkflow path decides
  everything after that. No workspace can mint a token for a main repo or reach production.
- **Container labels** keys are ≤ 16 bytes (`gf-workspace`; live finding).

## 2026-10-02 — Previews are first-level `<id>-pv.resynapse.dev` hosts (user decision)

**Context.** Live, `*.preview.resynapse.dev` failed the TLS handshake. Universal SSL covers only the apex and one
subdomain level, and a second-level wildcard certificate needs Advanced Certificate Manager ($10/month).

**Decision (the user chose this over buying ACM).**
- Preview hostnames are `p-<changeId>[-<sha8>]-pv.resynapse.dev`, all first-level and covered by Universal SSL.
- DNS: a proxied `*.resynapse.dev` AAAA `100::` record. Explicit records such as `boris` or `drydock` still win.
- The Worker route is `*-pv.resynapse.dev/*`, so only `-pv` hosts reach the preview gateway. Every other
  subdomain of the zone behaves as before.
- Configured as a host suffix (`PREVIEW_HOST_SUFFIX`), so a dedicated preview zone can be used later with a `.zone`
  suffix and no code changes.
- The obsolete `*.preview.resynapse.dev` DNS record is removed.

**Consequence.** Undefined subdomains of resynapse.dev now resolve to Cloudflare (no matching route → Cloudflare error
page) instead of NXDOMAIN.

## 2026-10-02 — Merge-queue core: what the simulator kept and removed (sim/merge-queue/report.md)

- **Kept, each beating its ablation on the metric it exists for:**
  - the conflict graph: p95 32 vs 113 min;
  - speculation: p95 32 vs 274 min;
  - bisection: CI 0.93× vs 1.17×;
  - flake re-check: false-eject 1.05% vs 42%;
  - impacted-target revalidation: CI 0.68× vs 4.69×;
  - fair queuing: other sessions' p95 35 vs 66 min.
- **Speculation is a DAG,** not tracks that drain: each batch builds on exactly the batches it conflicts with. Small
  pipelined revalidation batches and a 2-minute hold let siblings join a batch whose parent is still running.
- **Removed: prediction-driven batch sizing/ordering.** A fixed batch size of 4 beat it on every seed (p95 33 vs 54 min,
  CI 0.69× vs 0.85×). Predictions are still computed, returned to agents and logged against outcomes, but they don't
  steer scheduling.
- **Removed: a cap on what a merge batch may carry** (its forced drains made p95 worse, 54 → 102 min).
- **Gates.**
  - main-red 0/30 runs, attribution failures 0, CI ≤ 1.5× (0.70× worst), false-eject ≤ 1% (0.34% worst) and
    resolver ≥ 80% (model) all pass.
  - **p95 time-in-queue on gate-200 fails: 30.6–33.0 min vs 20 min.** One conflict cluster gets ~25 arrivals/h
    against a 10-minute run, and each real failure restarts ~10 speculative descendants. Next: speculate on both
    outcomes for risky batches (SubmitQueue style) and reuse cached per-Change results after a cancel.
- **Simulator assumption:** CI fails fast (a failing run reports when its failing test finishes).

## 2026-10-02 — Reviewer model on this platform

The policy's `ai.reviewerModel: "auto"` resolves to `@cf/moonshotai/kimi-k2.7-code` on Workers AI, called through
AI Gateway by the AI binding. `REVIEWER_MODEL` overrides it, and `@cf/openai/gpt-oss-120b` is the measured
alternative.

Live dogfooding found that third-party model ids fail through the binding without Unified Billing credits
(`7003 User Input Error`). Both Workers AI models returned valid json_schema output in about 4 s.

Costs are conservative per-token estimates; Workers AI bills in neurons, about $0.0006 per small call.
