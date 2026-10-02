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

## 2026-10-02 — Product direction: supersede GitHub over time; import is the on-ramp (user)

The long-term goal is to supersede GitHub for teams whose code is mostly written by agents. Importing from GitHub is
the deliberate on-ramp:
- `create_project({ from: githubUrl })` imports history through Artifacts.
- Detection proposes `.platform/*` as a Plan + Change that a human approves.
- Standard git clients keep working against the Artifacts remote.

The near-term non-goals of the platform prompt stay non-goals (no social, issues or OSS-community features yet). The
optional GitHub mirror (main pushed back to GitHub, behind a flag) is the bridge for teams mid-migration.

The marketing page contrasts the unit of work (PR vs Change) rather than the vendor.

**Eval fixture.** The task-2 import fixture is published at https://github.com/JoviDeCroock/gittifacts-fixture-clock-api
(public, user-approved), materialized from `fixtures/imports/clock-api`.

## 2026-10-02 — O3: claimable projects and abuse limits

**Lifecycle.** `create_project` without credentials (MCP or `POST /api/v1/projects`) → kill switch → creation rate
limits → a fresh **ownerless agent principal** (`ownerId: null`; only repo:read, plan:create, change:create;
`repoIds: [project]`) → the project, created *as* that agent (the coordinator already makes an ownerless agent's repo
unclaimed) → a `gtf_` token valid until the project expires, and a `claimUrl` (`/claim/gtc_…`). The claim token is
HMAC-SHA-256(BETTER_AUTH_SECRET, repo + agent + createdAt), so the platform can repeat the link to the project's own
agent (quota errors carry it) while storing only its SHA-256. Unclaimed projects expire after `UNCLAIMED_TTL_DAYS`
(default 7): a cron (`*/10 * * * *`) revokes the agent's tokens, disables it, stops workflows/CI/workspaces/previews,
deletes the Artifacts repo and forks (through a GitHost whose write guard admits exactly those names), R2 objects and
D1 rows; audit events stay and `project_claims` keeps a tombstone (`expired`). A failed step leaves `expiring`; the
next run resumes. Claims and expiry race through one conditional update on `project_claims.status`.

**MCP gate.** Without a bearer, only `initialize`, `notifications/initialized`, `ping`, `tools/list` and
`tools/call` of `create_project`/`whoami` are served (GET/DELETE reach the stateless handler's 405); everything else
keeps the RFC 9728 401 challenge, so OAuth clients still discover the authorization server on their first real tool
call. HTTP: credentials that don't verify never fall back to an unclaimed project (401). Anonymous idempotency keys
must be ≥ 16 characters (they find the project again, so they must be unguessable); a replay mints a fresh token for
the same project and is not charged against the rate limits again.

**Rate limits: Durable Object token buckets, not the rate-limit binding, for creation.** The Workers Rate Limiting
binding counts per Cloudflare location with a 10 s or 60 s period; "3 per IP per hour", "200 per ASN per day" and a
platform-wide cap need long windows and one global counter. `AbuseLimiter` (one DO per `ip:<hmac>` (IPv6 /64),
`asn:<request.cf.asn>`, `global`) takes from every key or none (refusals refund), fails closed, and answers 429
`rate-limited` with `Retry-After`. The binding (`UNCLAIMED_TOKEN_LIMITER`, 120/min) does what it is good at:
per-token request rates of unclaimed agents, on the HTTP API and MCP, fail closed. Raw IPs are never stored.

**Kill switch.** Flagship flag `unclaimed-creation-enabled` via `FLAGS`, fail closed (missing binding, unknown flag,
evaluation error → off), plus a D1 override (`PUT /api/v1/admin/unclaimed-creation`, humans whose principal id is in
`PLATFORM_ADMINS`; e-mails are not accepted because e-mail sign-up is unverified): `off` always wins; `on` only bridges an unevaluable flag (a flag set to false still stops
creation). Off → 503 `creation-disabled`; /start and llms.txt say so. Repo scopes don't make a platform admin (every
human holds them).

**Quotas (ProjectLedger, per project and per creating IP, plus a global CI ledger).** Defaults in
`apps/platform/src/limits/config.ts`, overridable by `UNCLAIMED_LIMITS` JSON: CI 60 min/day, 10 min/run, 120 min/day
per IP, 1500 min/day for all unclaimed projects; storage 200 MB (500 MB per IP) of what the platform stores (CI logs +
build artifacts); 300 Artifacts operations/day (600 per IP: forks, push tokens, CI checkouts, workspace tokens);
≤ 5 open Changes; the 3 newest previews live; workspaces keep O5's 30 vCPU-min/day, 1 open, 30 min TTL. CI minutes
are reserved when a run starts and settled to `usage.ciMinutes` when it finishes (the platform's `ChangeCoordinator`
subclass hooks the run sink). Enforcement points: the CI port (wrapped at the runtime seam for every role:
expiry/storage/ops/minutes; a refused run never starts a container and is reported as a failed run whose single
step `unclaimed-limits` says why — the Change turns `failing` instead of hanging), `start_change`,
`refresh_push_token`, `open_workspace`, `ws_commit_push` (429 `quota-exceeded`, fix with the claim link,
`limit.hit` audited). Claimed projects pass straight through; claiming lifts every limit at once.

