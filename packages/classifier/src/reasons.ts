import type { Lane } from "@app/domain";

/**
 * The Lane-0 conditions, in the order the UI shows them. Every reason with lane >= 1 maps to
 * at least one gate, so "computedLane === 0" is exactly "every gate except lane0-enabled passed".
 */
export const GATES = [
  "ci",
  "evidence",
  "tests",
  "red-green",
  "public-api",
  "dependencies",
  "sensitive-paths",
  "migrations",
  "policy-file",
  "plan",
  "scope",
  "size",
  "coverage",
  "mutation",
  "transform",
  "llm-judgments",
  "conflict-resolution",
  "informational-signals",
  "budget",
  "tour",
  "lane0-enabled",
] as const;
export type Gate = (typeof GATES)[number];

/**
 * How a raised reason (lane >= 1) shows on its gates in the checklist:
 * "fail" → passed: false (measured and bad), "unknown" → passed: null (not measured / errored).
 * Lane-0 reasons are always "pass".
 */
export type ReasonOutcome = "pass" | "fail" | "unknown";

export interface ReasonSpec {
  /** The minimum lane this reason forces. */
  readonly lane: Lane;
  readonly outcome: ReasonOutcome;
  readonly gates: readonly Gate[];
  /** Message template; `{name}` placeholders are filled by `formatReason`. */
  readonly template: string;
  /** When the classifier emits this code (documentation; mirrored in README.md). */
  readonly condition: string;
}

function spec(
  lane: Lane,
  outcome: ReasonOutcome,
  gates: readonly Gate[],
  template: string,
  condition: string,
): ReasonSpec {
  return { lane, outcome, gates, template, condition };
}

/**
 * Stable reason-code catalogue. Codes are part of the platform's API (stored on Changes, shown in
 * the UI, used in shadow-mode analytics): never rename one, only add new codes.
 */
