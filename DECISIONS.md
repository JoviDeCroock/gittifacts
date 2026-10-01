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
