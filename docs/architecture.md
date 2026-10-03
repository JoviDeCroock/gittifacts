# Architecture

One Cloudflare Worker (`apps/platform`) hosts the API, the MCP server, the web UI, and the durable
machinery. Domain logic lives in packages behind small ports, so it can be tested without Cloudflare.

```
agents / humans
   │  HTTPS (API, MCP)          git smart HTTP (scoped tokens)
   ▼                                     ▼
┌──────────────────────── apps/platform (Worker) ───────────────────────┐   ┌──────────────┐
│ Hono: /api/v1/*  /api/auth/* (better-auth)  /mcp  /webhooks/*  SPA    │   │  Artifacts   │
│                                                                        │◄─►│  ns: gittifacts-eu
│ Durable Objects                    Workflows                           │   │  repo  <name>│
│  ChangeCoordinator (per change)     PushRouter   ◄── triggers.events   │   │  fork  task-<id>
│  MergeQueue        (per repo)       ChangeWorkflow (per change × head) │   └──────────────┘
│  AuditLog          (per org)        CiRunWorkflow  (per run)           │
│  Runner            (per CI step) ── ctx.container (sandbox image)      │
│  PreviewHost  (per change head) ── ctx.container, behind the preview   │
│               gateway on *.preview.resynapse.dev (banner, noindex)     │
│                                     RolloutWorkflow (per merged change)│
│ D1 (Drizzle)  R2 (logs, screenshots, cache)  AI Gateway  Flagship      │
│ Browser Run   Analytics Engine   Secrets (signing key, CF API token)   │
└────────────────────────────────────────────────────────────────────────┘
```

## Ports (packages/coordinator/src/ports.ts)

The coordinator only talks to these interfaces. `apps/platform` provides the Cloudflare implementations,
and tests provide fakes.

| Port | Cloudflare implementation | What it does |
|---|---|---|
| `Store` | D1 via Drizzle | Repos, plans, changes, runs, evidence, tours, reviews, principals |
| `GitHost` | Artifacts binding + `@app/gitwire` | Create/import/fork/delete repos, mint tokens, diff (via `readTree`/`readBlob`), read files at ref, write notes, transfer objects, CAS fast-forward |
| `CiEngine` | `@app/ci-engine` | Run a pipeline for (change, head), status, cancel, restart-from-step |
| `Reviewer` | `@app/tour` (AI Gateway) | Generate a tour from plan + diff + evidence, plus LLM judgments; enforces the budget |
| `Signer` | `@app/evidence` + platform key | Sign evidence, plan approvals, and audit entries |
| `Deployer` | Workers Versions/Deployments REST | Upload a version, set gradual percentages, roll back |
| `Flags` | Flagship | Create a per-change flag, turn it off (kill switch) |
| `Telemetry` | Workers Issues webhook store + Analytics Engine SQL | Error rate per version, new issue groups per version |
| `Audit` | AuditLog DO | Append a signed, hash-chained event |
| `Previews` | PreviewHost DO (own container app) + D1 `previews` + Browser Run | Boot a change's preview from the CI build snapshot; screenshot it |
| `Onboarding` | D1 `project_onboarding` + Analytics Engine | Time-to-first-green of new projects |
| `Clock` | `Date` | Deterministic time in tests |

## Hosts (core + host adapters)

The platform runs over one shared core in two modes: **native** (Cloudflare Artifacts is the source of
truth) and **GitHub** (code stays on GitHub; M2+). The core never knows which host a change lives on.

```
@app/core            Change, Plan, Evidence, classifier, policy rules, evidence assembly, gradeChange
  ├─ @app/core/evidence   evidence engine + signing (@app/evidence, standalone)
  ├─ @app/core/queue      merge-queue core (@app/merge-queue)
  └─ @app/core/tour       reviewer agent (@app/tour)
@app/host            HostAdapter, HostCapabilities, ChangeRef, normalized events, LaneVerdict, degradations
@app/host-artifacts  native adapter: ArtifactsHost over the coordinator's ports (ArtifactsGitHost, merge queue)
@app/host-github     GitHub App adapter (M2)
@app/host-contract   contract suite: the same scenarios against every adapter
```

