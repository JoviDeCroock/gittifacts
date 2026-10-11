# @app/classifier

Routes every Change to a risk lane: **0** auto-merge, **1** async glance, **2** full review.

`classify()` is a pure, deterministic and explainable function. It does no I/O and reads no
clock, randomness or model. The same input always gives the same output, and inputs are never
mutated. Each decision is a reason with a stable code. The lane is the maximum over those reasons.

```ts
import { classify, shadowAgreement, REASON_CODES } from "@app/classifier";

const result = classify(evidence, basePolicy, plan, diffStats, { category: "fix" }, {
  ciStatus: "passed",
  evidenceVerified: true,   // attestation checked against the platform key
  budgetExceeded: false,    // per-change AI Gateway budget
  tourStatus: "not-generated",
  pureRevertVerified: false,
});
// result.lane, result.computedLane, result.reasons, result.shadow,
// result.blocked, result.requiresHumanApproval, result.checklist
```

- `policy` must be the policy from the **base** branch, never the head's.
- `lane` is what the platform routes on. `computedLane` is the max over reasons before shadow mode.
- `reasons` lists **every** reason, sorted by lane (descending), then code. Each Lane-0 gate that
  passes also appears as a Lane-0 reason, so the UI can render the full checklist.
- `checklist` holds the Lane-0 conditions in a fixed order (`GATES`). `passed` is `true`, `false`
  (measured and failing) or `null` (unknown: the signal is missing or errored). The checklist is
  derived from the reasons: `computedLane === 0` exactly when every gate except `lane0-enabled`
  passed.
- `blocked` means the change cannot merge at all: CI failed, or the evidence attestation did not
  verify.
- `requiresHumanApproval` means a human who is not the author must approve. This is set when
  anything under `.platform/` changed, or when `diffStats` is missing (a policy change can't be
  ruled out).

## Why unknown → escalate

The platform only saves human attention if a Lane-0 decision is trustworthy. So a decision can
only be as good as the evidence behind it. A missing, skipped or errored signal is not the same
as a good one. Usually it means a tool broke, a step was misconfigured, or someone is trying to
get around the checks, and the classifier can't tell which. If unknown were treated as fine, the
cheapest way to reach Lane 0 would be to make a check fail quietly. So:

- Every missing or errored signal **raises** the lane and never lowers it. Required signals go to
  Lane 2, Lane-0 gates go to Lane 1, and informational signals go to Lane 1 only when they error.
- "Skipped" counts as missing. The only exception is a skip that is fine by construction: a
  skipped `public-api` or `coverage` signal is accepted when the diff is known and touches only
  docs, images or licence files (`NON_SOURCE_GLOBS`, an allow-list). A skipped `mutation` signal
  is never accepted.
- The author's claimed category is an input, never the decision. Claiming `fix` adds the
  red-green requirement. Claiming `dependency`, `transform` or `revert` grants nothing until the
  planless rules below verify it mechanically.
- Model judgments (`llm-judgment`) can only raise the lane. `no-concern` is listed at Lane 0 for
  transparency and never offsets anything, because the lane is a max.
- Anything a newer producer might send that this classifier doesn't recognise (a CI status, a
  bump kind, a verdict, an API classification) is treated as the worst case.
- Multiple items of the same kind are combined pessimistically: any error raises, the lowest
  coverage or mutation score wins, and the worst API classification wins. A ratio or score that
  contradicts its own counts is read as the lower of the two.
- Sensitive paths are matched against the **base** policy in addition to the evidence's own hits,
  because the evidence may have been computed with the head's (possibly weakened) policy. Rename
  and copy sources (`previousPath`) count as changed paths, so moving a file out of `auth/` is a
  sensitive hit, and moving one in from outside the plan's scope is scope drift.

## Signal classes