**Egress / previews / production.** CI runs of unclaimed projects are clamped by the platform too
(`network: registries-only`, read-only global cache so they can't publish shared snapshots, smaller log/artifact caps,
`standard-2` ceiling) on top of the coordinator's `registries-only`. Workspaces were already registries-only;
previews have no internet for everyone. The preview banner leads with "Unclaimed project — not verified" (UNCLAIMED
badge) until claimed. No API sets secrets, custom domains or a deploy target (a test scans OpenAPI and the MCP tools);
`D1Store` refuses a deploy target on an unclaimed repo and stores its policy with Lane 0 and verified-revert
auto-merge off; the coordinator's `restrictForClaim`, `autoMerge = claimed && …` and rollout skip are verified end to
end (a coordinator test now covers a verified pure revert in an unclaimed project).

**Claim.** `GET/POST /api/v1/claims/{token}`, web page `/claim/<token>`. Signed-in human + Turnstile (Siteverify with
`TURNSTILE_SECRET_KEY`; unset → Cloudflare's documented test keys, whose answers are reproduced locally so tests
never reach the network). Single-use (others get 409), idempotent for the claimer (a retry skips Turnstile and
returns `alreadyClaimed`), expired → 410. Transfer: repo claimed (owner, no expiry), agent `ownerId` = the human
(same scopes and repo; it still can never approve), previews re-bannered, `project.claimed` audited. The cached repo
policy keeps verified-revert auto-merge off until the next default-branch commit re-reads the policy (conservative).

**Known gaps (reported).** Artifacts exposes no repo size, so git object storage of an unclaimed project can't be
metered: it is bounded by Artifacts' 1 GB/repo × (1 + ≤ 5 open forks), the TTL, and the creation limits. Preview
container time is bounded (3 live previews, 10-minute idle sleep, internet off) but not metered. Any signed-in human
can review an unclaimed project's Changes (scopes are platform-wide today); that can merge into the project's own
main, never deploy it.

## 2026-10-02 — Unclaimed creation stays OFF until repo membership ships; access control by membership

**Found.** O3's own review found that repo access depended only on global scopes. With open sign-up, any human could
list, read and approve any repo, including unclaimed projects.

**Fixing it.** That's a §6 violation (least privilege, separation of duties), so it's being fixed with basic repo
membership (owner / maintainer / reviewer / reader), enforced through one access chokepoint.
- Nobody may review an unclaimed project until a human claims it. The claimer becomes its owner.

**Until it ships,** the Flagship flag `unclaimed-creation-enabled` is deliberately **not created**. The kill switch
fails closed, so credential-less `create_project` stays disabled.

**Done.** The Turnstile widget `gittifacts-claim` (managed) exists for gittifacts.decroockjovi.workers.dev:
- the site key is a var, and the secret is a Worker secret, never printed;
- `PLATFORM_ADMINS` holds the operator's principal id.

**Known bounds, not meters (O3).** Neither of these can be metered with today's primitives; both are bounded instead.
- **Artifacts repo storage.** There's no repo-size API, so it's bounded by Artifacts' 1 GB per repo × (main + ≤ 5
  forks), the 7-day TTL and the creation rate limits.
- **Preview container time.** Bounded by ≤ 3 live previews per project, 10-minute idle sleep and internet off.

## 2026-10-02 — Merge queue integration: the MergeQueue DO shell, BatchRunWorkflow, queue API

**Same DO class, new internals.** `MergeQueue` keeps its class name and `MERGE_QUEUE` binding (no wrangler
migration). Its SQLite keeps the serial queue's `merge_queue` table: items still in it are re-admitted once, on
first use. The node-safe shell is `packages/coordinator/src/queue/*`; the DO class only wires SQLite, alarm and RPC.

**The loop (shell.ts, exactly).**
- `dispatch` is synchronous: zod-validate → `step` → one `transactionSync` writes the state, the command outbox
  and the §5 events (`mq_events`).
- A command's result deletes the command in the same transaction that applies the result.
- Handlers are idempotent and retried with backoff (5 s · 2ⁿ, ≤ 5 min, 6 attempts). A command that keeps failing
  gets the result the protocol allows (an errored `BatchResult`, an unknown affected set, a failed resolution, a
  rejected CAS) or is dropped (audited), and the core's own timeouts recover.
- `InvariantViolation` → nothing of the step is persisted, `halted` is recorded, audit + notification, every later
  event is refused until a human `resume`s.
- The alarm fires at the next due command and every 30 s while anything is live: `Tick` for both machines, the train
  monitor, and a main reconciliation (`MainAdvanced` if main moved outside the queue).
- Persisted states from an older core get new fields' defaults on load (`upgradeState`).

**Where trees are built.** Each repo has a scratch repo `mqs-<repoId>` (fork of main; prefix reserved for projects).
- `BuildBatchTree` copies the heads into the scratch repo and replays them with `gittifacts-runner merge-attempt`
  (one container job, one commit per entry), then the DO copies the tip into the main repo's `refs/queue/<batchId>`.
- Containers only ever get a scratch-repo write token. The DO stays the only writer of `refs/queue/*` and main.
- Fast path: when each head already sits on the previous tip (a lone Change on an unmoved base, a stack), the heads
  are the batch commits and no container runs.
- The shell remembers where every head lives and what it replays from (`mq_heads`): resolved heads live in the
  scratch repo and replay from the commit their resolution was built on.

**Batch runs.** `BatchRunWorkflow` (one instance per run, `mq-<repoId>-<epoch>-<runId>`) runs the base's pipeline
with no evidence steps on the `refs/queue` commit in the main repo, through the existing `CiEngine`.
- It polls the engine (15 s, then 30 s) and fails fast on the first failed user step (cancelling the run).
- It reports the tested tree from `treeOf(commit)` and whole-run outcomes (`__run__`, which the core re-checks on
  main before believing), and passes the run's bundle to the DO.