| `HostAdapter` | Native (`ArtifactsHost`) |
|---|---|
| `capabilities()` | everything: merge, own merge queue, push to the change branch, git notes, inline stops; identities human/agent/bot |
| `getChange(ref)` | the Change row; `source.fork` is always true (agents only ever write their own fork) |
| `materialize(ref, sha)` | the change fork + a 600 s read token (sandboxes never write) |
| `diff(ref)` | `GitHost.diff(fork, base, head)` |
| `publishVerdict` / `publishTour` | classification + lane on the Change row / stored tour (same helpers as the ChangeWorkflow); stale heads dropped |
| `requestReview` | status `awaiting-review` + notification |
| `merge(ref, { expectedHeadSha })` | head guard (`refused: stale-head`), admission (approved or Lane 0), then the platform's merge queue (`queued`) |
| `revert(sha, reason, { of })` | a revert Change (pure inverse when possible) |
| `events().normalize(raw)` | Artifacts push → `change.updated` (fork) / `main.advanced` (default branch) |

**Grading is shared.** `gradeChange(input, deps)` (`@app/core`) is the pipeline from the CI run to the final
lane: evidence run → evidence (assemble + seal) → judge → evidence on the host → classify → tour → reclassify →
`LaneVerdict`. Its deps are ports (stage runner, evidence runner, sealer, reviewer, spend ledger, data, sink, log,
hooks). The native ChangeWorkflow runs it with each stage as a durable step (same names as before), and the
native-only steps (preview, screenshots, bootstrap, pure-revert checks, git notes) as hooks. GitHub mode runs
the same function, so the same change gets the same lane, evidence and tour.

**Capabilities degrade explicitly.** `routeVerdict` turns a classification into `merge | label-ready |
request-review | blocked`. Without `canMerge`, Lane 0 becomes `label-ready`. Without `supportsNotes`, evidence
is linked instead of written as a git note. Each degradation is recorded in the verdict.

**Contract suite.** `@app/host-contract` defines nine scenarios once (`pure-bugfix-with-regression-test`,
`breaking-api`, `new-dependency`, `touches-auth`, `codemod-rename`, `scope-drift`, `fork-pr`,
`force-push-during-eval`, `stale-head-at-merge`). Their inputs come from `fixtures/` and the classifier
scenarios. Each host drives its real event path and reports what it published. Lane, reasons, routing, exact
evidence kinds and the tour's riskiest stop must match. The native run is in
`packages/host-artifacts/test/contract.test.ts`.

## Change lifecycle

```
POST /changes ──► fork repo → task-<id>; mint write token for the fork only (TTL ≤ 1h)
                   status: awaiting-push
git push (agent) ─► cf.artifacts.repo.pushed ─► PushRouter ─► ChangeCoordinator.onPush(ref, after)
                   coordinator: supersede any in-flight ChangeWorkflow for an older head
                   (terminate its CI run), then start ChangeWorkflow(change, head)
ChangeWorkflow (id = `${changeId}-${head[0..12]}`; steps 4–8 are @app/core `gradeChange`):
  1. diff        GitHost.diff(base, head) → DiffStats + hunks (stored)
  2. policy      policy from BASE (default branch at baseSha), cached per sha
  3. plan-ci     sandbox: evaluate .platform/ci.ts in plan mode → PipelineSpec (or defaults)
  4. ci          CiEngine.start(... user steps + evidence steps); wait for the run sink event
  5. evidence    assemble items (CI outputs + Worker-side items: sensitive paths, preview, screenshots,
                 agent trace); sign {changeId, headSha, items}; store; write refs/notes/evidence
  6. judge       Reviewer.judge(plan, diff) → llm-judgment items (raise-only; within budget)
  7. classify    @app/classifier (pure) → lane, reasons, shadow flag
  8. tour        lane ≥ 1 (and shadow L0): Reviewer.tour(plan, diff, evidence). Never sees the
                 author's summary. Schema-validate; retry once; on failure tourStatus = failed → reclassify (L2)
  9. route       lane 0 (enabled) or verified pure revert → MergeQueue.enqueue
                 else status awaiting-review → waitForEvent("review", 7 days)
 10. merge       wait for MergeQueue "merged" event (or "conflict" → status failing with reason)
 11. rollout     start RolloutWorkflow if the repo has a deploy target
Every transition appends an AuditEvent.
```