| Signal | Class | Absent | `skipped` | `error` |
|---|---|---|---|---|
| evidence bundle | required | 2 | n/a | n/a (unverified attestation → 2, blocked) |
| diffStats | required | 2 | n/a | n/a |
| `test-run` (≥ 1 ok) | required | 2 | 2 (missing) | 2 |
| `public-api` | required | 2 | 2, or 0 if no source files changed | 2 |
| `dependencies` | required | 2 | 2 (missing) | 2 |
| `sensitive-paths` | required | 2 | 2 (missing) | 2 |
| `red-green` | required for claimed `fix` | 2 (fix) / — | 2 (fix) / — | 2 (fix) / 1 |
| `coverage` | Lane-0 gate | 1 | 1, or 0 if no source files changed | 1 |
| `mutation` | Lane-0 gate | 1 | 1 | 1 |
| `preview`, `screenshots`, `agent-trace` | informational | — | — | 1 |
| `transform` | optional | — (1 if claimed `transform`) | — (1 if claimed `transform`) | 1 |
| `llm-judgment` | raise-only | — | — | 1 |
| `quarantine` | raise-only (merge queue) | — | — | 1 |
| `qa-run` | on request, raise-only | — | — | 1 (a failed criterion: 2; couldn't test: 1) |
| `conflict-resolution` | raise-only (merge queue) | — | 1 | 2 |

## Decision table

Every code in `REASON_CODES`. The *Checklist* column shows which gates a reason affects: ✓ the
gate passes, ✗ it fails (`false`), ? it is unknown (`null`). `catalogue.test.ts` checks that this
table lists every code with its lane.

### CI and evidence bundle

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `ci.cancelled` | 2 | ci ? | context.ciStatus is "cancelled". |
| `ci.errored` | 2 | ci ? | context.ciStatus is "errored". |
| `ci.failed` | 2 | ci ✗ | context.ciStatus is "failed". Also sets blocked. |
| `ci.unknown` | 2 | ci ? | context.ciStatus is "unknown". |
| `evidence.unverified` | 2 | evidence ✗ | Evidence is present but context.evidenceVerified is false. Also sets blocked. |
| `signal.missing.diff-stats` | 2 | size ?, scope ?, migrations ?, policy-file ? | diffStats is null. Also sets requiresHumanApproval (a policy change cannot be ruled out). |
| `signal.missing.evidence` | 2 | evidence ? | evidence is null (every required signal is then also reported missing). |
| `ci.passed` | 0 | ci ✓ | context.ciStatus is "passed". |
| `evidence.verified` | 0 | evidence ✓ | Evidence is present and context.evidenceVerified is true. |

### Tests and red-green proof

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `red-green.no-tests` | 2 | red-green ✗ | Claimed fix and a red-green item has verdict "no-tests". |
| `red-green.not-proven` | 2 | red-green ✗ | Claimed fix and a red-green item has verdict "not-proven". |
| `signal.error.red-green` | 2 (fix) / 1 (other) | red-green ? | A red-green item has status "error". Lane 2 for a claimed fix; Lane 1 for any other category. |
| `signal.error.test-run` | 2 | tests ? | A test-run item has status "error". |
| `signal.missing.red-green` | 2 | red-green ? | Claimed fix and no red-green item with status "ok" (absent, or only skipped). |
| `signal.missing.test-run` | 2 | tests ? | No test-run item with status "ok" (absent, or only skipped). |
| `tests.failing` | 2 | tests ✗ | A test-run item with status "ok" reports failures that are new against the Change's base (failed minus preExisting ones proven against a usable baseline of diffStats.baseSha; every failure without one), even if CI says passed. |
| `red-green.not-required` | 0 | red-green ✓ | Claimed category is not fix. |
| `red-green.proven` | 0 | red-green ✓ | Claimed fix and every red-green item has verdict "proven". |
| `tests.passed` | 0 | tests ✓ | At least one test-run item has status "ok" and none reports failures new against the Change's base. |
| `tests.preexisting` | 0 | tests ✓ | A test-run item lists preExisting failures (fail identically on base, confirmed twice) against a usable baseline of the Change's base commit; they are discounted from failed. |

### Public API

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `api.breaking` | 2 | public-api ✗ | A public-api item classifies the change as "breaking". |
| `signal.error.public-api` | 2 | public-api ? | A public-api item has status "error". |
| `signal.missing.public-api` | 2 | public-api ? | No public-api item with status "ok", and no accepted skip. |
| `api.additive` | 1 | public-api ✗ | A public-api item classifies the change as "additive". |
| `api.none` | 0 | public-api ✓ | Every public-api item with status "ok" classifies the change as "none". |
| `signal.skip-accepted.public-api` | 0 | public-api ✓ | Only skipped public-api items, diffStats present and every changed file is non-source (docs, images, license). |

### Dependencies

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `dependency.added` | 2 | dependencies ✗ | A dependency item lists added dependencies. |
| `dependency.install-script` | 2 | dependencies ✗ | A dependency item lists newInstallScripts. |
| `dependency.major` | 2 | dependencies ✗ | A changed dependency has bump "major". |
| `dependency.other-bump` | 2 | dependencies ✗ | A changed dependency has bump "other" (git URL, tag, range rewrite, downgrade, ...). |
| `signal.error.dependencies` | 2 | dependencies ? | A dependencies item has status "error". |
| `signal.missing.dependencies` | 2 | dependencies ? | No dependencies item with status "ok" (absent, or only skipped). |
| `dependency.lockfile-only` | 1 | dependencies ✗ | lockfileChanged is true but no dependency was added, removed or changed. |
| `dependency.lockfile-unverified` | 1 | dependencies ✗ | lockfileChanged is true, a dependency changed, and the item's lockfile check is missing or not verified (a changed entry that is not one registry patch bump of a bumped package, a new or removed package, a changed setting). |
| `dependency.minor` | 1 | dependencies ✗ | A changed dependency has bump "minor". |
| `dependency.patch-not-allowed` | 1 | dependencies ✗ | Patch bumps and policy.dependencies.allowPatchBumpsInLane0 is false. |
| `dependency.prerelease` | 1 | dependencies ✗ | A changed dependency has bump "prerelease". |
| `dependency.removed` | 1 | dependencies ✗ | A dependency item lists removed dependencies. |
| `dependency.none` | 0 | dependencies ✓ | Dependency items report no added, removed or changed dependencies, no new install scripts and no lockfile change. |
| `dependency.patch` | 0 | dependencies ✓ | Patch bumps and policy.dependencies.allowPatchBumpsInLane0 is true. |

### Sensitive paths, migrations, platform policy

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `migration.touched` | 2 | migrations ✗ | A changed path (or rename source) is under a migrations directory (\*\*/migrations/\*\*, \*\*/migration/\*\*). |
| `policy.changed` | 2 | policy-file ✗ | A changed path (or rename source) is under .platform/ (e.g. .platform/policy.ts). Also sets requiresHumanApproval. |
| `sensitive.hit` | 2 | sensitive-paths ✗ | A sensitive-paths item reports a hit, or a changed path (or rename source) matches the BASE policy.sensitivePaths. |
| `signal.error.sensitive-paths` | 2 | sensitive-paths ? | A sensitive-paths item has status "error". |
| `signal.missing.sensitive-paths` | 2 | sensitive-paths ? | No sensitive-paths item with status "ok" (absent, or only skipped). |
| `migration.none` | 0 | migrations ✓ | No changed path matches a migrations glob. |
| `policy.unchanged` | 0 | policy-file ✓ | No changed path is under .platform/. |
| `sensitive.none` | 0 | sensitive-paths ✓ | No hit in the sensitive-paths items and no changed path matches policy.sensitivePaths. |

### Plan and scope

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `scope.drift` | 2 | scope ✗ | Plan declares scopePaths and a changed path (or rename source) matches none of them. |
| `scope.out-of-scope` | 2 | scope ✗ | A changed path matches an outOfScope entry that looks like a glob (contains / or *). |
| `plan.missing` | 1 | plan ✗ | plan is null and no planless category applies. |
| `plan.not-approved` | 1 | plan ✗ | Plan is draft/superseded/rejected, has no approver, or was approved by its own author; and no planless category applies. |
| `plan.scope-undeclared` | 1 | scope ? | Plan is attached, scopePaths is empty and no planless category applies. |
| `plan.approved` | 0 | plan ✓ | Plan status is "approved", approvedBy is set and is not the plan author. |
| `plan.planless` | 0 | plan ✓ | No approved plan, but a category in policy.planlessLane0 is mechanically verified. |
| `scope.not-applicable` | 0 | scope ✓ | No plan is attached, or the plan declares no scopePaths and a planless category applies. |
| `scope.within` | 0 | scope ✓ | Plan declares scopePaths and every changed path matches one; no outOfScope glob matches. |

### Size

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `size.files-over-lane1` | 2 | size ✗ | Counted files > lane1MaxFiles. |
| `size.lines-over-lane1` | 2 | size ✗ | Counted lines > lane1MaxDiffLines. |
| `size.files-over-lane0` | 1 | size ✗ | lane0MaxFiles < counted files <= lane1MaxFiles. |
| `size.lines-over-lane0` | 1 | size ✗ | lane0MaxDiffLines < counted lines <= lane1MaxDiffLines. |
| `size.ok` | 0 | size ✓ | Counted lines <= lane0MaxDiffLines and counted files <= lane0MaxFiles. |
| `size.transform-excluded` | 0 | size ✓ | Some changed files are fully reproduced by a verified transform. |

### Coverage and mutation (Lane-0 gates)

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `coverage.below-threshold` | 1 | coverage ✗ | Lowest coverage ratio over ok items < policy.thresholds.changedLineCoverage. |
| `mutation.below-threshold` | 1 | mutation ✗ | Lowest mutation score over ok items < policy.thresholds.mutationScore. |
| `mutation.no-coverage` | 1 | mutation ✗ | The lowest-scoring ok mutation item killed, timed out and survived nothing and has noCoverage > 0: no test exercises the changed lines (measured, not an error). |
| `signal.error.coverage` | 1 | coverage ? | A coverage item has status "error". |
| `signal.error.mutation` | 1 | mutation ? | A mutation item has status "error". |
| `signal.missing.coverage` | 1 | coverage ? | No coverage item with status "ok", and no accepted skip. |
| `signal.missing.mutation` | 1 | mutation ? | No mutation item with status "ok" (absent, or only skipped while source files changed). |
| `signal.skip-accepted.mutation` | 0 | mutation ✓ | Only skipped mutation items, diffStats present and every changed file is non-source (docs, images, license). |
| `coverage.ok` | 0 | coverage ✓ | Lowest coverage ratio over ok items >= policy.thresholds.changedLineCoverage. |
| `mutation.ok` | 0 | mutation ✓ | Lowest mutation score over ok items >= policy.thresholds.mutationScore. |
| `signal.skip-accepted.coverage` | 0 | coverage ✓ | Only skipped coverage items, diffStats present and every changed file is non-source (docs, images, license). |

### Transforms

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `transform.mismatch` | 2 | transform ✗ | A transform item (any claimed category) has status "ok" and mismatchedFiles. |
| `signal.error.transform` | 1 | transform ? | A transform item has status "error". |
| `transform.unverified` | 1 | transform ✗ | Claimed category is transform and there is no verified transform item. |
| `transform.not-applicable` | 0 | transform ✓ | Category is not transform and no transform item verified, mismatched or errored. |
| `transform.verified` | 0 | transform ✓ | A transform item has status "ok", verified true and no mismatchedFiles. |

### Model judgments (may only raise)

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `llm.concern` | 2 | llm-judgments ✗ | An llm-judgment item has outcome "concern". |
| `llm.unsure` | 1 | llm-judgments ? | An llm-judgment item has outcome "unsure". |
| `signal.error.llm-judgment` | 1 | llm-judgments ? | An llm-judgment item has status "error". |
| `llm.no-concern` | 0 | llm-judgments ✓ | An llm-judgment item has outcome "no-concern". Never lowers anything. |
| `llm.none` | 0 | llm-judgments ✓ | No llm-judgment item with status ok or error. |

### Quarantined tests and conflict resolutions (merge queue; may only raise)

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `signal.error.conflict-resolution` | 2 | conflict-resolution ? | A conflict-resolution item has status "error". |
| `resolution.lane-kept` | 1 / 2 (the previous lane) | conflict-resolution ✗ | Added by `neverLower` when the merged tree's classification is below the Change's previous one. Its lane is the previous lane: 1 or 2. |
| `resolution.outside-conflict` | 1 | conflict-resolution ✗ | A conflict-resolution item with status "ok" has touchesOutsideConflictHunks, or edits with no conflict hunk. |
| `resolution.semantic` | 1 | conflict-resolution ✗ | A conflict-resolution item with status "ok" names semanticConflictWith. |
| `resolution.skipped` | 1 | conflict-resolution ? | A conflict-resolution item has status "skipped". |
| `resolution.truncated` | 1 | conflict-resolution ? | A conflict-resolution item with status "ok" has truncated: true. |
| `signal.error.quarantine` | 1 | tests ? | A quarantine item has status "error". |
| `tests.quarantined` | 1 | tests ? | A quarantine item with status "ok" lists tests in inAffectedSet (a quarantined test never silently counts as passing). |
| `resolution.within-conflict` | 0 | conflict-resolution ✓ | A conflict-resolution item with status "ok" stays inside its conflict hunks (informational; the lane stays what the merged tree earns). |
| `tests.quarantined-unaffected` | 0 | tests ✓ | A quarantine item with status "ok" lists quarantined tests, none of them in inAffectedSet. |

### QA in a browser (on request)

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `qa.failed` | 2 | qa ✗ | A qa-run item with status "ok" has at least one criterion "fail". |
| `qa.couldnt-test` | 1 | qa ? | A qa-run item with status "ok" has a criterion "couldnt-test", or no criteria at all. |
| `signal.error.qa` | 1 | qa ? | A qa-run item has status "error". |
| `qa.passed` | 0 | qa ✓ | A qa-run item with status "ok" has every criterion "pass" (never lowers anything; no item: QA was not requested, nothing raised). |

`raiseForQa(previous, item)` applies these to a stored classification after an on-request run: it only keeps or raises.

### Informational signals, budget, tour

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `budget.exceeded` | 2 | budget ✗ | context.budgetExceeded is true. |
| `tour.failed` | 2 | tour ✗ | context.tourStatus is "failed". |
| `signal.error.agent-trace` | 1 | informational-signals ? | An agent-trace item has status "error". |
| `signal.error.preview` | 1 | informational-signals ? | A preview item has status "error". |
| `signal.error.screenshots` | 1 | informational-signals ? | A screenshots item has status "error". |
| `budget.ok` | 0 | budget ✓ | context.budgetExceeded is false. |
| `informational.ok` | 0 | informational-signals ✓ | No preview/screenshots/agent-trace item has status error (absent is fine). |
| `tour.ok` | 0 | tour ✓ | context.tourStatus is "ok" or "not-generated". |

### Shadow mode and verified reverts

| Code | Lane | Checklist | Condition |
|---|---|---|---|
| `shadow.lane0-disabled` | 1 | lane0-enabled ✗ | computedLane is 0, policy.lane0Enabled is false and the verified-revert exception does not apply. Not counted in computedLane. |
| `lane0.enabled` | 0 | lane0-enabled ✓ | policy.lane0Enabled is true. |
| `revert.auto-merge` | 0 | lane0-enabled ✓ | pureRevertVerified, policy.autoMergeVerifiedReverts, and every raised reason is waivable (plan.missing, plan.not-approved, plan.scope-undeclared, size.*). |
| `revert.verified` | 0 | — | context.pureRevertVerified is true. |
| `revert.waived` | 0 | — | Replaces each waivable reason when revert.auto-merge applies; keeps the original reason's gates. |

## Merge queue: conflict resolutions and quarantined tests

When a Change no longer applies onto its batch base, the merge queue's resolver agent (principal
`system:resolver`, never the author) resolves the conflict. The Change is then re-evidenced and
re-classified on the merged tree, so the lane describes what actually lands. Two rules keep a
resolution from ever lowering the lane:

- **Reasons only add.** A `conflict-resolution` item adds reasons and never removes one.
  Within the conflict hunks it is informational (`resolution.within-conflict`, Lane 0): the lane is
  whatever the merged tree earns on every other gate. Edits outside the hunks, a semantic conflict,
  a truncated record or a skipped item raise to Lane 1; a failed resolution is Lane 2. "Outside"
  is computed mechanically by `@app/evidence`'s `resolutionScope`, not reported by the model, and
  an item with edits but no conflict hunk is read as outside.
- **The previous lane is a floor.** `neverLower(previous, next)` returns `next` unless it is below
  `previous` (lane or computed lane). Then it adds `resolution.lane-kept` at the previous lane on
  the `conflict-resolution` gate, naming the previous raised reasons, drops shadow mode (the
  computed lane is now at least 1) and keeps `requiresHumanApproval` if either required it.
  `reclassifyAfterResolution(previous, …classifyArgs)` is `neverLower(previous, classify(…))`;
  the queue shell uses it for every resolved Change, so the floor cannot be forgotten.

A `quarantine` item lists tests the queue quarantined as suspected-flaky. A quarantined test never
silently counts as passing: one in the Change's affected set raises to Lane 1 (`tests.quarantined`,
tests gate unknown), and an unreadable quarantine list is Lane 1 too. An absent item means no test
was quarantined; a bundle whose test runs excluded quarantined tests must carry one.