export const REASON_CODES = {
  // ------------------------------------------------------------------ CI
  "ci.passed": spec(0, "pass", ["ci"], "CI passed.", 'context.ciStatus is "passed".'),
  "ci.failed": spec(
    2,
    "fail",
    ["ci"],
    "CI failed; the change cannot merge until it is green.",
    'context.ciStatus is "failed". Also sets blocked.',
  ),
  "ci.errored": spec(
    2,
    "unknown",
    ["ci"],
    "CI errored before producing a result.",
    'context.ciStatus is "errored".',
  ),
  "ci.cancelled": spec(
    2,
    "unknown",
    ["ci"],
    "CI was cancelled before producing a result.",
    'context.ciStatus is "cancelled".',
  ),
  "ci.unknown": spec(
    2,
    "unknown",
    ["ci"],
    "CI status is unknown.",
    'context.ciStatus is "unknown".',
  ),

  // ------------------------------------------------------------------ evidence bundle
  "evidence.verified": spec(
    0,
    "pass",
    ["evidence"],
    "Evidence attestation verified against the platform key.",
    "Evidence is present and context.evidenceVerified is true.",
  ),
  "evidence.unverified": spec(
    2,
    "fail",
    ["evidence"],
    "Evidence attestation did not verify against the platform key; none of it can be trusted.",
    "Evidence is present but context.evidenceVerified is false. Also sets blocked.",
  ),
  "signal.missing.evidence": spec(
    2,
    "unknown",
    ["evidence"],
    "No evidence bundle was recorded for this change.",
    "evidence is null (every required signal is then also reported missing).",
  ),
  "signal.missing.diff-stats": spec(
    2,
    "unknown",
    ["size", "scope", "migrations", "policy-file"],
    "Diff statistics are unavailable, so size, scope, migration and policy-file checks cannot run.",
    "diffStats is null. Also sets requiresHumanApproval (a policy change cannot be ruled out).",
  ),

  // ------------------------------------------------------------------ tests (required)
  "tests.passed": spec(
    0,
    "pass",
    ["tests"],
    "{passed} test(s) passed across {runs} test run(s).",
    "At least one test-run item has status \"ok\" and none reports failures new against the Change's base.",
  ),
  "tests.failing": spec(
    2,
    "fail",
    ["tests"],
    "Test run {step} reported {failed} failing test(s).",
    'A test-run item with status "ok" reports failures that are new against the Change\'s base (failed minus preExisting ones proven against a usable baseline of diffStats.baseSha; every failure without one), even if CI says passed.',
  ),
  "tests.preexisting": spec(
    0,
    "pass",
    ["tests"],
    "{count} failing test(s) in {step} fail identically on base {base}: pre-existing, not counted.",
    "A test-run item lists preExisting failures against a usable baseline of the Change's base commit (diffStats.baseSha); they are discounted from failed.",
  ),
  "signal.missing.test-run": spec(
    2,
    "unknown",
    ["tests"],
    "No test run was recorded{detail}.",
    'No test-run item with status "ok" (absent, or only skipped).',
  ),
  "signal.error.test-run": spec(
    2,
    "unknown",
    ["tests"],
    "A test run errored{detail}.",
    'A test-run item has status "error".',
  ),

  // ------------------------------------------------------------------ red-green (required for fixes)
  "red-green.proven": spec(
    0,
    "pass",
    ["red-green"],
    "Red-green proof: {tests} test(s) fail on base and pass on head.",
    'Claimed fix and every red-green item has verdict "proven".',
  ),
  "red-green.not-required": spec(
    0,
    "pass",
    ["red-green"],
    "A red-green proof is not required for a claimed {category} change.",
    "Claimed category is not fix.",
  ),
  "red-green.not-proven": spec(
    2,
    "fail",
    ["red-green"],
    "Claimed fix, but no listed test fails on base, or one still fails on head.",
    'Claimed fix and a red-green item has verdict "not-proven".',
  ),
  "red-green.no-tests": spec(
    2,
    "fail",
    ["red-green"],
    "Claimed fix, but no test fails on base and passes on head (none is new, changed or fixed).",
    'Claimed fix and a red-green item has verdict "no-tests".',
  ),
  "signal.missing.red-green": spec(
    2,
    "unknown",
    ["red-green"],
    "Claimed fix, but no red-green proof was recorded{detail}.",
    'Claimed fix and no red-green item with status "ok" (absent, or only skipped).',
  ),
  "signal.error.red-green": spec(
    2,
    "unknown",
    ["red-green"],
    "Red-green proof errored{detail}.",
    'A red-green item has status "error". Lane 2 for a claimed fix; Lane 1 for any other category.',
  ),

  // ------------------------------------------------------------------ public API (required)
  "api.none": spec(
    0,
    "pass",
    ["public-api"],
    "No public API changes.",
    'Every public-api item with status "ok" classifies the change as "none".',
  ),
  "api.additive": spec(
    1,
    "fail",
    ["public-api"],
    "Public API is extended (additive): {symbols}.",
    'A public-api item classifies the change as "additive".',
  ),
  "api.breaking": spec(
    2,
    "fail",
    ["public-api"],
    "Public API has breaking changes: {symbols}.",
    'A public-api item classifies the change as "breaking".',
  ),
  "signal.missing.public-api": spec(
    2,
    "unknown",
    ["public-api"],
    "No public API diff was recorded{detail}.",
    'No public-api item with status "ok", and no accepted skip.',
  ),
  "signal.error.public-api": spec(
    2,
    "unknown",
    ["public-api"],
    "Public API diff errored{detail}.",
    'A public-api item has status "error".',
  ),
  "signal.skip-accepted.public-api": spec(
    0,
    "pass",
    ["public-api"],
    "Public API diff was skipped and no source files changed{detail}.",
    "Only skipped public-api items, diffStats present and every changed file is non-source (docs, images, license).",
  ),

  // ------------------------------------------------------------------ dependencies (required)
  "dependency.none": spec(
    0,
    "pass",
    ["dependencies"],
    "No dependency changes.",
    "Dependency items report no added, removed or changed dependencies, no new install scripts and no lockfile change.",
  ),
  "dependency.patch": spec(
    0,
    "pass",
    ["dependencies"],
    "Patch bumps allowed in Lane 0: {names}.",
    "Patch bumps and policy.dependencies.allowPatchBumpsInLane0 is true.",
  ),
  "dependency.patch-not-allowed": spec(
    1,
    "fail",
    ["dependencies"],
    "Patch bumps, which this repo does not allow in Lane 0: {names}.",
    "Patch bumps and policy.dependencies.allowPatchBumpsInLane0 is false.",
  ),
  "dependency.minor": spec(
    1,
    "fail",
    ["dependencies"],
    "Minor version bumps: {names}.",
    'A changed dependency has bump "minor".',
  ),
  "dependency.prerelease": spec(
    1,
    "fail",
    ["dependencies"],
    "Prerelease version changes: {names}.",
    'A changed dependency has bump "prerelease".',
  ),
  "dependency.removed": spec(
    1,
    "fail",
    ["dependencies"],
    "Dependencies removed: {names}.",
    "A dependency item lists removed dependencies.",
  ),
  "dependency.lockfile-only": spec(
    1,
    "fail",
    ["dependencies"],
    "The lockfile changed without any direct dependency change, so transitive updates are unexplained.",
    "lockfileChanged is true but no dependency was added, removed or changed.",
  ),
  "dependency.added": spec(
    2,
    "fail",
    ["dependencies"],
    "New dependencies: {names}.",
    "A dependency item lists added dependencies.",
  ),
  "dependency.major": spec(
    2,
    "fail",
    ["dependencies"],
    "Major version bumps: {names}.",
    'A changed dependency has bump "major".',
  ),
  "dependency.other-bump": spec(
    2,
    "fail",
    ["dependencies"],
    "Version changes that are not plain semver bumps: {names}.",
    'A changed dependency has bump "other" (git URL, tag, range rewrite, downgrade, ...).',
  ),
  "dependency.install-script": spec(
    2,
    "fail",
    ["dependencies"],
    "New install-time lifecycle scripts: {names}.",
    "A dependency item lists newInstallScripts.",
  ),
  "signal.missing.dependencies": spec(
    2,
    "unknown",
    ["dependencies"],
    "No dependency diff was recorded{detail}.",
    'No dependencies item with status "ok" (absent, or only skipped).',
  ),
  "signal.error.dependencies": spec(
    2,
    "unknown",
    ["dependencies"],
    "Dependency diff errored{detail}.",
    'A dependencies item has status "error".',
  ),

  // ------------------------------------------------------------------ sensitive paths (required)
  "sensitive.none": spec(
    0,
    "pass",
    ["sensitive-paths"],
    "No changed file matches the base policy's sensitive paths.",
    "No hit in the sensitive-paths items and no changed path matches policy.sensitivePaths.",
  ),
  "sensitive.hit": spec(
    2,
    "fail",
    ["sensitive-paths"],
    "Touches sensitive paths: {paths}.",
    "A sensitive-paths item reports a hit, or a changed path (or rename source) matches the BASE policy.sensitivePaths.",
  ),
  "signal.missing.sensitive-paths": spec(
    2,
    "unknown",
    ["sensitive-paths"],
    "No sensitive-path scan was recorded{detail}.",
    'No sensitive-paths item with status "ok" (absent, or only skipped).',
  ),
  "signal.error.sensitive-paths": spec(
    2,
    "unknown",
    ["sensitive-paths"],
    "Sensitive-path scan errored{detail}.",
    'A sensitive-paths item has status "error".',
  ),

  // ------------------------------------------------------------------ migrations
  "migration.none": spec(
    0,
    "pass",
    ["migrations"],
    "No migration files changed.",
    "No changed path matches a migrations glob.",
  ),
  "migration.touched": spec(
    2,
    "fail",
    ["migrations"],
    "Changes migration files: {paths}.",
    "A changed path (or rename source) is under a migrations directory (**/migrations/**, **/migration/**).",
  ),

  // ------------------------------------------------------------------ platform policy
  "policy.unchanged": spec(
    0,
    "pass",
    ["policy-file"],
    "No platform policy or config under .platform/ changed.",
    "No changed path is under .platform/.",
  ),
  "policy.changed": spec(
    2,
    "fail",
    ["policy-file"],
    "Changes platform policy/config under .platform/: {paths}. A human who is not the author must approve.",
    "A changed path (or rename source) is under .platform/ (e.g. .platform/policy.ts). Also sets requiresHumanApproval.",
  ),

  // ------------------------------------------------------------------ plan
  "plan.approved": spec(
    0,
    "pass",
    ["plan"],
    "Plan {planId} is approved.",
    'Plan status is "approved", approvedBy is set and is not the plan author.',
  ),
  "plan.planless": spec(
    0,
    "pass",
    ["plan"],
    "No approved plan needed: mechanically verified {category} (policy.planlessLane0).",
    "No approved plan, but a category in policy.planlessLane0 is mechanically verified.",
  ),
  "plan.missing": spec(
    1,
    "fail",
    ["plan"],
    "No plan is attached to this change.",
    "plan is null and no planless category applies.",
  ),
  "plan.not-approved": spec(
    1,
    "fail",
    ["plan"],
    "Plan {planId} is not approved ({detail}).",
    "Plan is draft/superseded/rejected, has no approver, or was approved by its own author; and no planless category applies.",
  ),

  // ------------------------------------------------------------------ scope
  "scope.within": spec(
    0,
    "pass",
    ["scope"],
    "All changed files are within the plan's scopePaths.",
    "Plan declares scopePaths and every changed path matches one; no outOfScope glob matches.",
  ),
  "scope.not-applicable": spec(
    0,
    "pass",
    ["scope"],
    "Scope drift check not applicable: {detail}.",
    "No plan is attached, or the plan declares no scopePaths and a planless category applies.",
  ),
  "plan.scope-undeclared": spec(
    1,
    "unknown",
    ["scope"],
    "Plan {planId} declares no scopePaths, so scope drift cannot be checked.",
    "Plan is attached, scopePaths is empty and no planless category applies.",
  ),
  "scope.drift": spec(
    2,
    "fail",
    ["scope"],
    "Files outside the plan's scopePaths: {paths}.",
    "Plan declares scopePaths and a changed path (or rename source) matches none of them.",
  ),
  "scope.out-of-scope": spec(
    2,
    "fail",
    ["scope"],
    "Files match the plan's outOfScope entries: {paths}.",
    "A changed path matches an outOfScope entry that looks like a glob (contains / or *).",
  ),

  // ------------------------------------------------------------------ size
  "size.ok": spec(
    0,
    "pass",
    ["size"],
    "{lines} changed line(s) in {files} file(s), within Lane 0 limits ({maxLines} lines / {maxFiles} files).",
    "Counted lines <= lane0MaxDiffLines and counted files <= lane0MaxFiles.",
  ),
  "size.transform-excluded": spec(
    0,
    "pass",
    ["size"],
    "{lines} line(s) in {files} file(s) reproduced by verified transforms are excluded from size limits.",
    "Some changed files are fully reproduced by a verified transform.",
  ),
  "size.lines-over-lane0": spec(
    1,
    "fail",
    ["size"],
    "{lines} changed lines exceed the Lane 0 limit of {max}.",
    "lane0MaxDiffLines < counted lines <= lane1MaxDiffLines.",
  ),
  "size.files-over-lane0": spec(
    1,
    "fail",
    ["size"],
    "{files} changed files exceed the Lane 0 limit of {max}.",
    "lane0MaxFiles < counted files <= lane1MaxFiles.",
  ),
  "size.lines-over-lane1": spec(
    2,
    "fail",
    ["size"],
    "{lines} changed lines exceed the Lane 1 limit of {max}.",
    "Counted lines > lane1MaxDiffLines.",
  ),
  "size.files-over-lane1": spec(
    2,
    "fail",
    ["size"],
    "{files} changed files exceed the Lane 1 limit of {max}.",
    "Counted files > lane1MaxFiles.",
  ),

  // ------------------------------------------------------------------ coverage (Lane-0 gate)
  "coverage.ok": spec(
    0,
    "pass",
    ["coverage"],
    "Changed-line coverage {ratio} meets the threshold of {threshold}.",
    "Lowest coverage ratio over ok items >= policy.thresholds.changedLineCoverage.",
  ),
  "coverage.below-threshold": spec(
    1,
    "fail",
    ["coverage"],
    "Changed-line coverage {ratio} is below the threshold of {threshold}.",
    "Lowest coverage ratio over ok items < policy.thresholds.changedLineCoverage.",
  ),
  "signal.missing.coverage": spec(
    1,
    "unknown",
    ["coverage"],
    "No changed-line coverage was recorded{detail}.",
    'No coverage item with status "ok", and no accepted skip.',
  ),
  "signal.error.coverage": spec(
    1,
    "unknown",
    ["coverage"],
    "Changed-line coverage errored{detail}.",
    'A coverage item has status "error".',
  ),
  "signal.skip-accepted.coverage": spec(
    0,
    "pass",
    ["coverage"],
    "Coverage was skipped and no source files changed{detail}.",
    "Only skipped coverage items, diffStats present and every changed file is non-source (docs, images, license).",
  ),

  // ------------------------------------------------------------------ mutation (Lane-0 gate)
  "signal.skip-accepted.mutation": spec(
    0,
    "pass",
    ["mutation"],
    "Mutation testing was skipped and no source files changed{detail}.",
    "Only skipped mutation items, diffStats present and every changed file is non-source (docs, images, license).",
  ),
  "mutation.ok": spec(
    0,
    "pass",
    ["mutation"],
    "Mutation score {score} meets the threshold of {threshold}.",
    "Lowest mutation score over ok items >= policy.thresholds.mutationScore.",
  ),
  "mutation.below-threshold": spec(
    1,
    "fail",
    ["mutation"],
    "Mutation score {score} is below the threshold of {threshold}.",
    "Lowest mutation score over ok items < policy.thresholds.mutationScore.",
  ),
  "mutation.no-coverage": spec(
    1,
    "fail",
    ["mutation"],
    "No test exercises the changed lines: {mutants} mutant(s) without coverage (threshold {threshold}).",
    "The lowest-scoring ok mutation item killed, timed out and survived nothing and has noCoverage > 0 (no test is related to the mutated files).",
  ),
  "signal.missing.mutation": spec(
    1,
    "unknown",
    ["mutation"],
    "No mutation score was recorded{detail}.",
    'No mutation item with status "ok" (absent, or only skipped — a skip is never accepted).',
  ),
  "signal.error.mutation": spec(
    1,
    "unknown",
    ["mutation"],
    "Mutation testing errored{detail}.",
    'A mutation item has status "error".',
  ),

  // ------------------------------------------------------------------ transforms
  "transform.not-applicable": spec(
    0,
    "pass",
    ["transform"],
    "No transform claimed or recorded.",
    "Category is not transform and no transform item verified, mismatched or errored.",
  ),
  "transform.verified": spec(
    0,
    "pass",
    ["transform"],
    "Transform {transform} reproduced {files} file(s) byte-for-byte on base.",
    'A transform item has status "ok", verified true and no mismatchedFiles.',
  ),
  "transform.unverified": spec(
    1,
    "fail",
    ["transform"],
    "Claimed transform, but no transform item reproduced the change.",
    "Claimed category is transform and there is no verified transform item.",
  ),
  "transform.mismatch": spec(
    2,
    "fail",
    ["transform"],
    "Transform {transform} did not reproduce: {paths}.",
    'A transform item (any claimed category) has status "ok" and mismatchedFiles.',
  ),
  "signal.error.transform": spec(
    1,
    "unknown",
    ["transform"],
    "Transform verification errored{detail}.",
    'A transform item has status "error".',
  ),

  // ------------------------------------------------------------------ model judgments (may only raise)
  "llm.none": spec(
    0,
    "pass",
    ["llm-judgments"],
    "No model judgments recorded.",
    "No llm-judgment item with status ok or error.",
  ),
  "llm.no-concern": spec(
    0,
    "pass",
    ["llm-judgments"],
    "Model judgment on {question}: no concern (model judgments can only raise a lane).",
    'An llm-judgment item has outcome "no-concern". Never lowers anything.',
  ),
  "llm.unsure": spec(
    1,
    "unknown",
    ["llm-judgments"],
    "Model judgment on {question} is unsure: {rationale}",
    'An llm-judgment item has outcome "unsure".',
  ),
  "llm.concern": spec(
    2,
    "fail",
    ["llm-judgments"],
    "Model judgment on {question} raised a concern: {rationale}",
    'An llm-judgment item has outcome "concern".',
  ),
  "signal.error.llm-judgment": spec(
    1,
    "unknown",
    ["llm-judgments"],
    "A model judgment errored{detail}.",
    'An llm-judgment item has status "error".',
  ),

  // ------------------------------------------------------------------ quarantined tests (merge queue)
  "tests.quarantined": spec(
    1,
    "unknown",
    ["tests"],
    "{count} quarantined test(s) in this change's affected set did not count as passing: {tests}.",
    'A quarantine item with status "ok" lists tests in inAffectedSet (a quarantined test never silently counts as passing).',
  ),
  "tests.quarantined-unaffected": spec(
    0,
    "pass",
    ["tests"],
    "{count} quarantined test(s), none in this change's affected set: {tests}.",
    'A quarantine item with status "ok" lists quarantined tests, none of them in inAffectedSet.',
  ),
  "signal.error.quarantine": spec(
    1,
    "unknown",
    ["tests"],
    "The quarantine list could not be read{detail}; quarantined tests in the affected set cannot be ruled out.",
    'A quarantine item has status "error".',
  ),

  // ------------------------------------------------------------------ conflict resolution (merge queue)
  "resolution.within-conflict": spec(
    0,
    "pass",
    ["conflict-resolution"],
    "Conflict resolution against {upstream} only replaced the {hunks} conflict hunk(s) ({resolver}).",
    'A conflict-resolution item with status "ok" stays inside its conflict hunks (informational; the lane stays what the merged tree earns).',
  ),
  "resolution.outside-conflict": spec(
    1,
    "fail",
    ["conflict-resolution"],
    "The conflict resolution against {upstream} edited lines outside the conflict hunks ({resolver}).",
    'A conflict-resolution item with status "ok" has touchesOutsideConflictHunks, or edits with no conflict hunk.',
  ),
  "resolution.semantic": spec(
    1,
    "fail",
    ["conflict-resolution"],
    "Resolved a semantic conflict caused by upstream change {culprit}: {rationale}",
    'A conflict-resolution item with status "ok" names semanticConflictWith.',
  ),
  "resolution.truncated": spec(
    1,
    "unknown",
    ["conflict-resolution"],
    "The recorded resolution diff was cut at the size cap; read the resolution commit itself.",
    'A conflict-resolution item with status "ok" has truncated: true.',
  ),
  "resolution.skipped": spec(
    1,
    "unknown",
    ["conflict-resolution"],
    "A conflict resolution is recorded as skipped{detail}, so what the resolver did is unknown.",
    'A conflict-resolution item has status "skipped".',
  ),
  "signal.error.conflict-resolution": spec(
    2,
    "unknown",
    ["conflict-resolution"],
    "Conflict resolution failed{detail}.",
    'A conflict-resolution item has status "error".',
  ),
  "resolution.lane-kept": spec(
    1,
    "fail",
    ["conflict-resolution"],
    "Lane kept at {lane}: the merged tree classified lower ({next}), but a conflict resolution can only keep or raise the lane (before: {codes}).",
    "Added by neverLower when the merged tree's classification is below the Change's previous one. Its lane is the previous lane: 1 or 2.",
  ),

  // ------------------------------------------------------------------ informational signals
  "informational.ok": spec(
    0,
    "pass",
    ["informational-signals"],
    "No informational signal (preview, screenshots, agent trace) errored.",
    "No preview/screenshots/agent-trace item has status error (absent is fine).",
  ),
  "signal.error.preview": spec(
    1,
    "unknown",
    ["informational-signals"],
    "Preview deploy errored{detail}.",
    'A preview item has status "error".',
  ),
  "signal.error.screenshots": spec(
    1,
    "unknown",
    ["informational-signals"],
    "Screenshots errored{detail}.",
    'A screenshots item has status "error".',
  ),
  "signal.error.agent-trace": spec(
    1,
    "unknown",
    ["informational-signals"],
    "Agent trace capture errored{detail}.",
    'An agent-trace item has status "error".',
  ),

  // ------------------------------------------------------------------ budget & tour
  "budget.ok": spec(
    0,
    "pass",
    ["budget"],
    "The AI Gateway budget for this change was not exceeded.",
    "context.budgetExceeded is false.",
  ),
  "budget.exceeded": spec(
    2,
    "fail",
    ["budget"],
    "The AI Gateway budget for this change was exceeded.",
    "context.budgetExceeded is true.",
  ),
  "tour.ok": spec(
    0,
    "pass",
    ["tour"],
    "Tour status: {status}.",
    'context.tourStatus is "ok" or "not-generated".',
  ),
  "tour.failed": spec(
    2,
    "fail",
    ["tour"],
    "Tour generation failed; a human must review without a guided tour.",
    'context.tourStatus is "failed".',
  ),

  // ------------------------------------------------------------------ shadow mode & reverts
  "lane0.enabled": spec(
    0,
    "pass",
    ["lane0-enabled"],
    "Lane 0 is enabled for this repo.",
    "policy.lane0Enabled is true.",
  ),
  "shadow.lane0-disabled": spec(
    1,
    "fail",
    ["lane0-enabled"],
    "Computed Lane 0, but Lane 0 is disabled (shadow mode): routed to Lane 1 and recorded for shadow agreement.",
    "computedLane is 0, policy.lane0Enabled is false and the verified-revert exception does not apply. Not counted in computedLane.",
  ),
  "revert.verified": spec(
    0,
    "pass",
    [],
    "The platform verified this change is the exact inverse of a change it merged.",
    "context.pureRevertVerified is true.",
  ),
  "revert.auto-merge": spec(
    0,
    "pass",
    ["lane0-enabled"],
    "Verified pure revert: may merge in Lane 0 even in shadow mode (policy.autoMergeVerifiedReverts).",
    "pureRevertVerified, policy.autoMergeVerifiedReverts, and every raised reason is waivable (plan.missing, plan.not-approved, plan.scope-undeclared, size.*).",
  ),
  "revert.waived": spec(
    0,
    "pass",
    [],
    "Waived for a verified pure revert ({code}): {reason}",
    "Replaces each waivable reason when revert.auto-merge applies; keeps the original reason's gates.",
  ),
} as const satisfies Record<string, ReasonSpec>;

export type ReasonCode = keyof typeof REASON_CODES;

export type ReasonParams = Readonly<Record<string, string | number>>;

/** Fill a code's template. Unknown placeholders are left as-is so a missing param is visible. */
export function formatReason(code: ReasonCode, params: ReasonParams = {}): string {
  const template: string = REASON_CODES[code].template;
  return template.replace(/\{([A-Za-z]+)\}/g, (whole: string, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Codes the verified-revert exception may waive (it restores an already-approved state). */
export const REVERT_WAIVABLE_CODES: readonly ReasonCode[] = [
  "plan.missing",
  "plan.not-approved",
  "plan.scope-undeclared",
  "size.lines-over-lane0",
  "size.files-over-lane0",
  "size.lines-over-lane1",
  "size.files-over-lane1",
];