- Flake re-checks run both sides in parallel, retrying infra errors twice before they count.
- CI runs are filed under the batch's first Change (`pipeline_runs` references changes).
- **ci-engine:** `RunRequest.testTargets` → `GITTIFACTS_TEST_TARGETS` in user steps (never evidence steps); a test
  command that ignores it runs everything, which still covers the targets.

**CAS.** `updateRef(main, expectedOld → newSha)`; Artifacts' stale old-oid answer goes back to the core as
`CasResult{stale, actualSha}`. A re-run after a crash that finds main already at `newSha` reports ok. After a landed
CAS each entry's evidence is re-sealed for the merged commit (+ a `quarantine` item when tests are quarantined), a
signed `merge-queue-verdict` document is audited, notes are written on the entries' commits; failures there are
audited, never turned into a failed CAS.

**Admission and the ChangeWorkflow.** Only the ChangeWorkflow admits a Change (Lane 0 auto-merge, verified revert,
or a human review), with `lane` and what the approval covers.
- MCP/HTTP `enqueue` records options (priority, `dependsOn`, plan group, land mode) that apply at admission. It never
  bypasses review: unclaimed projects still never auto-enqueue.
- Merged / ejected go back to the ChangeWorkflow on its one waited event type (`merged`). An ejection is a
  `QueueEjectedEvent` payload, so the workflow wakes at once with the reason.
- Train-deployed merges skip the per-Change RolloutWorkflow.

**Approval binding (Q3 rules) and one protocol gap.** Within-hunk resolutions with zero novel lines keep the
approval. Novel lines on a Lane ≥ 1 Change, outside-hunk edits and semantic fixes need a fresh human approval.
- The protocol has one "needs approval" flag (`outsideHunks`), so a novel-line resolution reports it too, with the
  reason `merge-queue.resolution-novel-lines`. This is conservative and only adds a review. A dedicated
  `invalidatesApproval` field in `ResolutionResult` would be cleaner (protocol change; not made).
- `RequestApproval` puts the Change back to `awaiting-review` at the raised lane and re-tours the resolved head (its
  `conflict-resolution` item becomes the resolution stop). `submitReview` delivers approve to the queue (`Approved`;
  the core refuses authors and resolvers); request-changes / reject dequeue it.

**Resolver.** `@app/resolver` on the platform model client: the base policy's `ai.reviewerModel`, with "auto" →
Workers AI Kimi (`REVIEWER_MODEL` overrides), inside the Change's AI budget. Then `apply-resolution` in the scratch
repo, re-evidence, and `reclassifyAfterResolution`. No classification for the head → Lane 2 (unknown escalates).

**Deploy trains.** The train machine runs in the same DO (`MERGE_QUEUE_TRAINS`, default on; "off" = one
RolloutWorkflow per Change, as before). The shell reuses the rollout pieces rather than a second implementation:
`Flags`, `Deployer` (upload, `setSplit` stages, rollback), `Telemetry` + `evaluateHealth`, `openRevertChange`.
- One train per Worker: the repo's `deployTarget`.
- A Change shares a train only if its own code reads its flag (`change-<id>` or `isChangeEnabled(…, "<id>")`).
- The alarm advances stages, turns a regression into `IssueReported` (Workers Issues with stack frames go there
  too), and a cleared killed flag into `RegressionCleared`.
- Automatic reverts are enqueued as `revert` + `automaticRevert`, which freezes the queue until they land.

**Agent API.** `enqueue`, `queue_status`, `wait_for_merge` (≤ 55 s), `dequeue`, `reprioritize` and `queue_overview`
have MCP/HTTP parity. The author, the human owning the authoring agent, or a reviewer may act on an entry.
- SSE `GET /api/v1/repos/{id}/queue/events` (ids = event sequence, resumable).
- Freeze and thaw are human-only, with the platform signing the document on the human's behalf, as for plan
  approvals.
- 27 MCP tools, so `search_tools` was added (fuzzy over names and descriptions, with example calls).

**Not done / known gaps.**
- No post-merge checks run on main: main only advances to tested trees, so `PostMergeCheckFailed` has no producer
  yet.
- Scratch-repo refs (`refs/heads/mq/*`) are not GC'd (only main's `refs/queue/*` are); recreate the scratch repo if
  it grows.
- Per-test failure names need the engine to report them on `status()`; until then failures are whole-run.

## 2026-10-02 — O6 onboarding eval: design and decisions

- **Hosting.** A Worker `gittifacts-evals` with an `EvalMatrixWorkflow` and an `EvalRunWorkflow` per run. An
  `EvalSandbox` container gives tasks 1–3 a shell; task 4 has none.
- **Inputs are fixed.** The task texts are verbatim from the spec, and the system prompt is only the `/start` line.
  We never tune either.
- **Providers.** Two, both through the AI binding and AI Gateway: Moonshot `@cf/moonshotai/kimi-k2.7-code` and OpenAI
  `@cf/openai/gpt-oss-120b`. Native tool calling was verified live on both, and a JSON-action fallback is available.
- **Cadence: on demand only (user decision).** A full matrix (4 tasks × 2 models × 5 runs) costs about $18. There
  is no cron. Start a matrix with `POST /runs` before tagging a release; the `evals-gate` workflow on `v*` tags fails
  if the latest complete matrix is missing, more than 36 h old, or misses a gate.
- **Task 4 (lead decision).** It gates on task 1's checks plus zero `shell` calls. `open_workspace` use is recorded but
  not required, because the workers-api template already satisfies task 1.