## Planless Lane 0

Without an approved plan a change is Lane 1 (`plan.missing` / `plan.not-approved`). A repository
can name narrow categories in `policy.planlessLane0` that may reach Lane 0 without an approved
plan. Each one is **verified mechanically**, and the claimed category plays no part:

| Category | Verified when |
|---|---|
| `dependency-patch` | Every changed file is a `package.json` or a lockfile (no renames). Dependency evidence is ok and shows at least one change, all of them `patch`, with nothing added or removed and no new install scripts. Each changed manifest has no more added or deleted lines than patch bumps recorded against it, so script or config edits can't ride along. |
| `verified-transform` | Every changed file, and every rename source, is listed in a `transform` item with status ok, `verified: true` and no `mismatchedFiles`. |
| `pure-revert` | `context.pureRevertVerified`. |

When a planless category applies, the plan checks (`plan.missing`, `plan.not-approved`,
`plan.scope-undeclared`) are replaced by `plan.planless`. Every other rule still applies,
including scope drift against an attached plan that declares `scopePaths`.

## Verified reverts

A revert that the platform has verified as the exact inverse of a change it merged puts the code
back into a state that was already approved. If `context.pureRevertVerified` and
`policy.autoMergeVerifiedReverts` are both true, **and** the only raised reasons are plan
paperwork (`plan.missing`, `plan.not-approved`, `plan.scope-undeclared`) or size (`size.*`), then:

