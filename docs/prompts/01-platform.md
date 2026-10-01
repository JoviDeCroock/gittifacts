# Build: an agent-native git platform on Cloudflare

You are building the first working version of a git platform designed for a world where coding agents write most of
the code. You own the implementation end to end: architecture, code, tests, and a working deploy. Work autonomously.
Stop only for the conditions listed under "When to stop and ask".

## 1. Why this exists (read this first; it drives your judgment calls)

The software lifecycle was: explore → plan → implement → test/QA → production monitoring. Agents have collapsed
implementation, and they are collapsing testing and monitoring. What stays scarce is **human attention**, and it should
go mostly to exploration and planning.

GitHub's core unit, the pull request, assumes a human wrote the diff, so a human must read the diff. This platform
replaces that with one rule:

> **Humans approve intent. Machines prove conformance. The platform routes each change to the cheapest review that is
> still safe, and makes changes easy to undo after merge.**

Concretely:

1. The unit of work is a **Change**: intent + diff + evidence. It is not a PR.
2. Human approval happens upstream, at the **Plan**. Diff review becomes a conformance check against the approved plan.
3. Every Change gets a **risk lane**, computed by the platform from objective signals. The authoring agent's own claim
   ("just a bug fix") is an input, never the decision.
4. Lane 0 changes merge without a human. That is safe because of reversibility: gradual rollout, a feature flag per
   change, production issue detection, and automatic revert.
5. When a human does review, they get a **guided tour** written by a *separate* reviewer agent. The tour is ordered by
   risk, every claim is anchored to evidence, and it must say what it is unsure about.

If a design decision isn't covered below, choose whatever best serves this rule.

## 2. Platform primitives (state as of 2026-10-01)

