# Build: an agent-native merge queue

This adds to the main platform build (`docs/prompts/01-platform.md`). Read `STATUS.md`, `DECISIONS.md` and the main build
prompt first. This merge queue **replaces** the simple serialized queue in main-prompt §4F. Reuse the existing packages and
security rules.

Work autonomously. Stop only for the conditions in §9.

## 1. Why a new queue

Merge queues were designed for humans: a handful of PRs a day, each one rebased and re-tested one at a time. Agents change
three things:

1. **Volume and concurrency.** Hundreds of Changes per day per repo, many open at once, often touching overlapping code. A
   serial queue becomes the new bottleneck.
2. **Conflicts are cheap to fix.** An agent can resolve a textual conflict in seconds. Kicking a Change out of the queue and
   waiting for a human is the wrong default.
3. **The consumer is a program.** The queue's state, ETAs and rejection reasons must be machine-readable and actionable, not
   a badge on a web page.

**Invariants (non-negotiable; every design choice must keep them):**

- **Main is never red.** Main only advances to a tree that passed every required check on *exactly that tree*.
- **Evidence describes what actually lands.** The evidence and lane that justify a merge are computed on the tree being
  merged (base + Change, after rebase/resolution), not on the Change's original head.
- **Every regression is attributable.** After merge, a production regression can always be traced to a single Change and
  switched off individually.
- **No self-approval, ever.** That includes conflict resolutions written by agents.

## 2. Platform notes (verify against current docs before coding)

- **Queue state:** a Durable Object per repo (`MergeQueue`). It's the single writer for main and for `refs/queue/*`.
- **Batch runs:** one Workflow instance per speculative batch, with containers via `ctx.container`, restored from dependency
  snapshots, and the existing `CiEngine` interface.
- **Atomic main updates:** advance main with a **compare-and-swap ref update**. Git's receive-pack update command carries an
  old-oid; check whether Artifacts enforces it, and write an integration test that proves a stale old-oid is rejected. If
  Artifacts doesn't enforce it, the DO is the only principal holding write access to main. Record this in `DECISIONS.md`
  either way.
- **Speculative refs:** they live under `refs/queue/<batchId>`. Garbage-collect them after merge or eject, because Artifacts
  bills per operation.

## 3. Domain model

```ts
QueueEntry  { changeId, enqueuedAt, enqueuedBy: Principal, priority, lane,
              dependsOn: changeId[],      // stacks
              plangroup?: planId,          // land-together group
              affected: AffectedSet,       // see §4.1
              state: waiting|speculating|resolving|passed|merged|ejected,
              attempts, ejectReason? }
Batch       { id, baseSha, entries: changeId[], mergedTreeSha, refName, ciRunId, state, result, bisectParent? }
AffectedSet { files[], modules[], testTargets[], publicApi: boolean, deploysTo: workerName[] }
EjectReason { code, message, fix: { explanation, call?, command? }, evidenceRefs[] }
```

## 4. Mechanics

### 4.1 Affected sets and the conflict graph
For every Change, compute an `AffectedSet`:
- Touched files.
- Their reverse-dependency closure in the module graph: parse imports for TS/JS, and keep the analyzer pluggable for other languages.
- The test targets that cover the closure (test impact analysis). Use the coverage map from main's last full run, and fall
  back to "all tests" when coverage is missing.
- Whether the public API changes.
- Which Workers it deploys to.

Two Changes **conflict** when their affected sets intersect: shared files, overlapping module closure, or shared test
targets. Build a conflict graph over the waiting entries.

### 4.2 Parallel independent queues
Partition the waiting entries into connected components of the conflict graph. Components with no conflicts can advance
**in parallel**: each one speculates on its own track against the current main, and the DO serializes only the final CAS
updates to main. When a component lands, any track whose base is now stale gets a cheap revalidation:
- If the affected sets truly don't overlap, re-run only the impacted targets on the new tree, then CAS.
- If revalidation fails, fall back to a full run on that track.

Unknown or uncomputable affected sets → treat as conflicting with everything. Never default to parallel.