- **Platform fixes from the eval design review,** tracked as eval-driven fixes:
  1. Red/green proof counts pre-existing tests that fail on base and pass on head. Without that, a source-only fix of
     a failing test can never be `proven` (task 2).
  2. Signed eval traffic (HMAC of the run id) is rate-limited per eval run instead of per IP/ASN. The global creation
     cap and every other unclaimed limit still apply.
  3. A read-only `PLATFORM_AUDITORS` grant lets the checker read every project once repo membership ships.
- **Live runs.** These wait for unclaimed creation to be switched on, which in turn waits for repo membership.

## 2026-10-02 — M4 live: project Workers, flags in user code, regressions always end in a revert

**Deploy target** (`PATCH /api/v1/repos/{repoId}/deploy-target { script }`, human with repo:admin, audited
`repo.deploy-target-set|cleared`). Claimed projects only: unclaimed ones get 403 `unclaimed-limit` (the store guard
stays the last line of defence). Project Workers run in the platform's own account, so the Worker is always
`gf-<repoId>-<script>` (`script` = `^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$`). A project can never name the platform's
Worker (`gittifacts`) or another project's, and `gf-` is reserved for project Workers. No MCP tool: MCP callers are
agents, and agents can't hold repo:admin.

**First deploy and script settings** (`WorkersDeployer`). A missing script is created with `PUT
/workers/scripts/{s}` (the bundle at 100%; the response's `deployment_id` is the version), and workers.dev is turned
on. Later versions are `POST …/versions` + percentage deployments, as before. Every upload `PATCH`es
`script-settings` with `observability: { enabled, head_sampling_rate: 1, logs: { enabled, invocation_logs },
issues: { enabled } }`, because rollout health reads Workers Logs per version and a script without them could never
regress. `currentVersions` of a missing script is `[]`.

**Bindings in user Workers.** Every version gets `FLAGS` (Flagship app `FLAGSHIP_APP_ID`) and `VERSION`
(`version_metadata`). A bundle may declare plain vars only (`plain_text`, `json`): any resource binding could reach
the platform's own D1/R2/Workers in this account, so it is refused (`BundleBindingError`) before any API call. The
names `FLAGS` and `VERSION` are reserved. The contract for user code is `isChangeEnabled(env, "<changeId>")`
(templates/workers-api `src/flags.ts`, same semantics as `@app/coordinator/flags`). Without a `FLAGS` binding (tests,
previews, `wrangler dev`), or when the flag is missing or fails to evaluate, the Change counts as on. Known leak:
one Flagship app serves every project, so user code can *read* other projects' change flags (booleans). A Flagship
app per project would close it (10k apps per account).

**A bundle to deploy.** The generated `.platform/ci.ts` never declared the build step's `bundle` artifact, so every
template project's rollout was "skipped: no bundle". It now does for templates whose build output is a modules-only
Worker (`TemplateSpec.deployable`: workers-api only; asset-based templates aren't deployable yet).

**Switchable Changes.** `switchableFlag` also accepts added code that calls `isChangeEnabled` and quotes the Change's
own id, not only `change-<id>` literally. Otherwise a template project's guarded Change would deploy without a flag,
and a train could never switch it off.

**Regressions always end in a revert** (lead decision, platform §4F.3 and merge-queue §4.8):
- *Single-change train.* The version identifies the Change exactly, so `KillFlag + RollbackTrain + RequestRevert`
  happen at once. Before, it only killed the flag and kept the bad version live.
- *Multi-change train.* Kill the most likely flag and watch. If the regression clears, revert that Change. If it
  hasn't cleared after `killWatchMs`, roll the whole train back **and** revert the attributed Change (before: no
  revert).
- *Never revert a revert automatically.* A revert that regresses (more likely an environmental problem) is rolled
  back and left to a human (`deploy.revert-skipped` / `rollout.revert-skipped` + a `regression-detected`
  notification). Reverting it would re-apply the Change that just regressed, and over fakes it ping-ponged.

**Train watch window.** `TrainDeployed` carries an optional `watchMs` (additive). The shell sends `stages ×
stageMinutes + watchMinutes` from the deploy-time policy. Before, the window was fixed when the repo's queue first
started, from whatever policy it had then (60 min with the default policy).

**Rollout timing for the e2e.** Policy is read from BASE, so `scripts/e2e/m4.ts` gets short stages the honest way: the
agent proposes a `.platform/policy.ts` change (`stages [50, 100]`, `stageMinutes 2`, `watchMinutes 3`,
`minRequests 20`, `maxErrorRateIncrease 0.05`). It is Lane 2, a human approves it, and the merge queue merges it
before the deploy target is set. There is no create-time policy override and no agent bypass.

## 2026-10-02 — Red/green proof counts pre-existing failing tests (O6 platform fix)

**Triggered by:** O6 design review 2026-10-02 (no live run yet). Eval task 2 ("Import <repo> and fix the failing
test", fixture `fixtures/imports/clock-api`) must end with red/green proof. `evidence red-green` only looked at
new/changed test files, so the natural fix (one line in `src/clock.ts`, the failing test already there) was
`no-tests` → `red-green.no-tests` (Lane 2), and the task could never pass. Fixed in the platform, not the prompt.

**Semantics.** A test that fails on base and passes on head proves the change, whether the change added it, changed
it, or found it already there. `tests[]` = the new/changed tests (unchanged) + pre-existing tests that fail on base
**as committed** and pass on head (fixed) + pre-existing tests that fail on base and still fail on head (listed, so a
fix that doesn't work is never proven). The verdict rule is unchanged (`proven` iff ≥ 1 listed test is red on base and
all are green on head), so `@app/evidence` only changed docs and a test; the classifier only changed reason texts.

**How (apps/sandbox).** Base first: the whole suite on a pristine base worktree (nothing overlaid; base's own runner;
head's `node_modules` linked when the dependency graph is identical). Failing files run a **second** time and only
failures in both runs count: a flaky failure would otherwise be a false proof of any claimed fix. Then head's test
files are overlaid and the new/changed test files run (as before); head runs the new/changed files plus the files of
base's failures. Not reused from `evidence test-run`: each evidence command is its own process with its own scratch
directory, and running base first means a healthy main costs one base suite run and no extra head run.

**Bounds.**
- A pre-existing test whose file fails to load on base is `error` there (base was broken; a fix of that is a fix).
  The pristine checkout matters: with head's support files overlaid, an unchanged test could fail to load on base
  only because of the overlay, which would be a false red.
- The scan never installs dependencies on its own. When base and head install different graphs and there are no
  new/changed tests, it is skipped with a note (an install just to look, and a base with head's deps would not be
  base as committed). Likewise without a supported runner or with the tree not at head: `no-tests` + a note, never
  an error, i.e. exactly the old result. It can only add a proof or block one.
- A base failure with no result at head (deleted, renamed, skipped) is noted, not listed. Regressions (pass → fail)
  are `test-run`'s job, not red/green's.
- Cost: every Change now runs base's suite once (twice for failing files). Fixture `bugfix-without-test` stays
  `no-tests` → Lane 2 (its seeded bug isn't caught by any base test); the 9-fixture e2e is unchanged, and a new e2e
  (`apps/sandbox/test/import-fixture.e2e.test.ts`) proves clock-api's source-only fix.

**Follow-up (not in this change, other owners):** AGENTS.md (`packages/conventions/src/agents-md.ts`, templates) still
says a fix "must add or change a test", and the `red-green-missing` fix hint says "adds or changes no test". Both are
still a valid way to get proof, but they should also say that fixing an already failing test counts.

## 2026-10-02 — Marketing landing page at `/` for visitors without a session

**Context.** `/` served the SPA, which shows the sign-in form to anyone without a session; the product
had no page that explains itself to a person arriving from a link. Agents already get the machine
guide from `/` by content negotiation.

**Decision.** `packages/web/landing.html` is a second Vite entry, prerendered to static HTML at build
time (`landing.vite.ts` loads `src/landing/render.tsx` through Vite's module runner); the browser gets
the HTML, one stylesheet and about 1 KB of JS (copy buttons, theme switch, phone menu). The Worker's
`GET /` (`apps/platform/src/routes/front-door.ts`) serves it from ASSETS at `/landing` when the request
wants HTML and carries no valid better-auth session (`getSessionCookie` + `getSession`); signed-in
people and `?mock` get the SPA; JSON/markdown requests still get `/start`. `Vary: Accept, Cookie`,
the existing `Link` headers and `<link>` tags stay, and the page's absolute URLs (canonical, Open
Graph, the copyable `/start`, `/mcp` and keys URLs) are rewritten to the request origin with
HTMLRewriter. The page extends DESIGN.md's world rather than forking it: same tokens and components
(lane tags, verdict marks, the observation chart), plus a marketing type scale and the case tag.

**Consequences.** Every claim on the page is either measured on the live platform (time to first green
36–48 s, push to signed evidence ~50 s, tour ~$0.015) or labeled demo data; the example change is the
`chg_fx2r7` mock fixture and the screenshots are captured from mock mode, so they must be recaptured
if that fixture changes. The platform test for `/` needs a fresh `packages/web` build (it reads
`dist/landing.html` through the ASSETS binding).

## 2026-10-02 — Creation limits key signed eval traffic by run (O6 platform fix)

**Triggered by:** O6 design review 2026-10-02 (no live run yet). Every eval agent reaches the platform from
Cloudflare's Worker egress (shared IPs, one ASN), so the per-IP (3/hour, 10/day) and per-ASN creation buckets would
let a 40-run matrix create about 3 projects an hour: most runs would fail on `rate-limited`, which measures the
egress, not the onboarding.

**What.** The evals Worker already sends `x-gittifacts-eval-run: <runId>` and `x-gittifacts-eval-sig:
hex(HMAC-SHA-256(EVAL_TRAFFIC_SECRET, runId))` (apps/evals/src/env.ts). `src/limits/eval-traffic.ts` recomputes the
HMAC with the platform's copy of the secret and compares in constant time (`crypto.subtle.timingSafeEqual` over two
64-character hex strings). Verified → `AnonymousClient.evalRun`, and `creationKeys` uses `eval:<runId>` (bucket
`creation.evalRun`, 3 per 7 days: "3 per run", since runs last minutes) **instead of** the IP and ASN keys. The
`global` buckets are always taken, so eval traffic can never exceed the platform-wide cap. Everything else is an
ordinary unclaimed project: the creator IP hash (per-IP quotas), CI/storage/ops quotas, egress, TTL, no Lane 0, no
production. Eval-keyed creations carry `creator.evalRun` in their `project.unclaimed-created` audit event.

**Fails closed to the normal keys:** no secret on the platform, a secret under 32 characters, a malformed run id
(`[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`) or signature, or a mismatch. Unverified attempts go to Workers Logs
(`eval-traffic-unverified`), not to the audit log (unauthenticated input must not write the audit chain).

**Bounds.** The signature is a static per-run token (the evals side signs only the run id, no timestamp): a leaked
pair is worth one run's budget, 3 projects a week, under the global cap; rotating the secret on both Workers revokes
all pairs. Two touches outside `limits/`: the MCP backend's `AnonymousExtra` schema carries `evalRun` (zod would strip
it otherwise, and MCP is how most agents create projects), and the creation audit payload.

**Likely next stumble (not changed, by design):** per-IP *quotas* still aggregate by the creating IP, which is the
shared egress for every eval project: 120 CI minutes/day, 600 Artifacts operations/day and 500 MB storage across all
eval projects created that day. A full matrix may hit the CI-minutes one; if a run shows `quota-exceeded` with
`scope: ip`, that is the next platform fix (e.g. the same signed run as the quota key).

## 2026-10-02 — External integrations: deploy platforms connect to gittifacts (docs/prompts/04-integrations.md)

**Integration principals.** `Principal.kind` gained `"integration"` (additive, `@app/domain`). Each installation has
its own integration principal, owned by the installing human, with explicit `repoIds` re-resolved on every request.
It is never unrestricted: no list means no repos. We didn't reuse `"agent"`, because an agent kind would have put
installations in the human's Agents list and in the ownerless-agent (unclaimed) and MCP code paths. Every approval
and review check is `kind === "human"`, so an integration fails all of them. The repo-access chokepoint gives an
integration `reader` on its installation's repos while the installer is still a member.

**Scopes.** `Scope` gained four integration-only scopes (`IntegrationScope` = those four + `repo:read`):
- `contents:read`
- `webhooks`
- `deployments:write`
- `checks:write`

Scope lists elsewhere stay as they were:
- humans' default scopes exclude these four;
- the agent consent screen's "never" list excludes them too (it shows only the approval class);
- `parseRequestedScopes` still rejects them for agents.

The scope string an integration may request is a subset of what it registered. Approval and write scopes are
rejected by name. `checks:write` is grantable, but there is no checks endpoint yet (follow-up: a raise-only
`external-check` evidence kind plus classifier support).

**OAuth.** Integrations use the O4 authorization server (`/api/oauth/authorize|token|revoke`), dispatched by
`client_id`:
- **Clients.** Registered client ids are `gtic_…` (no CIMD). Clients are confidential (`client_secret_basic` or
  `_post`, exactly one method) or public.
- **PKCE.** S256 is required for every integration client, confidential ones too.
- **Audience.** `<origin>/api` only; `/mcp` is refused, and `gti_` tokens don't verify at MCP.
- **Separate requests table.** Install requests live in their own `integration_authorizations` table, so agent
  consent and integration installs can never cross.
- **Access tokens.** `gti_…` rows in `agent_tokens` (1 h, audience api, `session_id` = the installation's
  `agent_sessions` row).
- **Refresh tokens.** `gtir_…` in `oauth_refresh_tokens`, rotated on every use and good for 180 days after the
  last rotation. Replaying a spent refresh token or code revokes every token of the installation; the
  installation itself stays.
- **Revocation.** RFC 7009 revoke for integrations revokes just that token.
- **Metadata.** AS metadata now advertises `client_secret_basic`/`client_secret_post` and the integration scopes;
  the O4 test was updated to match.
- **Secrets.** Client secrets (`gtis_…`) are SHA-256 only. At most two can be active while rotating, and the last
  one can't be revoked.

**Installations.**
- **Shape.** An installation is integration × account (human; `account_kind` leaves room for orgs) × repos, with
  one active installation per (integration, account). Approving again updates its repos.
- **Created at approval, before the code exchange.** That time is when `installation.created` is sent.
- **Who may install.** Only an **owner or maintainer of a claimed repo**.
- **"All repositories".** Every claimed repo the account owns or maintains, now and later, evaluated per request.
- **Uninstall.** Access and refresh tokens are revoked, the principal is disabled (so the next request fails),
  the session is revoked and pending deliveries are cancelled. `installation.deleted` is the last event sent.
- **Audit.** Every install, update, uninstall, token issue/revocation and deployment report is audit-logged.

**Git URL naming.**
- `https://<host>/git/<owner>/<repo>.git`: `<repo>` is the repo name, which is unique in the Artifacts namespace.
  `<owner>` is the owner's **handle**: assigned once on first use from a slug of the claimer's name (`-2`, `-3`… on
  collision), stored in `account_handles` and stable after that.
- A Change's fork: `/git/<owner>/<repo>/changes/<changeId>.git`.
- Unclaimed projects have no git URL.

**Git proxy.** Smart-HTTP `git-upload-pack` only (protocol v1 and v2 pass through):
- **How it serves.** The Worker mints a 5-minute Artifacts **read** token per request (never returned) and
  streams the exchange.
- **Who may clone.**
  - Integration tokens with `contents:read`.
  - Agent tokens (`gtf_…`) with `repo:read` whose audience includes the API.
  - Human browser sessions are not git credentials; humans clone with an agent token.
  - The chokepoint decides the repo.
- **Credentials.** Basic (`x-access-token:<token>`, or the token as the username) or Bearer.
- **No push.** `git-receive-pack` is refused (403 `read-only`) for every caller.

**Webhooks.** Event sources, without touching the coordinator's logic:
- **Change events.** `buildPorts` wraps the Store:
  - an insert sends `change.created`;
  - a status, head, lane, evidence or tour update sends `change.updated`;
  - `merged` and `reverted` get their own events.

  Emission is best effort and never fails the write.
- **Push.** The PushRouter got an optional `onPushEvent` runtime observer (a coordinator hook in its own commit).
  It covers the default branch and change forks; deletes, tags, notes, queue refs and the rebase branch are not
  `push`.

Delivery:
- **Rows.** One delivery row per covering installation that holds `webhooks` and is subscribed, sent through the
  `WEBHOOK_QUEUE` (at least once).
- **Signing.** `X-Gittifacts-Signature-256: sha256=HMAC(secret, raw body)`.
- **Retries.** 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h; the 8th failure marks the delivery `failed`.
- **Duplicates.** A lease stops two consumers sending the same delivery.
- **Sweep.** The cron re-queues deliveries more than 5 minutes overdue.
- **Redeliver.** A redelivery is a new row that keeps `X-Gittifacts-Delivery`.
- **Webhook secrets.** Needed in plaintext to sign, so they are sealed with AES-256-GCM under
  HKDF(`BETTER_AUTH_SECRET`). **Rotating `BETTER_AUTH_SECRET` makes every stored webhook secret unreadable:
  developers must generate new ones.**

**Deployments → evidence.**
- **Reports only.** Platforms report what they deployed; nothing deploys on their say-so.
- **Previews.** A successful **preview** becomes `preview:<integrationId>` (`kind: "preview"`, status ok, `url`,
  new optional `source: { kind: "integration", id, name, deploymentId, logUrl }` in `@app/evidence`, still
  standalone). The platform re-signs the bundle with the same id, base and creation time.
- **Never reclassified.** Nothing is reclassified, so a preview never lowers (or raises) a lane.
- **Before CI seals.** If the head's bundle isn't sealed yet, the deployment waits as `pending`. When the
  coordinator seals that head (or re-seals it), the Store wrapper adds every successful integration preview.
- **Production.** Recorded as audit `deployment.production` on `change:<id>`, which is the rollout timeline. A
  failure carries its log link. Without a `changeId`, the Change is matched by `mergedSha`.
- **Refusals.** Unclaimed repos are refused.

**Rate limits.** `INTEGRATION_LIMITER` (Workers Rate Limiting, 600/min per integration across its installations;
API and git proxy) answers 429 `rate-limited`. It is per location, the binding's semantics, which is good enough
for a request-rate guard.

**Unclaimed projects and writes (the stop condition).** No path lets an integration push, approve or deploy, from
an unclaimed project or any other:
- integration scopes contain no write, review or approval scope;
- `git-receive-pack` is always refused;
- deployments are records, not deploys;
- unclaimed repos are never installable, have no git URL and refuse deployment reports;
- the chokepoint gives integrations `reader` at most.

**Known gaps.**
- No `checks:write` endpoint yet.
- Repo-selection changes don't send an `installation_repositories`-style event.
- The handle is derived from the claimer, not from the current owner: ownership transfer keeps the URL.
- Delivery rows and expired `gti_` token rows need a periodic purge.

## 2026-10-02 — Incident: claimed-repo inserts returned 500 in production (hotfix deployed)

**What happened.** Commit 37de9a5 put a raw drizzle `db.run(...)` inside a D1 `db.batch([...])`. `run` executes immediately and
returns a promise, not a batch item, so every claimed-repo insert and every claim failed with
`Cannot read properties of undefined (reading 'bind')`. That took down human and agent `create_project`. It shipped because
deploys gated only on typecheck.

**Fix.** f72cec8 batches a drizzle insert builder, and 816dac7 adds a regression test against real D1. They were deployed as a
**hotfix branch** (`hotfix/insert-repo-membership` = live 9719c49 + those two commits), not from main. Main also carried
in-progress access-control work whose own tests were red. The hotfix was verified live with a `create_project`.

**Gate exception.** The hotfix gate showed 185/187 platform tests passing. The two failures are pre-existing on the live
commit, sit in `unclaimed-claim.test.ts`, and cover a feature switched off in production (unclaimed creation). We deployed
anyway because the hotfix only removes a P0 and changes nothing else. The access-control agent owns fixing those two tests.

**Prevention.** `scripts/deploy-clean.sh` now gates every deploy on `pnpm -r typecheck` plus the full platform test suite at
the exact commit. `--skip-tests` is for emergencies only and needs a recorded reason. Store changes need workerd tests
against real D1.

## 2026-10-02 — Repo membership: basic access control (one chokepoint, `apps/platform/src/access/`)

**Why.** Until now repo access was decided by global scopes only, and every signed-up human holds all of them: anyone
could list every repo, read every change, evidence package, tour and audit event, and approve plans and review changes
on repos they have nothing to do with, unclaimed projects included. That broke least privilege and "humans approve
intent" (the human must be one the repo trusts).

**Model.** `repo_members(repo_id, principal_id, role, added_by, added_at)`; roles `reader < reviewer < maintainer <
owner`. Only humans are members. Needs and the least role that meets them:

| need | role | what |
|---|---|---|
| `read` | reader | repo, plans, changes, diff, evidence, tour, rollout, issues, reviews, queue, members, blobs, SSE, its audit events |
| `contribute` | reviewer | create_plan, start_change, push tokens, request_review, workspaces, enqueue/dequeue/reprioritize, propose_platform_config, withdraw own plan |
| `review` | reviewer | submit a review on a change |
| `approve` | maintainer | approve/reject a plan, kill switch on a rollout |
| `admin` | owner | members, deploy target, Lane 0, merge-queue freeze/thaw/resume |

`contribute` sits at `reviewer`, not `reader`: on this platform humans don't write code, their agents do, so the
person whose agents open Changes is a reviewer of the repo; a reader is an observer (stakeholder, auditor) whose
agents can read and nothing else. Separation of duties stays where it was: no principal approves its own Plan or
Change; an owner approving its own agent's Change is allowed and recorded (`approverOwnsAuthor`, `viaOwner`).

**Effective role** (`effectiveRole`/`repoAccess`): system → owner everywhere. Human → its membership row; none on an
unclaimed project (nobody is a member until someone claims it, so **no human can review or approve anything in an
unclaimed project**). Owned agent → its owner's role, only within `repoIds` when set (outside: 403
`repo-not-granted`, as in O4); global scopes stay a second ceiling (`NEED_SCOPES`), and review/approve/admin are
humans-only, so an agent tops out at read + contribute. Ownerless agent (O3) → `reviewer` on its own unclaimed project
only (enough to contribute; it still can never approve). Integration → `reader` on its installation's repos while the
installing human is still a member (`restrictedRepoIds`, fail closed). Platform auditors (below) → `reader`
everywhere.

**Errors.** A repo the caller cannot read answers exactly like a missing one: 404 `not-found` with the same message
and fix for repos, plans and changes (a 403 would confirm the id exists). A visible repo without the role is 403
`insufficient-role` (`details: { repoId, role, needed }`, fix: `list_members`); the agent/human and scope ceilings
keep `forbidden` / `insufficient-scope`.

**One chokepoint, applied in layers.**
- `requirePrincipal(scopes, { need? })` → `assertRouteAccess`: the repo of every `{repoId}`/`{planId}`/`{changeId}`
  path param, JSON body `repoId`/`planId`/`changeId`, and audit `subject` must allow the route's need (derived from
  its scopes: repo:admin/policy:admin → admin, plan:approve → approve, change:review → review, plan:create/
  change:create → contribute, else read; the kill switch passes `need: "approve"`). This covers every route,
  including those of other modules (queue, import, workspaces, integrations) without editing them.