These APIs are new, and several are in beta. Before coding against any of them, check the current docs
(developers.cloudflare.com, the package's type definitions, the changelog). Where they disagree with this prompt, the
docs win. Record the difference in `DECISIONS.md`. (Verified notes live in `docs/research/`.)

| Primitive | Status | Use it for |
|---|---|---|
| **Artifacts** (git-compatible versioned storage) | Open beta; billing starts 2026-10-15 | All repo storage. One cheap fork per agent task. create, get, import (from GitHub), fork({ readOnly }), repo-scoped tokens, git smart HTTP v1/v2, **git-notes**. Namespaces choose a US or EU jurisdiction. |
| Artifacts events (`cf.artifacts.repo.pushed`, plus create/fork/clone/fetch) | Beta | Trigger CI and Change updates (via Queues or workflow triggers). |
| **`@cloudflare/ci`** (CI SDK on Workflows) | **Private beta** | Pipelines written as TypeScript: `ci.runner({ name, command, cache: { inputs } })`, chained `deps.runner(...)`, `Promise.all` for parallel steps, restart from a step, `HealingAgent`. |
| **Workflows** | GA | Durable orchestration of each Change's lifecycle. |
| **Containers via `ctx.container`** (`scheduling_policy: "durable_object"`) | Public beta | Build/test sandboxes. Choose image and instance type at runtime. `snapshotContainer()` for warm dependency snapshots. The legacy `Container`/`Sandbox` classes are only maintained until 2026-12-31: **use `ctx.container` only.** |
| ArtifactFS | Open source | Blobless, on-demand checkout inside sandboxes (fast starts). |
| Durable Objects, D1, Queues, R2, KV | GA | State, metadata, fan-out, caches and logs. |
| Workers Builds + **Preview URLs** | GA | A preview deploy per Change. |
| **Gradual Deployments** | GA | Percentage rollouts of merged changes. |
| **Flagship** (feature flags, OpenFeature-compatible, Workers binding) | Available | A flag per Change. Instant kill switch without a redeploy. |
| **Workers Issues** (`observability.issues.enabled`) | Open beta | Grouped production errors that include the Worker version, sent through a generic webhook. Used to tie regressions back to a Change. |
| Workers Logs, Analytics Engine, OTel/Agent Traces | GA / new | Monitoring after merge, metrics, and agent session traces as evidence. |
| Browser Run | GA | Before/after screenshots of preview URLs for tours. |
| AI Gateway (+ Auto Router) | GA / new | All model calls for the reviewer agent, the tour writer, and the classifier's optional LLM signals. |
| `cf` CLI + `cloudflare.config.ts` | Open beta | Typed config with `bindings.*` and `triggers.*`. Use it if it supports every binding you need; otherwise use `wrangler.jsonc`. Note which you chose and why. |

**Hard rule about private beta:** put CI behind an interface (`CiEngine`) with two implementations,
`CloudflareCiEngine` (using `@cloudflare/ci`) and `WorkflowsCiEngine` (built directly on Workflows + `ctx.container` +
R2 snapshot caching, with the same step semantics). Choose one at runtime from config. The fallback must be complete,
not a stub. Apply the same pattern to any other primitive that turns out to be unavailable.

## 3. Domain model

```ts
Repo        { id, namespace, artifactsName, defaultBranch, policy: RepoPolicy }
Plan        { id, repoId, title, intent, acceptanceCriteria[], outOfScope[], riskDeclarations[],
              status: draft|approved|superseded, approvedBy, approvedAt }   // the main human checkpoint
Change      { id, repoId, planId?, baseSha, headSha, forkName, author: Principal, status, lane?, laneReasons[],
              evidenceId?, tourId?, flagKey?, mergedSha?, rolloutState?, revertedBy? }
Evidence    { changeId, headSha, items: EvidenceItem[], attestation }  // signed
EvidenceItem = RedGreenProof | TestRun | CoverageDelta | MutationScore | PublicApiDiff | DependencyDiff
             | SensitivePathHits | PreviewDeploy | Screenshots | AgentTrace | ReproducibleTransform
Tour        { changeId, stops: TourStop[], leastConfident[], notDone[], generatedBy }
TourStop    { title, why, hunkRefs[], evidenceRefs[], verdict: proven|unproven|risk }
Principal   { id, kind: human|agent, name, keys[], scopes[] }   // agents are first-class
AuditEvent  { at, principal, action, subject, payloadHash, signature }  // append-only
```

Store evidence and attestations as **git-notes** on the head commit (`refs/notes/evidence`) as well as in D1, so the
evidence travels with the repo. Keep the evidence/attestation module a **standalone package** with no dependency on the
rest of the app, so it can be extracted as its own product later.

## 4. Core flows

### A. Plan → approval
An agent or human drafts a Plan (API/MCP). A human approves it. Approval is signed. A Change that references an approved
Plan is checked for conformance against that Plan. A Change without a Plan can still reach any lane except Lane 0, unless
the repo policy allows Lane 0 without a Plan for narrow categories (e.g. dependency patch bumps).

### B. Agent works on a Change
1. `POST /changes` with `planId` → the platform forks the repo in Artifacts (`task-<id>`) and returns a remote and a
   scoped, short-lived token for that fork only.
2. The agent pushes. `cf.artifacts.repo.pushed` → a Change-coordinator Durable Object → starts that Change's Workflow.
3. Pushing again cancels or supersedes the in-flight run for an older head.

### C. CI → evidence
The pipeline is declared per repo in TypeScript (`.platform/ci.ts`), with defaults for JS/TS projects (install, lint,
typecheck, test, build). On top of the user's steps, the platform always runs these evidence steps:

- **Red/green proof.** For a Change claiming a fix: run the new or changed tests against `baseSha`, then against
  `headSha`. They must fail on base and pass on head. A fix without this proof cannot go to Lane 0.
- **Coverage of changed lines** and **mutation score on changed lines** (Stryker or equivalent; changed files only, so it stays fast).
- **Public API diff.** For TS packages, generate `.d.ts` for base and head and diff the exported surface: none / additive / breaking.
- **Dependency diff.** Added, removed or major-bumped deps; new install scripts.
- **Sensitive path hits** against `RepoPolicy.sensitivePaths` (auth, payments, migrations, CI config, the policy file itself).
- **Preview deploy** + **Browser Run screenshots** of the affected routes, before and after.
- **Reproducible transforms.** If the Change declares a codemod or generator (`.platform/transforms/*`), re-run it on base
  in a clean sandbox. Byte-identical output means those hunks are verified and hidden from human review.
- **Agent trace** reference (OTel/Agent Traces), if the agent supplied one.

`HealingAgent`-style auto-fixes for CI failures are allowed. They produce **new commits on the Change**, which re-run the
full pipeline and are re-classified. Healing never approves anything.

Sign the evidence bundle (Ed25519 via WebCrypto, platform key in Secrets) over `{changeId, headSha, items}`.

### D. Risk classifier → lane
A pure, deterministic, explainable function `classify(evidence, policy, plan, diffStats) → { lane, reasons[] }`, with
exhaustive unit tests. LLM judgments may only be signals that **raise** the lane, never lower it.

- **Lane 0, auto-merge.** Every condition holds: approved Plan (or a policy-allowed category); red/green proof for fixes;
  public API diff = none; no dependency changes beyond policy; no sensitive-path hits; changed-line coverage and mutation
  score at or above the policy thresholds; diff size under the threshold; no out-of-scope findings.
- **Lane 1, async glance.** Additive API changes, moderate size, or missing optional evidence. A human approves the tour,
  on mobile if they want.
- **Lane 2, full review.** Breaking API, sensitive paths, new dependencies, migrations, failed or missing red/green proof
  on a claimed fix, scope drift, or any signal the classifier can't evaluate.

**Unknown → escalate.** Any missing or errored signal raises the lane. Never default downward.

**Shadow mode by default.** Each repo starts with Lane 0 *disabled*. The classifier still computes its lane, and the
platform records whether the human reviewer agreed. The repo owner can enable Lane 0 once there is enough agreement
history (configurable threshold, shown in the UI).

### E. Tour
Generated by a **reviewer agent that is not the authoring agent**: separate context, with the model configurable via AI
Gateway. Its input is the plan, the diff and the evidence. It never sees the author's own summary.
- Stops are ordered: intent → behavior before/after → riskiest hunk → the proof for it → what isn't covered.
- Every stop has a `verdict`. A claim without an evidence reference is `unproven`.
- `leastConfident[]` and `notDone[]` are required and must not be empty. If there is really nothing, the reviewer must say why.
- Verified reproducible-transform hunks are collapsed into one stop.
- The tour must be readable on a phone in under 3 minutes for Lane 1.

Validate the tour JSON against a schema. If it fails, regenerate once, then fall back to escalating the lane.

### F. Merge → rollout → watch → revert
1. Merge through a **merge queue** (Durable Object per repo, serialized). Rebase onto the latest main, re-run the cheap
   checks, and fast-forward main in Artifacts.
2. Create a **Flagship flag** per Change where the code supports it (helper `isChangeEnabled(changeId)`). Ship with a
   **Gradual Deployment** (e.g. 5% → 25% → 100%, configurable).
3. **Watch window.** Workers Issues webhook + Workers Logs + Analytics Engine metrics, linked to the Worker version
   deployed for this Change. New issue groups or error-rate regressions past the threshold → turn off the flag → roll back
   the deployment → open an automatic **revert Change** (which goes through the lanes, with a fast path for pure reverts) → notify.
4. Record every step as a signed `AuditEvent`.

## 5. Interfaces

1. **HTTP API**: JSON, versioned, with an OpenAPI spec generated from the route definitions.
2. **MCP server** (remote, on Workers), the main way agents use the platform. Tools: `create_plan`, `start_change`,
   `get_change_status`, `get_evidence`, `get_tour`, `request_review`, `list_issues_for_change`. Tight descriptions, JSON outputs.
3. **Web UI**: Preact + signals, thin, mobile-first. Repo list, plan view/approve, change list grouped by lane, the tour
   (main screen), evidence detail, rollout/watch status, audit log. No social features.
4. **Git**: standard git clients against Artifacts remotes using the scoped tokens the platform issues.
5. **GitHub import**: `Artifacts.import` from a GitHub URL. A mirror back to GitHub is out of scope until after M4.

## 6. Security and identity

- Agents are `Principal { kind: "agent" }` with their own keys and least-privilege scopes. An agent token can push only to
  its own Change fork. **No principal can approve its own Change or Plan.**
- Only the merge queue can write to main.
- `RepoPolicy` lives in `.platform/policy.ts`. Changes to it are always Lane 2 and need a human approval.
- Sandboxes get no production secrets. Preview deploys use preview-scoped bindings.
- Artifacts namespaces default to the **EU jurisdiction** (configurable per org).
- The audit log is append-only and hash-chained, with each entry signed.

## 7. Milestones (each must end green and deployed)

- **M1 – Vertical slice.** Repo create/import on Artifacts; Change lifecycle (fork → push event → Workflow → CI via
  `CiEngine` → stored results); minimal API + MCP `start_change`/`get_change_status`. *Acceptance:* an agent clones a fork,
  pushes a commit, and gets test results through MCP.
- **M2 – Evidence.** Red/green, public API diff, dependency diff, sensitive paths, changed-line coverage, signed evidence in
  git-notes. *Acceptance:* a seeded bug-fix Change shows the test failing on base and passing on head, and the attestation
  verifies with a standalone script.
- **M3 – Classifier + tour.** Lanes with full reasoning, shadow mode, reviewer agent, tour UI. *Acceptance:* the fixture
  suite classifies exactly as expected; the tour for `breaking-api` lists the breaking export as its riskiest stop.
- **M4 – Merge, rollout, revert.** Merge queue, Flagship flag, gradual deployment, Issues webhook, automatic revert.
  *Acceptance:* an end-to-end test deploys a Change that throws for some fraction of traffic, and the platform detects it,
  kills the flag, rolls back, and opens a revert Change with no human involved.
- **M5 – Mutation testing, reproducible transforms, screenshots, Plans as the gate.** Then dogfood: host this platform's own repo on itself.

## 8. Testing

- Vitest with the Workers test integration for Workers, DOs and Workflows. Pure-function, table-driven unit tests for the
  classifier (≥ 40 cases, including every "unknown → escalate" path).
- **Fixture repos** under `fixtures/`: `pure-bugfix-with-regression-test` (L0 once enabled), `bugfix-without-test` (L1+),
  `additive-api` (L1), `breaking-api` (L2), `new-dependency` (L2), `touches-auth` (L2), `codemod-rename` (transform verified),
  `policy-change` (L2 + human approval), `scope-drift` (raised lane).
- Use the real platform in a dev account for M1 and M4 end-to-end tests. Mock only primitives that aren't available, and
  document each mock in `DECISIONS.md`.

## 9. Non-goals

Issue tracker, discussions, stars/social features, a GitHub Actions compatibility layer, a code search engine, billing,
multi-org admin beyond basic membership, GitHub *replacement* features for OSS communities.

## 10. Working agreements

- Keep `DECISIONS.md` (dated ADR entries) and `STATUS.md` (what works, what's mocked, what's next) current at every milestone.
- Typed end to end, strict TS, no `any` at module boundaries. Validate every external input with schemas.
- Small, composable packages: `@app/evidence` (standalone), `@app/classifier` (pure), `@app/ci-engine`, `@app/coordinator`, `@app/mcp`, `@app/web`.
- Be cost-aware: GC merged/abandoned forks; cache dependency snapshots in R2 / container snapshots.
- Every model call goes through AI Gateway with a per-Change budget. Exceeding the budget escalates the lane; never skip silently.

## 11. When to stop and ask

- An account-level action costs money beyond the dev tier or needs beta access you can't get.
- A primitive behaves differently enough from this prompt that the *product rule* in §1 would need to change.
- Anything that would weaken a security rule in §6.

For everything else, decide, record it in `DECISIONS.md`, and keep going.