### 4.3 Speculative batching with bisection
Within a track, use speculative batches (Zuul / Uber SubmitQueue style):
- Batch N is tested as `main + c1..ck`.
- Batch N+1 is tested *on top of* batch N's tree before N has finished.
- Batch size adapts to the recent pass rate and the predicted risk (§4.6).
- When a batch fails, bisect it to find the culprit. Run the halves in parallel and reuse already-passed prefixes.
- Eject only the culprit. Everything else re-forms into new batches automatically.

### 4.4 Agent conflict resolution (instead of ejecting)
When a Change no longer applies cleanly onto the batch base:
1. Spawn a **resolver agent** with the platform's AI Gateway budget, in a sandbox. It sees the Change's Plan, its diff, and
   the conflicting upstream commits and their Plans. It must not be the Change's authoring agent.
2. It produces a **resolution commit** on top of the rebased Change. The resolution diff is stored separately as evidence
   (`ConflictResolution { upstreamChanges[], resolutionDiff, rationale }`).
3. The Change is re-evidenced and **re-classified** on the merged tree:
   - The resolution can only keep the lane the same or raise it.
   - A resolution that touches lines outside the conflict hunks goes to at least Lane 1, and the tour gets a
     "conflict resolution" stop.
4. If resolution fails twice, or the budget runs out → eject with a machine-readable reason and a `fix` hint aimed at the
   authoring agent.

Semantic conflicts (each Change passes on its own, but they fail together) show up through batch bisection. Treat them the
same way: try a resolver first, eject second. The resolver must say *which* upstream Change created the semantic conflict.

### 4.5 Priority, stacks and fairness
- **Priority (highest first):** reverts and incident fixes → security fixes → Lane 0 → Lane 1 → Lane 2, with aging so
  nothing starves.
- **Stacks:** `dependsOn` gives ordering. A stack lands as one unit (atomic) or incrementally, as declared on enqueue.
- **Plan groups:** Changes sharing a `plangroup` that are marked land-together merge atomically in one CAS or not at all.
- **Fairness:** each principal and agent session gets a share of queue capacity and CI budget (weighted fair queuing). One
  runaway agent can't starve the repo. Limit how many entries one agent session can have in flight; the limit is configurable.

### 4.6 Predicting outcomes (start simple)
Estimate the probability each entry passes from:
- its evidence (red/green, coverage, mutation score);
- its size and lane;
- the author's recent pass rate;
- the flakiness of its affected test targets.

Use this to size batches and to put likely failures at the end of a batch, so a failure costs fewer re-runs. Start with a
transparent heuristic, and log predictions against outcomes so a learned model can replace it later. A prediction never
skips a required check.

### 4.7 Flaky tests
- When a test fails in a batch, re-run it on the batch tree and on main's head.
- Only if it also fails on main's head → mark it `suspected-flaky` and quarantine it. Quarantining is an audited
  `AuditEvent` and auto-opens a Plan to fix the test. Don't eject the Change.
- If it fails only on the batch tree, it's real. Bisect.
- Track the flake rate per test target, and expose it to §4.6 and to agents via the API.
- A quarantined test never silently counts as passing. The merge evidence records it as `quarantined`, which raises the
  Change to at least Lane 1 if the quarantined test is in its affected set.

### 4.8 Merging vs deploying
Merging and deploying are separate steps, and the queue coordinates both.
- **Deploy trains.** Merged Changes deploy in trains. A train may contain several Changes *only if* each one is behind its
  own Flagship flag (or is otherwise individually switchable). Changes that can't be switched off individually deploy alone.
- **Watch window.** A train's watch window must complete (or its error budget must clear) before the next train touching the
  **same Worker** deploys. Trains for different Workers run in parallel.
- **Attribution.** A Workers Issues regression during a train → map the issue to the train's Changes using the Worker
  version, the stack frames and each Change's affected files → kill the most likely flag first, watch, and escalate to
  rolling back the whole train if the regression doesn't clear.

### 4.9 Freezes
- If main's post-merge checks fail, or an automatic revert is in progress, the queue enters `frozen`. Only revert and
  incident-fix entries can merge. Everything else keeps speculating, but nothing new lands.
- When the revert lands, the queue thaws, and every speculative batch built on the bad main is invalidated.
- Humans can freeze and thaw manually. Both are signed audit events.

