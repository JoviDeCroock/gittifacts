---
title: "Lane reason codes"
nav: "Lane reasons"
description: "All 106 reason codes the classifier can put on a Change: the lane each one forces, its gate and when it fires."
order: 52
audience: both
generated: true
---

# Lane reason codes

A Change's lane is the highest lane over its reasons. Every reason has a stable code (stored on the Change as `laneReasons[]`) and maps to one or more Lane-0 gates. `outcome` says how a raised reason shows on its gate: `fail` (measured and bad), `unknown` (not measured or errored: unknown escalates) or `pass`.

> Generated from `packages/classifier/src/reasons.ts` by `pnpm --filter @app/docs generate`. Don't edit this page by hand: change the code and regenerate.

## Lane-0 gates

A Change is Lane 0 only when every gate passes. The checklist in `get_change_status` lists them in this order: `ci`, `evidence`, `tests`, `red-green`, `public-api`, `dependencies`, `sensitive-paths`, `migrations`, `policy-file`, `plan`, `scope`, `size`, `coverage`, `mutation`, `transform`, `llm-judgments`, `conflict-resolution`, `informational-signals`, `budget`, `tour`, `lane0-enabled`.

## Reasons

| Code | Lane | Outcome | Gates | When |
| --- | --- | --- | --- | --- |
| `api.breaking` | 2 | fail | public-api | A public-api item classifies the change as "breaking". |
| `budget.exceeded` | 2 | fail | budget | context.budgetExceeded is true. |
| `ci.cancelled` | 2 | unknown | ci | context.ciStatus is "cancelled". |
| `ci.errored` | 2 | unknown | ci | context.ciStatus is "errored". |
| `ci.failed` | 2 | fail | ci | context.ciStatus is "failed". Also sets blocked. |
| `ci.unknown` | 2 | unknown | ci | context.ciStatus is "unknown". |
| `dependency.added` | 2 | fail | dependencies | A dependency item lists added dependencies. |
| `dependency.install-script` | 2 | fail | dependencies | A dependency item lists newInstallScripts. |
| `dependency.major` | 2 | fail | dependencies | A changed dependency has bump "major". |
| `dependency.other-bump` | 2 | fail | dependencies | A changed dependency has bump "other" (git URL, tag, range rewrite, downgrade, ...). |
| `evidence.unverified` | 2 | fail | evidence | Evidence is present but context.evidenceVerified is false. Also sets blocked. |
| `llm.concern` | 2 | fail | llm-judgments | An llm-judgment item has outcome "concern". |
| `migration.touched` | 2 | fail | migrations | A changed path (or rename source) is under a migrations directory (**/migrations/**, **/migration/**). |
| `policy.changed` | 2 | fail | policy-file | A changed path (or rename source) is under .platform/ (e.g. .platform/policy.ts). Also sets requiresHumanApproval. |
| `red-green.no-tests` | 2 | fail | red-green | Claimed fix and a red-green item has verdict "no-tests". |
| `red-green.not-proven` | 2 | fail | red-green | Claimed fix and a red-green item has verdict "not-proven". |
| `scope.drift` | 2 | fail | scope | Plan declares scopePaths and a changed path (or rename source) matches none of them. |
| `scope.out-of-scope` | 2 | fail | scope | A changed path matches an outOfScope entry that looks like a glob (contains / or *). |
| `sensitive.hit` | 2 | fail | sensitive-paths | A sensitive-paths item reports a hit, or a changed path (or rename source) matches the BASE policy.sensitivePaths. |
| `signal.error.conflict-resolution` | 2 | unknown | conflict-resolution | A conflict-resolution item has status "error". |
| `signal.error.dependencies` | 2 | unknown | dependencies | A dependencies item has status "error". |
| `signal.error.public-api` | 2 | unknown | public-api | A public-api item has status "error". |
| `signal.error.red-green` | 2 | unknown | red-green | A red-green item has status "error". Lane 2 for a claimed fix; Lane 1 for any other category. |
| `signal.error.sensitive-paths` | 2 | unknown | sensitive-paths | A sensitive-paths item has status "error". |
| `signal.error.test-run` | 2 | unknown | tests | A test-run item has status "error". |
| `signal.missing.dependencies` | 2 | unknown | dependencies | No dependencies item with status "ok" (absent, or only skipped). |
| `signal.missing.diff-stats` | 2 | unknown | size, scope, migrations, policy-file | diffStats is null. Also sets requiresHumanApproval (a policy change cannot be ruled out). |
| `signal.missing.evidence` | 2 | unknown | evidence | evidence is null (every required signal is then also reported missing). |
| `signal.missing.public-api` | 2 | unknown | public-api | No public-api item with status "ok", and no accepted skip. |
| `signal.missing.red-green` | 2 | unknown | red-green | Claimed fix and no red-green item with status "ok" (absent, or only skipped). |
| `signal.missing.sensitive-paths` | 2 | unknown | sensitive-paths | No sensitive-paths item with status "ok" (absent, or only skipped). |
| `signal.missing.test-run` | 2 | unknown | tests | No test-run item with status "ok" (absent, or only skipped). |
| `size.files-over-lane1` | 2 | fail | size | Counted files > lane1MaxFiles. |
| `size.lines-over-lane1` | 2 | fail | size | Counted lines > lane1MaxDiffLines. |
| `tests.failing` | 2 | fail | tests | A test-run item with status "ok" reports failures that are new against the Change's base (failed minus preExisting ones proven against a usable baseline of diffStats.baseSha; every failure without one), even if CI says passed. |
| `tour.failed` | 2 | fail | tour | context.tourStatus is "failed". |
| `transform.mismatch` | 2 | fail | transform | A transform item (any claimed category) has status "ok" and mismatchedFiles. |
| `api.additive` | 1 | fail | public-api | A public-api item classifies the change as "additive". |
| `coverage.below-threshold` | 1 | fail | coverage | Lowest coverage ratio over ok items < policy.thresholds.changedLineCoverage. |
| `dependency.lockfile-only` | 1 | fail | dependencies | lockfileChanged is true but no dependency was added, removed or changed. |
| `dependency.minor` | 1 | fail | dependencies | A changed dependency has bump "minor". |
| `dependency.patch-not-allowed` | 1 | fail | dependencies | Patch bumps and policy.dependencies.allowPatchBumpsInLane0 is false. |
| `dependency.prerelease` | 1 | fail | dependencies | A changed dependency has bump "prerelease". |
| `dependency.removed` | 1 | fail | dependencies | A dependency item lists removed dependencies. |
| `llm.unsure` | 1 | unknown | llm-judgments | An llm-judgment item has outcome "unsure". |
| `mutation.below-threshold` | 1 | fail | mutation | Lowest mutation score over ok items < policy.thresholds.mutationScore. |
| `mutation.no-coverage` | 1 | fail | mutation | The lowest-scoring ok mutation item killed, timed out and survived nothing and has noCoverage > 0 (no test is related to the mutated files). |
| `plan.missing` | 1 | fail | plan | plan is null and no planless category applies. |
| `plan.not-approved` | 1 | fail | plan | Plan is draft/superseded/rejected, has no approver, or was approved by its own author; and no planless category applies. |
| `plan.scope-undeclared` | 1 | unknown | scope | Plan is attached, scopePaths is empty and no planless category applies. |
| `resolution.lane-kept` | 1 | fail | conflict-resolution | Added by neverLower when the merged tree's classification is below the Change's previous one. Its lane is the previous lane: 1 or 2. |
| `resolution.outside-conflict` | 1 | fail | conflict-resolution | A conflict-resolution item with status "ok" has touchesOutsideConflictHunks, or edits with no conflict hunk. |
| `resolution.semantic` | 1 | fail | conflict-resolution | A conflict-resolution item with status "ok" names semanticConflictWith. |
| `resolution.skipped` | 1 | unknown | conflict-resolution | A conflict-resolution item has status "skipped". |
| `resolution.truncated` | 1 | unknown | conflict-resolution | A conflict-resolution item with status "ok" has truncated: true. |
| `shadow.lane0-disabled` | 1 | fail | lane0-enabled | computedLane is 0, policy.lane0Enabled is false and the verified-revert exception does not apply. Not counted in computedLane. |
| `signal.error.agent-trace` | 1 | unknown | informational-signals | An agent-trace item has status "error". |
| `signal.error.coverage` | 1 | unknown | coverage | A coverage item has status "error". |
| `signal.error.llm-judgment` | 1 | unknown | llm-judgments | An llm-judgment item has status "error". |
| `signal.error.mutation` | 1 | unknown | mutation | A mutation item has status "error". |
| `signal.error.preview` | 1 | unknown | informational-signals | A preview item has status "error". |
| `signal.error.quarantine` | 1 | unknown | tests | A quarantine item has status "error". |
| `signal.error.screenshots` | 1 | unknown | informational-signals | A screenshots item has status "error". |
| `signal.error.transform` | 1 | unknown | transform | A transform item has status "error". |
| `signal.missing.coverage` | 1 | unknown | coverage | No coverage item with status "ok", and no accepted skip. |
| `signal.missing.mutation` | 1 | unknown | mutation | No mutation item with status "ok" (absent, or only skipped — a skip is never accepted). |
| `size.files-over-lane0` | 1 | fail | size | lane0MaxFiles < counted files <= lane1MaxFiles. |
| `size.lines-over-lane0` | 1 | fail | size | lane0MaxDiffLines < counted lines <= lane1MaxDiffLines. |
| `tests.quarantined` | 1 | unknown | tests | A quarantine item with status "ok" lists tests in inAffectedSet (a quarantined test never silently counts as passing). |
| `transform.unverified` | 1 | fail | transform | Claimed category is transform and there is no verified transform item. |
| `api.none` | 0 | pass | public-api | Every public-api item with status "ok" classifies the change as "none". |
| `budget.ok` | 0 | pass | budget | context.budgetExceeded is false. |
| `ci.passed` | 0 | pass | ci | context.ciStatus is "passed". |
| `coverage.ok` | 0 | pass | coverage | Lowest coverage ratio over ok items >= policy.thresholds.changedLineCoverage. |
| `dependency.none` | 0 | pass | dependencies | Dependency items report no added, removed or changed dependencies, no new install scripts and no lockfile change. |
| `dependency.patch` | 0 | pass | dependencies | Patch bumps and policy.dependencies.allowPatchBumpsInLane0 is true. |
| `evidence.verified` | 0 | pass | evidence | Evidence is present and context.evidenceVerified is true. |
| `informational.ok` | 0 | pass | informational-signals | No preview/screenshots/agent-trace item has status error (absent is fine). |
| `lane0.enabled` | 0 | pass | lane0-enabled | policy.lane0Enabled is true. |
| `llm.no-concern` | 0 | pass | llm-judgments | An llm-judgment item has outcome "no-concern". Never lowers anything. |
| `llm.none` | 0 | pass | llm-judgments | No llm-judgment item with status ok or error. |
| `migration.none` | 0 | pass | migrations | No changed path matches a migrations glob. |
| `mutation.ok` | 0 | pass | mutation | Lowest mutation score over ok items >= policy.thresholds.mutationScore. |
| `plan.approved` | 0 | pass | plan | Plan status is "approved", approvedBy is set and is not the plan author. |
| `plan.planless` | 0 | pass | plan | No approved plan, but a category in policy.planlessLane0 is mechanically verified. |
| `policy.unchanged` | 0 | pass | policy-file | No changed path is under .platform/. |
| `red-green.not-required` | 0 | pass | red-green | Claimed category is not fix. |
| `red-green.proven` | 0 | pass | red-green | Claimed fix and every red-green item has verdict "proven". |
| `resolution.within-conflict` | 0 | pass | conflict-resolution | A conflict-resolution item with status "ok" stays inside its conflict hunks (informational; the lane stays what the merged tree earns). |
| `revert.auto-merge` | 0 | pass | lane0-enabled | pureRevertVerified, policy.autoMergeVerifiedReverts, and every raised reason is waivable (plan.missing, plan.not-approved, plan.scope-undeclared, size.*). |
| `revert.verified` | 0 | pass |  | context.pureRevertVerified is true. |
| `revert.waived` | 0 | pass |  | Replaces each waivable reason when revert.auto-merge applies; keeps the original reason's gates. |
| `scope.not-applicable` | 0 | pass | scope | No plan is attached, or the plan declares no scopePaths and a planless category applies. |
| `scope.within` | 0 | pass | scope | Plan declares scopePaths and every changed path matches one; no outOfScope glob matches. |
| `sensitive.none` | 0 | pass | sensitive-paths | No hit in the sensitive-paths items and no changed path matches policy.sensitivePaths. |
| `signal.skip-accepted.coverage` | 0 | pass | coverage | Only skipped coverage items, diffStats present and every changed file is non-source (docs, images, license). |
| `signal.skip-accepted.mutation` | 0 | pass | mutation | Only skipped mutation items, diffStats present and every changed file is non-source (docs, images, license). |
| `signal.skip-accepted.public-api` | 0 | pass | public-api | Only skipped public-api items, diffStats present and every changed file is non-source (docs, images, license). |
| `size.ok` | 0 | pass | size | Counted lines <= lane0MaxDiffLines and counted files <= lane0MaxFiles. |
| `size.transform-excluded` | 0 | pass | size | Some changed files are fully reproduced by a verified transform. |
| `tests.passed` | 0 | pass | tests | At least one test-run item has status "ok" and none reports failures new against the Change's base. |
| `tests.preexisting` | 0 | pass | tests | A test-run item lists preExisting failures against a usable baseline of the Change's base commit (diffStats.baseSha); they are discounted from failed. |
| `tests.quarantined-unaffected` | 0 | pass | tests | A quarantine item with status "ok" lists quarantined tests, none of them in inAffectedSet. |
| `tour.ok` | 0 | pass | tour | context.tourStatus is "ok" or "not-generated". |
| `transform.not-applicable` | 0 | pass | transform | Category is not transform and no transform item verified, mismatched or errored. |
| `transform.verified` | 0 | pass | transform | A transform item has status "ok", verified true and no mismatchedFiles. |