- each of those reasons is replaced by a Lane-0 `revert.waived` reason that keeps the original
  code and message, so nothing is hidden;
- `revert.auto-merge` is added, `computedLane` is 0, and the result is **not shadowed**: `lane` is
  0 even when `lane0Enabled` is false.

Any other raised reason (CI, missing evidence, coverage, a sensitive path, …) disables the
exception, and normal rules apply.

## Size

Counted lines are `max(diffStats.additions + deletions, sum of per-file lines)` minus the lines of
files fully reproduced by a verified transform. Counted files are all changed files minus those
reproduced files. Both are compared with `lane0Max*` (above → Lane 1) and `lane1Max*` (above →
Lane 2).

## Shadow mode

When `computedLane` is 0 but `policy.lane0Enabled` is false (and the verified-revert exception
does not apply), the change is routed to Lane 1 with `shadow: true` and a
`shadow.lane0-disabled` reason. The platform records the human's decision, and
`shadowAgreement(samples, policy)` reports whether the classifier has earned Lane 0:

- only samples with `computedLane === 0` count;
- a sample agrees when the human approved it (not `request-changes` or `reject`) and, if they
  gave a `humanLane`, said 0;
- `eligibleToEnableLane0` is `samples >= shadow.minSamples && ratio >= shadow.agreementThreshold`;
- `needed` is how many more agreeing Lane-0 candidates would make it eligible (0 if it already
  is). It is `null` when that can never happen: the threshold is 1 and a disagreement is already
  on record.

## Globs

Matching uses `picomatch` (posix build, `{ dot: true }`) on repo-relative paths. A leading `./` or
`/` is stripped from both paths and patterns. A non-negated pattern `P` also matches `P/**`, so a
directory written as `src/legacy` or `src/legacy/` covers the files under it. `outOfScope`
entries are free text for humans, and only entries that look like globs (they contain `/` or `*`)
are checked. A pattern that is empty or fails to compile is resolved in the escalating
direction: it matches nothing for `scopePaths` (so the change drifts), and everything for
sensitive paths and `outOfScope`.

## Known limits

- Scope drift can only be checked against a plan. Detaching the plan from a drifting change turns
  `scope.drift` (Lane 2) into `plan.missing` (Lane 1), and so does replacing it with one that has
  no `scopePaths`. The platform must keep `Change.planId` immutable, and require a new approved
  plan to change scope.
- Red-green is only required for a claimed `fix`, so a fix claimed as `feature` skips that
  requirement. Coverage and mutation still gate Lane 0.
- An errored model judgment is Lane 1, even though the same judgment with a concern would be
  Lane 2.