## 5. Agent-facing interface
MCP/API parity, with the standard error shape `{ code, message, fix }` and idempotency keys.
- `enqueue({ changeId, priority?, dependsOn?, plangroup?, landMode? })` → `{ position, track, etaSeconds, predictedPassProbability }`
- `queue_status({ changeId })` → state, track, batch, position, ETA, blocking entries, and the reason for any wait (e.g.
  "waiting on conflicting Change X in track 2").
- `wait_for_merge({ changeId, timeoutSec })` → long-polls until merged, ejected or frozen.
- `dequeue({ changeId })` and `reprioritize(...)`. Reprioritizing to the incident class needs a human or an incident Plan.
- `queue_overview({ repo })` → tracks, batches, freeze state, throughput, p50/p95 time-in-queue.
- **Events** (webhook/SSE): `entered_batch`, `resolving_conflict`, `resolution_ready`, `ejected`, `merged`, `deployed`,
  `flag_killed`, `frozen`, `thawed`.
- **Ejection payloads tell the agent exactly what to do next.** Examples: the failing test plus a link to its log with
  `fix.call = open_workspace(changeId)`, or the upstream Change that caused the semantic conflict.

UI: a single, thin, mobile-friendly queue view showing tracks as swimlanes, batches, the freeze banner, and per-entry reasons.

## 6. Simulator and gates (build before tuning)
Build `sim/merge-queue/`: a deterministic, seeded discrete-event simulator that runs the **real** queue logic (the pure
scheduling core, separated from IO) against synthetic agent workloads.

**Workload knobs:** arrival rate (50–500 Changes/hour), Change size distribution, conflict density, semantic-conflict rate,
true failure rate, flaky-test rate, CI duration distribution, stacks, plan groups, revert events.

**Metrics:** throughput, time-in-queue p50/p95/p99, CI minutes per merged Change, eject rate, false-eject rate (ejected for a
flake), resolver success rate, main-red events.

**Gates (CI fails if any of these regress):**

| Scenario | Gate |
|---|---|
| Any scenario | **main-red events = 0** and attribution failures = 0 |
| 200/h, 10% conflict density, 5% flaky | p95 time-in-queue ≤ 2× median CI duration |
| Same | CI minutes per merged Change ≤ 1.5× a single isolated run |
| Same | false-eject rate ≤ 1% |
| Textual conflicts in the fixture corpus | resolver success ≥ 80%, with zero lane downgrades |

The simulator report compares against two baselines: strictly serial, and "batch everything, no conflict graph". It shows
*why* each mechanism earns its complexity. If a mechanism doesn't beat the simpler baseline on the metrics, remove it and
record the decision.

## 7. Milestones (each ends green and deployed)
- **Q1 – Core.** Per-repo DO, speculative batches on one track, bisection, CAS on main proven by an integration test, the
  main-never-red invariant enforced. Simulator skeleton running the pure core.
- **Q2 – Affected sets + parallel tracks.** Import graph, test impact analysis, conflict graph, independent tracks,
  revalidating stale tracks.
- **Q3 – Agent conflict resolution.** Resolver agent, resolution evidence, re-classification rules, tour stop.
- **Q4 – Priority, stacks, plan groups, fairness, flake quarantine.**
- **Q5 – Deploy trains + attribution + freezes.** Integration with Flagship, gradual deployments, Workers Issues and
  automatic revert. *Acceptance:* an end-to-end test where one of three Changes in a train throws in production: only that
  Change's flag is killed, the other two stay live, and the queue freezes and thaws correctly.
- **Q6 – All simulator gates pass.** Wired into CI.

## 8. Testing
- The pure scheduling core gets property-based tests (fast-check). Assert the invariants over random workloads:
  - main only advances to tested trees;
  - no entry is lost or duplicated;
  - stacks are never reordered;
  - plan groups are all-or-nothing;
  - priority aging ensures no starvation.
- Integration tests on real Artifacts + Workflows for CAS, speculative refs, bisection and GC.
- Fixture repos for textual conflicts, semantic conflicts, stacks and flaky tests.

## 9. When to stop and ask
- If Artifacts can't give you an atomic or guarded main update and the DO-only-writer fallback isn't enough.
- Any design in which a resolver or predictor could lower a lane or skip a required check.
- Costs beyond the dev tier, or beta access you can't get.

For everything else, decide, record the decision in `DECISIONS.md`, and keep going.