Re-pushes start a new `ChangeWorkflow`. Reviews always bind to a specific `headSha`. Approving an
older head does nothing.

## Merge queue (MergeQueue DO, one per repo; the only writer of the default branch)

1. Pop the next approved change. If `main` ≠ `change.baseSha` and the change isn't already on top of
   `main`, rebase in the sandbox. If the rebase is clean, the sandbox pushes the rebased commit to the
   fork, the coordinator re-runs the *cheap* checks (typecheck + tests from the cached install
   snapshot), and the evidence note is re-signed for the new SHA with `rebasedFrom`.
2. `GitHost.transferObjects(fork → main repo, sha, refs/merge-queue/<changeId>)`.
3. `GitHost.fastForward(main repo, refs/heads/<default>, expectedOld, sha)` (CAS). On a stale ref, go back to 1.
4. Copy the evidence note to the main repo's `refs/notes/evidence`. Delete `refs/merge-queue/<id>`.
   Schedule the fork for GC (Artifacts bills per operation from 2026-10-15).
5. Emit "merged" to the change's workflow and audit it.

## Rollout (RolloutWorkflow)

1. `Flags.ensure("change-<id>")`: on, 100%. Code can guard with `isChangeEnabled(changeId)`.
2. `Deployer.uploadVersion(bundle, { tag: changeId, message })`. Remember `previousVersionId`.
3. For each stage in `policy.rollout.stages`: set the deployment split, `step.sleep(stageMinutes)`, then
   `Telemetry.check(versionId, previousVersionId, since)`. A regression means error rate increase >
   `maxErrorRateIncrease` with ≥ `minRequests`, or > `maxNewIssueGroups` new Workers Issues groups
   attributed to the version.
4. Watch window at 100% for `watchMinutes`, checking every minute.
5. On a regression: `Flags.off` → `Deployer.rollback(previousVersionId)` → open a revert Change (pure
   inverse of the merge, `revertOf` set, plan-less, claimed `revert`). That change runs through the
   lanes, and `pureRevertVerified` lets it auto-merge when `policy.autoMergeVerifiedReverts` is on →
   notify → audit every step.
6. Workers Issues webhooks land on `/webhooks/workers-issues`, are verified, stored, and sent to the
   rollout instance with `sendEvent("issue")` so detection doesn't wait for the next poll.

## Identity and security

- Humans authenticate with better-auth (session cookie). Agents use bearer tokens bound to an agent
  `Principal` (`kind: "agent"`) that a human owns; tokens are stored hashed. Scopes are checked per route/tool.
- Artifacts tokens: agents only ever get a write token for **their own fork**. The main repo's write
  tokens are minted only inside the MergeQueue DO, live ≤ 5 minutes, and are never returned.
- No principal approves its own Plan or Change, and an agent's owner can't approve that agent's
  change by proxy if the policy says so (default: allowed, recorded).
- The policy comes from the base branch. A Change that touches `.platform/**` is Lane 2 with
  `requiresHumanApproval`.
- Sandboxes get no platform secrets: only a short-lived read token for the one repo they check out.
- The audit log is append-only. One DO writes it, and each entry is hash-chained and signed with the
  platform Ed25519 key. D1 has a mirror for queries.
- Artifacts namespace `gittifacts-eu` (EU jurisdiction) is the default, configurable per org.