- Services re-check on what they load (`assertRepoAccess` / `assertChangeAccess` / `assertPlanAccess`): every
  read in services/changes.ts, plans.ts, repos.ts take the caller now. Checks are memoized per request.
- Listings filter: `GET /repos`, `list_repos`, capabilities/whoami (with the caller's `role` per repo and actions
  from role × scopes), the OAuth consent repo picker (it listed every claimed repo to anyone), blobs
  (404), audit (one SQL condition: events on repos you can read and their plans/changes, events about yourself and
  your agents; platform-wide subjects only for `PLATFORM_ADMINS`; auditors and the system see everything).
- MCP: `scoped()` checks every tool's target (default `read`), and every mutation goes through `idem`, which demands
  `contribute` on the target its `scoped()` named; create_plan/start_change/refresh_push_token pass `contribute`
  explicitly.
- Coordinator: an optional `RepoAccess` port (`Ports.access`) that the facade asks on startChange,
  refreshPushGrant, abandon (own: contribute, others': review), submitReview (review), kill (approve), setLane0
  (admin), startBootstrapChange (contribute), waitFor/watchChange (read); `hidden` answers like a missing
  repo/change. The platform wires it in `getCoordinator`; the system principal is never asked.

**Other platform-wide surfaces closed on the way.** The OAuth consent repo picker listed every claimed repo to any
signed-in human (now: claimed repos the human is a member of). `GET /principals/{id}` showed any principal's
scopes and repo grants (now: principals you share a readable repo with, your own, your owner; else 404).
`/internal/ttfg` (every project's id and timings) is for `PLATFORM_ADMINS` and auditors, and
`POST /admin/seed-cache` for admins: both were open to every human, who all hold `repo:admin`.

**Membership API.** `GET /api/v1/repos/{repoId}/members` (anyone who can read; e-mails only for owners),
`POST …/members { email | principalId, role }` (human owner; adds an existing user, or changes a role; 201/200),
`DELETE …/members/{principalId}` (owner, or a member leaving). The last owner can never be removed or demoted: the
guard is inside the DELETE/UPDATE statement, so two owners removing each other at once cannot both win (409).
Audited as `repo.member-added`, `repo.member-role-changed`, `repo.member-removed` on `repo:<id>`. MCP parity is
read-only (`list_members`); managing members is a human act. Web: repo → Members.

**Owners.** `D1Store.insertRepo` makes a claimed repo's `claim.ownerId` (the creator, or an agent's owner) an `owner`
member in the same D1 batch; `updateRepo` does the same when the claim owner changes (claiming). The owner must be a
human principal (checked first, so the FK can never sink the repo write). `claim.ownerId` stays the record of who
created/claimed it; access is `repo_members`. Migration 0009 creates the table and backfills an owner for every
claimed repo (claim owner, else the human creator, else the creating agent's owner); repos with none of those stay
reachable only by the system and auditors.

**Platform auditors (`PLATFORM_AUDITORS`, comma-separated principal ids, humans or agents).** Read-only access to
every repo, unclaimed projects included, and the whole audit log — for the onboarding eval's checker. An auditor is
refused on every mutation: any non-GET route through `requirePrincipal`, create_project/POST /repos, and every MCP
mutation (its role is `reader` everywhere, even on repos it is a member of). Use a dedicated principal.

**Deviations.** `DELETE` names the member in the path (`/members/{principalId}`) rather than the body. Agents and
integrations are not member rows (their access always derives from a human's row). Integration-only scopes count as
`read` for the repos of an installation (the route's own scope list still applies). The O3 note "any signed-in
human can review an unclaimed project's Changes" is closed by this entry.
