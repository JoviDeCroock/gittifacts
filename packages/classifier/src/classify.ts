/**
 * The risk classifier: a PURE, deterministic, explainable function from evidence to a lane.
 *
 * No I/O, no clocks, no randomness, no model calls. Inputs are never mutated. Every decision is
 * a reason with a stable code from REASON_CODES; the lane is the max over reasons.
 *
 * Unknown → escalate: a missing, skipped (where a skip is not inherently fine) or errored signal
 * may only raise the lane. Claims (the author's category) and model judgments may only raise it.
 */
import type {
  ClaimedCategory,
  DiffStats,
  FileDiffStat,
  Lane,
  LaneReason,
  Plan,
  PlanlessCategory,
  RepoPolicy,
} from "@app/domain";
import {
  type ConflictResolution,
  type CoverageDelta,
  type DependencyDiff,
  type EvidenceItem,
  type EvidenceKind,
  type LlmJudgment,
  type MutationScore,
  newFailureCount,
  type PublicApiDiff,
  type Quarantine,
  type RedGreenProof,
  type ReproducibleTransform,
  type SensitivePathHits,
  type SignalStatus,
  stripAnsi,
  type TestRun,
} from "@app/evidence";
import {
  compareStrings,
  compileGlobs,
  formatList,
  LOCKFILE_GLOBS,
  MANIFEST_GLOBS,
  MIGRATION_GLOBS,
  NON_SOURCE_GLOBS,
  normalizePath,
  PLATFORM_GLOBS,
  sortStrings,
} from "./paths.js";
import { qaReasonInputs } from "./qa.js";
import {
  formatReason,
  GATES,
  type Gate,
  REASON_CODES,
  REVERT_WAIVABLE_CODES,
  type ReasonCode,
  type ReasonOutcome,
  type ReasonParams,
} from "./reasons.js";

// ---------------------------------------------------------------- public types

export type CiStatus = "passed" | "failed" | "errored" | "cancelled" | "unknown";
export type TourStatus = "ok" | "failed" | "not-generated";

export interface ClassifyContext {
  ciStatus: CiStatus;
  /** Attestation over the evidence verified against the platform key. */
  evidenceVerified: boolean;
  /** Per-change AI Gateway budget was exceeded at any point. */
  budgetExceeded: boolean;
  /** Tour generation outcome (tour is generated for lane >= 1; failure escalates). */
  tourStatus: TourStatus;
  /** Platform verified this change is the exact inverse of a change it merged. */
  pureRevertVerified: boolean;
}

export interface ChecklistEntry {
  gate: Gate;
  /** true = condition holds, false = measured and fails, null = unknown (missing/errored). */
  passed: boolean | null;
  detail: string;
}

export interface ClassifyResult {
  /** What the platform routes on (after shadow mode). */
  lane: Lane;
  /** Max over reasons, before shadow mode. */
  computedLane: Lane;
  /** Every reason, sorted by lane desc then code (then message, evidenceRef). */
  reasons: LaneReason[];
  /** True when computedLane is 0 but policy.lane0Enabled is false (and no verified-revert exception). */
  shadow: boolean;
  /** Cannot merge at all: CI failed, or the evidence attestation did not verify. */
  blocked: boolean;
  /** Must be approved by a human who is not the author (policy file changed, or unknowable). */
  requiresHumanApproval: boolean;
  /** The Lane-0 conditions in GATES order; null = unknown. */
  checklist: ChecklistEntry[];
}

export interface ClassifyChange {
  readonly category: ClaimedCategory;
}

export interface ClassifyEvidence {
  readonly items: readonly EvidenceItem[];
}

// ---------------------------------------------------------------- reason collection

interface InternalReason {
  code: ReasonCode;
  lane: Lane;
  message: string;
  evidenceRef?: string;
  gates: readonly Gate[];
  outcome: ReasonOutcome;
}

function makeReason(
  code: ReasonCode,
  params: ReasonParams = {},
  evidenceRef?: string,
  laneOverride?: Lane,
): InternalReason {
  const spec = REASON_CODES[code];
  const reason: InternalReason = {
    code,
    lane: laneOverride ?? spec.lane,
    message: formatReason(code, params),
    gates: spec.gates,
    outcome: spec.outcome,
  };
  if (evidenceRef !== undefined) reason.evidenceRef = evidenceRef;
  return reason;
}

class Reasons {
  readonly list: InternalReason[] = [];

  add(code: ReasonCode, params?: ReasonParams, evidenceRef?: string, laneOverride?: Lane): void {
    this.list.push(makeReason(code, params, evidenceRef, laneOverride));
  }

  hasGate(gate: Gate): boolean {
    return this.list.some((r) => r.gates.includes(gate));
  }
}

function compareReasons(a: InternalReason, b: InternalReason): number {
  return (
    b.lane - a.lane ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.message, b.message) ||
    compareStrings(a.evidenceRef ?? "", b.evidenceRef ?? "")
  );
}

function maxLane(reasons: readonly InternalReason[]): Lane {
  let lane: Lane = 0;
  for (const r of reasons) if (r.lane > lane) lane = r.lane;
  return lane;
}

// ---------------------------------------------------------------- evidence helpers

type ItemOf<K extends EvidenceKind> = Extract<EvidenceItem, { kind: K }>;

function ofKind<K extends EvidenceKind>(items: readonly EvidenceItem[], kind: K): ItemOf<K>[] {
  return items.filter((item): item is ItemOf<K> => item.kind === kind);
}

interface SignalRead<T> {
  ok: T[];
  errored: T[];
  skipped: T[];
}

function readSignal<T extends { status: SignalStatus }>(items: readonly T[]): SignalRead<T> {
  return {
    ok: items.filter((i) => i.status === "ok"),
    errored: items.filter((i) => i.status === "error"),
    skipped: items.filter((i) => i.status === "skipped"),
  };
}

function truncate(text: string, max = 280): string {
  // Tool output in notes can carry colour codes; reasons are read by people.
  const oneLine = stripAnsi(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** ": <note>" for an errored item, "" without a note. */
function errorDetail(item: { note?: string | undefined }): string {
  return item.note ? `: ${truncate(item.note)}` : "";
}

/** " (skipped: <note>)" when the only items were skipped, "" when absent. */
function skippedDetail(skipped: readonly { note?: string | undefined }[]): string {
  if (skipped.length === 0) return "";
  const notes = skipped.map((s) => (s.note ? truncate(s.note, 140) : "no reason given"));
  return ` (skipped: ${formatList(notes, 3)})`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** Every repo path a diff touches, including rename/copy sources. Sorted, unique. */
function changedPaths(files: readonly FileDiffStat[]): string[] {
  const paths = new Set<string>();
  for (const f of files) {
    paths.add(normalizePath(f.path));
    if (f.previousPath !== null) paths.add(normalizePath(f.previousPath));
  }
  return sortStrings([...paths]);
}

function lines(f: FileDiffStat): number {
  return f.additions + f.deletions;
}

// ---------------------------------------------------------------- transforms

interface TransformAnalysis {
  read: SignalRead<ReproducibleTransform>;
  verified: ReproducibleTransform[];
  mismatched: ReproducibleTransform[];
  /** A file is covered when its path (and rename source) is listed in a verified transform. */
  covers: (file: FileDiffStat) => boolean;
}

function analyzeTransforms(items: readonly ReproducibleTransform[]): TransformAnalysis {
  const read = readSignal(items);
  // verified=true with mismatchedFiles is contradictory: treat it as a mismatch, never as verified.
  const verified = read.ok.filter((t) => t.verified && t.mismatchedFiles.length === 0);
  const mismatched = read.ok.filter((t) => t.mismatchedFiles.length > 0);
  const covered = new Set<string>();
  for (const t of verified) for (const f of t.files) covered.add(normalizePath(f));
  const covers = (file: FileDiffStat): boolean =>
    covered.has(normalizePath(file.path)) &&
    (file.previousPath === null || covered.has(normalizePath(file.previousPath)));
  return { read, verified, mismatched, covers };
}

// ---------------------------------------------------------------- planless categories

const PLANLESS_ORDER: readonly PlanlessCategory[] = [
  "pure-revert",
  "verified-transform",
  "dependency-patch",
];

const isManifest = compileGlobs(MANIFEST_GLOBS, "match-none");
const isLockfile = compileGlobs(LOCKFILE_GLOBS, "match-none");
const isMigration = compileGlobs(MIGRATION_GLOBS, "match-all");
const isPlatformFile = compileGlobs(PLATFORM_GLOBS, "match-all");
const isNonSource = compileGlobs(NON_SOURCE_GLOBS, "match-none");

/**
 * dependency-patch, verified mechanically (the claimed category is ignored):
 * - every changed file is a modified package manifest or lockfile (no adds/deletes/renames);
 * - dependency evidence is ok (none errored) and shows >= 1 change, all of them patch bumps,
 *   with nothing added or removed and no new install scripts;
 * - each changed manifest has no more added/deleted lines than patch bumps recorded against it,
 *   so nothing else (scripts, overrides, config) can ride along in package.json;
 * - a changed lockfile was checked and every entry change is explained: one registry patch bump
 *   of a bumped package, nothing added or removed (`lockfile.verified`). Not checked → not Lane 0.
 */
function isDependencyPatchOnly(
  diffStats: DiffStats | null,
  deps: SignalRead<DependencyDiff>,
): boolean {
  if (diffStats === null || diffStats.files.length === 0) return false;
  if (deps.errored.length > 0 || deps.ok.length === 0) return false;
  const changes = deps.ok.flatMap((d) => d.changed);
  if (changes.length === 0) return false;
  if (changes.some((c) => c.bump !== "patch")) return false;
  if (deps.ok.some((d) => d.added.length > 0 || d.removed.length > 0)) return false;
  if (deps.ok.some((d) => d.newInstallScripts.length > 0)) return false;
  const lockTouched =
    diffStats.files.some((f) => isLockfile(normalizePath(f.path))) ||
    deps.ok.some((d) => d.lockfileChanged);
  if (lockTouched) {
    if (!deps.ok.some((d) => d.lockfile?.verified === true)) return false;
    const unexplained = (d: DependencyDiff) =>
      (d.lockfileChanged || d.lockfile !== undefined) && d.lockfile?.verified !== true;
    if (deps.ok.some(unexplained)) return false;
  }
  for (const f of diffStats.files) {
    const path = normalizePath(f.path);
    if (f.previousPath !== null && normalizePath(f.previousPath) !== path) return false;
    if (f.status !== "modified") return false;
    if (isLockfile(path)) continue;
    if (!isManifest(path)) return false;
    const bumps = changes.filter((c) => normalizePath(c.manifest) === path).length;
    if (bumps === 0 || f.additions > bumps || f.deletions > bumps) return false;
  }
  return true;
}

function satisfiedPlanless(
  policy: RepoPolicy,
  context: ClassifyContext,
  diffStats: DiffStats | null,
  deps: SignalRead<DependencyDiff>,
  transforms: TransformAnalysis,
): PlanlessCategory | null {
  for (const category of PLANLESS_ORDER) {
    if (!policy.planlessLane0.includes(category)) continue;
    switch (category) {
      case "pure-revert":
        if (context.pureRevertVerified) return category;
        break;
      case "verified-transform":
        if (
          diffStats !== null &&
          diffStats.files.length > 0 &&
          diffStats.files.every(transforms.covers)
        )
          return category;
        break;
      case "dependency-patch":
        if (isDependencyPatchOnly(diffStats, deps)) return category;
        break;
    }
  }
  return null;
}

// ---------------------------------------------------------------- individual checks

/** Own-property lookup, so unexpected runtime strings (even "constructor") fall back. */
function lookup<T>(table: Readonly<Record<string, T>>, key: string, fallback: T): T {
  return Object.hasOwn(table, key) ? (table[key] ?? fallback) : fallback;
}

const CI_CODES: Readonly<Record<CiStatus, ReasonCode>> = {
  passed: "ci.passed",
  failed: "ci.failed",
  errored: "ci.errored",
  cancelled: "ci.cancelled",
  unknown: "ci.unknown",
};

function checkCi(out: Reasons, status: CiStatus): void {
  // An unexpected runtime value (bypassing the type) is unknown, never "passed".
  out.add(lookup<ReasonCode>(CI_CODES, status, "ci.unknown"));
}

/**
 * Test runs. Only failures that are new against the Change's base count: a run's `preExisting`
 * failures are discounted when its baseline is usable and of the Change's base commit. Without
 * the base (`diffStats` unknown) or a baseline, every failure counts (unknown escalates).
 */
function checkTests(out: Reasons, items: readonly TestRun[], baseSha: string | null): void {
  const s = readSignal(items);
  for (const e of s.errored) out.add("signal.error.test-run", { detail: errorDetail(e) }, e.id);
  if (s.ok.length === 0) {
    if (s.errored.length === 0)
      out.add("signal.missing.test-run", { detail: skippedDetail(s.skipped) }, s.skipped[0]?.id);
    return;
  }
  const counted = s.ok.map((r) => ({
    r,
    failed: baseSha === null ? r.failed : newFailureCount(r, baseSha),
  }));
  const failing = counted.filter((c) => c.failed > 0);
  for (const c of failing) out.add("tests.failing", { step: c.r.step, failed: c.failed }, c.r.id);
  for (const c of counted) {
    const pre = c.r.failed - c.failed;
    if (pre > 0)
      out.add(
        "tests.preexisting",
        { step: c.r.step, count: pre, base: (baseSha ?? "").slice(0, 12) },
        c.r.id,
      );
  }
  if (failing.length === 0) {
    const passed = s.ok.reduce((n, r) => n + r.passed, 0);
    out.add(
      "tests.passed",
      { passed, runs: s.ok.length },
      s.ok.length === 1 ? s.ok[0]?.id : undefined,
    );
  }
}

function checkRedGreen(
  out: Reasons,
  items: readonly RedGreenProof[],
  category: ClaimedCategory,
): void {
  const s = readSignal(items);
  const required = category === "fix";
  // Required for a claimed fix (Lane 2 when errored); otherwise an errored proof is an
  // errored optional signal (Lane 1). Verdicts only matter for a claimed fix.
  for (const e of s.errored)
    out.add("signal.error.red-green", { detail: errorDetail(e) }, e.id, required ? 2 : 1);
  if (!required) {
    out.add("red-green.not-required", { category });
    return;
  }
  if (s.ok.length === 0) {
    if (s.errored.length === 0)
      out.add("signal.missing.red-green", { detail: skippedDetail(s.skipped) }, s.skipped[0]?.id);
    return;
  }
  for (const p of s.ok) {
    if (p.verdict === "not-proven") out.add("red-green.not-proven", {}, p.id);
    else if (p.verdict === "no-tests") out.add("red-green.no-tests", {}, p.id);
    else if (p.verdict !== "proven") out.add("red-green.not-proven", {}, p.id); // unknown verdict
  }
  if (s.ok.every((p) => p.verdict === "proven")) {
    const tests = s.ok.reduce((n, p) => n + p.tests.length, 0);
    out.add("red-green.proven", { tests }, s.ok.length === 1 ? s.ok[0]?.id : undefined);
  }
}

function checkPublicApi(
  out: Reasons,
  items: readonly PublicApiDiff[],
  noSourceChanged: boolean,
): void {
  const s = readSignal(items);
  for (const e of s.errored) out.add("signal.error.public-api", { detail: errorDetail(e) }, e.id);
  if (s.ok.length === 0) {
    if (s.errored.length > 0) return;
    if (s.skipped.length > 0 && noSourceChanged) {
      out.add(
        "signal.skip-accepted.public-api",
        { detail: skippedDetail(s.skipped) },
        s.skipped[0]?.id,
      );
    } else {
      out.add("signal.missing.public-api", { detail: skippedDetail(s.skipped) }, s.skipped[0]?.id);
    }
    return;
  }
  let flagged = false;
  for (const d of s.ok) {
    if (d.classification === "breaking") {
      const symbols = d.packages.flatMap((p) =>
        [...p.removed, ...p.changed].map((c) => `${p.name}:${c.symbol}`),
      );
      out.add("api.breaking", { symbols: formatList(symbols, 8, "see evidence") }, d.id);
      flagged = true;
    } else if (d.classification === "additive") {
      const symbols = d.packages.flatMap((p) => p.added.map((c) => `${p.name}:${c.symbol}`));
      out.add("api.additive", { symbols: formatList(symbols, 8, "see evidence") }, d.id);
      flagged = true;
    } else if (d.classification !== "none") {
      // Unknown classification at runtime: escalate as breaking.
      out.add("api.breaking", { symbols: "unrecognised classification" }, d.id);
      flagged = true;
    }
  }
  if (!flagged) out.add("api.none", {}, s.ok.length === 1 ? s.ok[0]?.id : undefined);
}

function checkDependencies(out: Reasons, s: SignalRead<DependencyDiff>, policy: RepoPolicy): void {
  for (const e of s.errored) out.add("signal.error.dependencies", { detail: errorDetail(e) }, e.id);
  if (s.ok.length === 0) {
    if (s.errored.length === 0)
      out.add(
        "signal.missing.dependencies",
        { detail: skippedDetail(s.skipped) },
        s.skipped[0]?.id,
      );
    return;
  }
  /** Anchor an aggregated reason to the first item that contributed to it. */
  const ref = (has: (d: DependencyDiff) => boolean): string | undefined => s.ok.find(has)?.id;

  const added = s.ok.flatMap((d) => d.added);
  const removed = s.ok.flatMap((d) => d.removed);
  const changed = s.ok.flatMap((d) => d.changed);
  const scripts = s.ok.flatMap((d) => d.newInstallScripts);
  const lockfileChanged = s.ok.some((d) => d.lockfileChanged);

  if (added.length > 0)
    out.add(
      "dependency.added",
      { names: formatList(added.map((a) => `${a.name}@${a.version}${a.dev ? " (dev)" : ""}`)) },
      ref((d) => d.added.length > 0),
    );
  if (removed.length > 0)
    out.add(
      "dependency.removed",
      { names: formatList(removed.map((r) => r.name)) },
      ref((d) => d.removed.length > 0),
    );
  if (scripts.length > 0)
    out.add(
      "dependency.install-script",
      {
        names: formatList(
          scripts.map((x) => `${x.name} (${x.script}: ${truncate(x.command, 80)})`),
        ),
      },
      ref((d) => d.newInstallScripts.length > 0),
    );

  const bumpCodes: Record<string, ReasonCode> = {
    major: "dependency.major",
    other: "dependency.other-bump",
    minor: "dependency.minor",
    prerelease: "dependency.prerelease",
    patch: policy.dependencies.allowPatchBumpsInLane0
      ? "dependency.patch"
      : "dependency.patch-not-allowed",
  };
  const byCode = new Map<ReasonCode, string[]>();
  for (const c of changed) {
    // A bump kind this classifier does not know is treated like "other" (Lane 2).
    const code = lookup<ReasonCode>(bumpCodes, c.bump, "dependency.other-bump");
    const names = byCode.get(code) ?? [];
    names.push(`${c.name} ${c.from} → ${c.to}`);
    byCode.set(code, names);
  }
  for (const [code, names] of byCode) {
    out.add(
      code,
      { names: formatList(names) },
      ref((d) => d.changed.length > 0),
    );
  }

  // A changed lockfile rides along with the manifest only when every entry change is explained
  // (recorded patch bumps, from the registry). Not checked or not explained → escalate.
  const unverified = s.ok.filter((d) => d.lockfileChanged && d.lockfile?.verified !== true);
  if (unverified.length > 0 && (added.length > 0 || removed.length > 0 || changed.length > 0)) {
    const problems = unverified.flatMap((d) => d.lockfile?.problems ?? []);
    const unchecked = unverified.some((d) => d.lockfile === undefined);
    out.add(
      "dependency.lockfile-unverified",
      {
        detail: unchecked
          ? ": the lockfiles were not checked"
          : `: ${formatList(problems.map((p) => truncate(p, 160)))}`,
      },
      unverified[0]?.id,
    );
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    if (lockfileChanged)
      out.add(
        "dependency.lockfile-only",
        {},
        ref((d) => d.lockfileChanged),
      );
    else if (scripts.length === 0)
      out.add("dependency.none", {}, s.ok.length === 1 ? s.ok[0]?.id : undefined);
  }
}

function checkSensitive(
  out: Reasons,
  items: readonly SensitivePathHits[],
  paths: readonly string[],
  policy: RepoPolicy,
): void {
  const s = readSignal(items);
  for (const e of s.errored)
    out.add("signal.error.sensitive-paths", { detail: errorDetail(e) }, e.id);
  if (s.ok.length === 0 && s.errored.length === 0)
    out.add(
      "signal.missing.sensitive-paths",
      { detail: skippedDetail(s.skipped) },
      s.skipped[0]?.id,
    );

  // Defence in depth: the evidence may have been computed with the head's policy. Always also
  // match the diff against the BASE policy passed in here.
  const hits: string[] = [];
  for (const item of s.ok)
    for (const h of item.hits) hits.push(`${normalizePath(h.path)} (${h.pattern})`);
  for (const pattern of policy.sensitivePaths) {
    const matches = compileGlobs([pattern], "match-all");
    for (const p of paths) if (matches(p)) hits.push(`${p} (${pattern})`);
  }
  if (hits.length > 0) {
    out.add("sensitive.hit", { paths: formatList(hits) }, s.ok.find((i) => i.hits.length > 0)?.id);
  } else if (s.ok.length > 0) {
    out.add("sensitive.none", {}, s.ok.length === 1 ? s.ok[0]?.id : undefined);
  }
}

function checkScope(
  out: Reasons,
  plan: Plan | null,
  planless: PlanlessCategory | null,
  diffStats: DiffStats | null,
  paths: readonly string[],
): void {
  if (plan === null) {
    out.add("scope.not-applicable", { detail: "no plan is attached" });
    return;
  }
  const declared = plan.scopePaths.length > 0;
  if (!declared) {
    if (planless !== null) {
      out.add("scope.not-applicable", {
        detail: `plan ${plan.id} declares no scopePaths and planless ${planless} applies`,
      });
    } else {
      out.add("plan.scope-undeclared", { planId: plan.id });
    }
  }
  if (diffStats === null) return; // signal.missing.diff-stats already covers the scope gate

  let raised = false;
  if (declared) {
    const inScope = compileGlobs(plan.scopePaths, "match-none");
    const drift = paths.filter((p) => !inScope(p));
    if (drift.length > 0) {
      out.add("scope.drift", { paths: formatList(drift) });
      raised = true;
    }
  }
  // Free-text outOfScope entries are for humans; only glob-looking ones are machine-checked.
  const globs = plan.outOfScope.filter((e) => e.includes("/") || e.includes("*"));
  if (globs.length > 0) {
    const outOfScope = compileGlobs(globs, "match-all");
    const hits = paths.filter((p) => outOfScope(p));
    if (hits.length > 0) {
      out.add("scope.out-of-scope", { paths: formatList(hits) });
      raised = true;
    }
  }
  if (declared && !raised) out.add("scope.within");
}

function planApprovalProblem(plan: Plan): string | null {
  if (plan.status !== "approved") return `status is ${plan.status}`;
  if (plan.approvedBy === null) return "no approver is recorded";
  if (plan.approvedBy === plan.authorId) return "it was approved by its own author";
  return null;
}

function checkPlan(out: Reasons, plan: Plan | null, planless: PlanlessCategory | null): void {
  const problem = plan === null ? "missing" : planApprovalProblem(plan);
  if (plan !== null && problem === null) out.add("plan.approved", { planId: plan.id });
  else if (planless !== null) out.add("plan.planless", { category: planless });
  else if (plan === null) out.add("plan.missing");
  else out.add("plan.not-approved", { planId: plan.id, detail: problem ?? "unknown" });
}

function checkSize(
  out: Reasons,
  diffStats: DiffStats,
  covers: (f: FileDiffStat) => boolean,
  policy: RepoPolicy,
): void {
  const t = policy.thresholds;
  const covered = diffStats.files.filter(covers);
  const perFile = diffStats.files.reduce((n, f) => n + lines(f), 0);
  // If the header totals disagree with the per-file sum, trust the larger number.
  const total = Math.max(diffStats.additions + diffStats.deletions, perFile);
  const excludedLines = covered.reduce((n, f) => n + lines(f), 0);
  const countedLines = Math.max(0, total - excludedLines);
  const countedFiles = diffStats.files.length - covered.length;

  if (covered.length > 0)
    out.add("size.transform-excluded", { lines: excludedLines, files: covered.length });

  let raised = false;
  if (countedLines > t.lane1MaxDiffLines) {
    out.add("size.lines-over-lane1", { lines: countedLines, max: t.lane1MaxDiffLines });
    raised = true;
  } else if (countedLines > t.lane0MaxDiffLines) {
    out.add("size.lines-over-lane0", { lines: countedLines, max: t.lane0MaxDiffLines });
    raised = true;
  }
  if (countedFiles > t.lane1MaxFiles) {
    out.add("size.files-over-lane1", { files: countedFiles, max: t.lane1MaxFiles });
    raised = true;
  } else if (countedFiles > t.lane0MaxFiles) {
    out.add("size.files-over-lane0", { files: countedFiles, max: t.lane0MaxFiles });
    raised = true;
  }
  if (!raised)
    out.add("size.ok", {
      lines: countedLines,
      files: countedFiles,
      maxLines: t.lane0MaxDiffLines,
      maxFiles: t.lane0MaxFiles,
    });
}

function checkCoverage(
  out: Reasons,
  items: readonly CoverageDelta[],
  threshold: number,
  noSourceChanged: boolean,
): void {
  const s = readSignal(items);
  for (const e of s.errored) out.add("signal.error.coverage", { detail: errorDetail(e) }, e.id);
  if (s.ok.length === 0) {
    if (s.errored.length > 0) return;
    if (s.skipped.length > 0 && noSourceChanged) {
      out.add(
        "signal.skip-accepted.coverage",
        { detail: skippedDetail(s.skipped) },
        s.skipped[0]?.id,
      );
    } else {
      out.add("signal.missing.coverage", { detail: skippedDetail(s.skipped) }, s.skipped[0]?.id);
    }
    return;
  }
  // The lowest ratio wins; a ratio that disagrees with its own counts is read pessimistically.
  let worst = s.ok[0] as CoverageDelta;
  let worstRatio = Number.POSITIVE_INFINITY;
  for (const c of s.ok) {
    const counted = c.changedLines > 0 ? c.coveredChangedLines / c.changedLines : c.ratio;
    const ratio = Math.min(c.ratio, counted);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worst = c;
    }
  }
  const params = { ratio: pct(worstRatio), threshold: pct(threshold) };
  if (worstRatio >= threshold) out.add("coverage.ok", params, worst.id);
  else out.add("coverage.below-threshold", params, worst.id);
}

function checkMutation(
  out: Reasons,
  items: readonly MutationScore[],
  threshold: number,
  noSourceChanged: boolean,
): void {
  const s = readSignal(items);
  for (const e of s.errored) out.add("signal.error.mutation", { detail: errorDetail(e) }, e.id);
  if (s.ok.length === 0) {
    if (s.errored.length > 0) return;
    // A skipped mutation run is only accepted when no source file changed (docs, images, licence):
    // there is no behaviour to assert. Anywhere else it is the only proof the tests assert behaviour.
    if (s.skipped.length > 0 && noSourceChanged)
      out.add(
        "signal.skip-accepted.mutation",
        { detail: skippedDetail(s.skipped) },
        s.skipped[0]?.id,
      );
    else out.add("signal.missing.mutation", { detail: skippedDetail(s.skipped) }, s.skipped[0]?.id);
    return;
  }
  let worst = s.ok[0] as MutationScore;
  let worstScore = Number.POSITIVE_INFINITY;
  for (const m of s.ok) {
    const valid = m.killed + m.timedOut + m.survived + m.noCoverage;
    const counted = valid > 0 ? (m.killed + m.timedOut) / valid : m.score;
    const score = Math.min(m.score, counted);
    if (score < worstScore) {
      worstScore = score;
      worst = m;
    }
  }
  const params = { score: pct(worstScore), threshold: pct(threshold) };
  // No mutant ran against a test: nothing exercises the changed lines (measured, not an error).
  const untested = worst.killed + worst.timedOut + worst.survived === 0 && worst.noCoverage > 0;
  if (worstScore >= threshold) out.add("mutation.ok", params, worst.id);
  else if (untested)
    out.add(
      "mutation.no-coverage",
      { mutants: worst.noCoverage, threshold: params.threshold },
      worst.id,
    );
  else out.add("mutation.below-threshold", params, worst.id);
}

function checkTransforms(out: Reasons, t: TransformAnalysis, category: ClaimedCategory): void {
  for (const e of t.read.errored)
    out.add("signal.error.transform", { detail: errorDetail(e) }, e.id);
  for (const m of t.mismatched)
    out.add(
      "transform.mismatch",
      { transform: m.transform, paths: formatList(m.mismatchedFiles) },
      m.id,
    );
  for (const v of t.verified)
    out.add("transform.verified", { transform: v.transform, files: v.files.length }, v.id);
  if (category === "transform" && t.verified.length === 0) out.add("transform.unverified");
  if (!out.hasGate("transform")) out.add("transform.not-applicable");
}

function checkLlm(out: Reasons, items: readonly LlmJudgment[]): void {
  const s = readSignal(items);
  for (const e of s.errored) out.add("signal.error.llm-judgment", { detail: errorDetail(e) }, e.id);
  for (const j of s.ok) {
    const params = { question: j.question, rationale: truncate(j.rationale) };
    // Model judgments may only RAISE: "no-concern" is listed for transparency at Lane 0 and can
    // never offset any other reason (the lane is a max).
    if (j.outcome === "no-concern") out.add("llm.no-concern", params, j.id);
    else if (j.outcome === "unsure") out.add("llm.unsure", params, j.id);
    else out.add("llm.concern", params, j.id); // "concern" and anything unrecognised
  }
  if (s.ok.length === 0 && s.errored.length === 0) out.add("llm.none");
}

/**
 * Quarantined tests (merge queue). A quarantined test never silently counts as passing: one in the
 * Change's affected set raises to Lane 1 on the tests gate; an unreadable quarantine list is unknown.
 */
function checkQuarantine(out: Reasons, items: readonly Quarantine[]): void {
  const s = readSignal(items);
  for (const e of s.errored) out.add("signal.error.quarantine", { detail: errorDetail(e) }, e.id);
  for (const q of s.ok) {
    if (q.inAffectedSet.length > 0) {
      out.add(
        "tests.quarantined",
        { count: q.inAffectedSet.length, tests: formatList(q.inAffectedSet) },
        q.id,
      );
    } else if (q.tests.length > 0) {
      out.add(
        "tests.quarantined-unaffected",
        { count: q.tests.length, tests: formatList(q.tests.map((t) => t.id)) },
        q.id,
      );
    }
  }
}

/**
 * Merge-queue conflict resolutions (written by the resolver agent, never the author). They can
 * only add reasons: a resolution inside the conflict hunks is informational, anything else raises.
 * Contradictory items are read pessimistically: edits with no conflict hunk count as outside.
 */
function checkResolutions(out: Reasons, items: readonly ConflictResolution[]): void {
  for (const r of items) {
    if (r.status === "error") {
      out.add("signal.error.conflict-resolution", { detail: errorDetail(r) }, r.id);
      continue;
    }
    if (r.status !== "ok") {
      // "skipped" or anything unrecognised: the resolver's work is unknown.
      out.add("resolution.skipped", { detail: errorDetail(r) }, r.id);
      continue;
    }
    const upstream = formatList(
      r.upstreamChanges.map((u) => u.changeId),
      8,
      "no upstream change",
    );
    const resolver = `${r.resolver.principalId}, ${r.resolver.model}`;
    const outside =
      r.touchesOutsideConflictHunks ||
      (r.conflictHunks.length === 0 && r.resolutionDiff.trim() !== "");
    if (outside) out.add("resolution.outside-conflict", { upstream, resolver }, r.id);
    if (r.semanticConflictWith !== null)
      out.add(
        "resolution.semantic",
        { culprit: r.semanticConflictWith, rationale: truncate(r.rationale) },
        r.id,
      );
    if (r.truncated) out.add("resolution.truncated", {}, r.id);
    if (!outside && r.semanticConflictWith === null && !r.truncated)
      out.add(
        "resolution.within-conflict",
        { upstream, hunks: r.conflictHunks.length, resolver },
        r.id,
      );
  }
}

const INFORMATIONAL: ReadonlyArray<readonly [EvidenceKind, ReasonCode]> = [
  ["preview", "signal.error.preview"],
  ["screenshots", "signal.error.screenshots"],
  ["agent-trace", "signal.error.agent-trace"],
];

function checkInformational(out: Reasons, items: readonly EvidenceItem[]): void {
  let errored = false;
  for (const [kind, code] of INFORMATIONAL) {
    for (const e of readSignal(ofKind(items, kind)).errored) {
      out.add(code, { detail: errorDetail(e) }, e.id);
      errored = true;
    }
  }
  if (!errored) out.add("informational.ok");
}

// ---------------------------------------------------------------- checklist

const LANE0_DISABLED_DETAIL =
  "Lane 0 is disabled for this repo (shadow mode): Lane 0 candidates are routed to Lane 1 and recorded for shadow agreement.";

function buildChecklist(
  reasons: readonly InternalReason[],
  policy: RepoPolicy,
  revertAutoMerge: boolean,
): ChecklistEntry[] {
  return GATES.map((gate): ChecklistEntry => {
    if (gate === "lane0-enabled") {
      if (revertAutoMerge) return { gate, passed: true, detail: formatReason("revert.auto-merge") };
      if (policy.lane0Enabled) return { gate, passed: true, detail: formatReason("lane0.enabled") };
      return { gate, passed: false, detail: LANE0_DISABLED_DETAIL };
    }
    const mine = reasons.filter((r) => r.gates.includes(gate));
    const raised = mine.filter((r) => r.lane > 0);
    if (raised.length > 0) {
      const passed = raised.some((r) => r.outcome === "fail") ? false : null;
      return { gate, passed, detail: raised.map((r) => r.message).join(" ") };
    }
    const detail = mine.map((r) => r.message).join(" ");
    if (gate === "qa" && detail === "")
      return { gate, passed: true, detail: "QA was not requested (optional)." };
    return { gate, passed: true, detail: detail || "No issues." };
  });
}

// ---------------------------------------------------------------- classify

/**
 * Route a Change to a risk lane.
 *
 * @param evidence  the change's evidence items (null when none was recorded)
 * @param policy    ALWAYS the base-branch policy, never the head's
 * @param plan      the attached plan, if any
 * @param diffStats base..head diff statistics (null when unavailable)
 * @param change    the author's claim — an input to risk, never the decision
 * @param context   platform facts gathered outside the evidence bundle
 */
export function classify(
  evidence: ClassifyEvidence | null,
  policy: RepoPolicy,
  plan: Plan | null,
  diffStats: DiffStats | null,
  change: ClassifyChange,
  context: ClassifyContext,
): ClassifyResult {
  const out = new Reasons();
  const items: readonly EvidenceItem[] = evidence?.items ?? [];
  const paths = diffStats === null ? [] : changedPaths(diffStats.files);
  // Vacuously true for an empty diff; false when the diff is unknown.
  const noSourceChanged = diffStats !== null && paths.every((p) => isNonSource(p));

  // CI and the evidence bundle itself.
  checkCi(out, context.ciStatus);
  if (evidence === null) out.add("signal.missing.evidence");
  else if (context.evidenceVerified) out.add("evidence.verified");
  else out.add("evidence.unverified");
  if (diffStats === null) out.add("signal.missing.diff-stats");

  // Required signals (absent/errored → Lane 2).
  checkTests(out, ofKind(items, "test-run"), diffStats?.baseSha ?? null);
  checkQuarantine(out, ofKind(items, "quarantine"));
  checkRedGreen(out, ofKind(items, "red-green"), change.category);
  checkPublicApi(out, ofKind(items, "public-api"), noSourceChanged);
  const deps = readSignal(ofKind(items, "dependencies"));
  checkDependencies(out, deps, policy);
  checkSensitive(out, ofKind(items, "sensitive-paths"), paths, policy);

  // Mechanical facts from the diff.
  if (diffStats !== null) {
    const migrations = paths.filter((p) => isMigration(p));
    if (migrations.length > 0) out.add("migration.touched", { paths: formatList(migrations) });
    else out.add("migration.none");
    const platform = paths.filter((p) => isPlatformFile(p));
    if (platform.length > 0) out.add("policy.changed", { paths: formatList(platform) });
    else out.add("policy.unchanged");
  }

  // Plan, scope and planless categories.
  const transforms = analyzeTransforms(ofKind(items, "transform"));
  const planless = satisfiedPlanless(policy, context, diffStats, deps, transforms);
  checkPlan(out, plan, planless);
  checkScope(out, plan, planless, diffStats, paths);

  // Size (verified transform files excluded), Lane-0 gates, transforms.
  if (diffStats !== null) checkSize(out, diffStats, transforms.covers, policy);
  checkCoverage(
    out,
    ofKind(items, "coverage"),
    policy.thresholds.changedLineCoverage,
    noSourceChanged,
  );
  checkMutation(out, ofKind(items, "mutation"), policy.thresholds.mutationScore, noSourceChanged);
  checkTransforms(out, transforms, change.category);

  // Model judgments (raise only), informational signals, budget, tour.
  checkLlm(out, ofKind(items, "llm-judgment"));
  // QA in a browser, on request only: absent raises nothing; a failure or "couldn't test" raises.
  for (const r of qaReasonInputs(ofKind(items, "qa-run"))) out.add(r.code, r.params, r.evidenceRef);
  checkResolutions(out, ofKind(items, "conflict-resolution"));
  checkInformational(out, items);
  out.add(context.budgetExceeded ? "budget.exceeded" : "budget.ok");
  if (context.tourStatus === "failed") out.add("tour.failed");
  else if (context.tourStatus === "ok" || context.tourStatus === "not-generated")
    out.add("tour.ok", { status: context.tourStatus === "ok" ? "generated" : "not generated yet" });
  else out.add("tour.failed"); // unrecognised status at runtime
  if (policy.lane0Enabled) out.add("lane0.enabled");
  if (context.pureRevertVerified) out.add("revert.verified");

  // Verified-revert exception: a mechanically verified exact inverse of a merged change restores
  // an already-approved state. If the only raised reasons are about plan paperwork or size, they
  // are waived (kept visible as revert.waived) and the change may merge in Lane 0 even in shadow.
  const waivable = new Set<ReasonCode>(REVERT_WAIVABLE_CODES);
  const revertAutoMerge =
    context.pureRevertVerified &&
    policy.autoMergeVerifiedReverts &&
    out.list.every((r) => r.lane === 0 || waivable.has(r.code));
  let reasons: InternalReason[] = out.list;
  if (revertAutoMerge) {
    reasons = reasons.map((r) =>
      r.lane === 0
        ? r
        : {
            ...makeReason("revert.waived", { code: r.code, reason: r.message }, r.evidenceRef),
            gates: r.gates,
          },
    );
    reasons.push(makeReason("revert.auto-merge"));
  }

  const computedLane = maxLane(reasons);
  let lane: Lane = computedLane;
  let shadow = false;
  if (computedLane === 0 && !policy.lane0Enabled && !revertAutoMerge) {
    lane = 1;
    shadow = true;
    reasons.push(makeReason("shadow.lane0-disabled"));
  }

  const sorted = [...reasons].sort(compareReasons);
  return {
    lane,
    computedLane,
    reasons: sorted.map((r): LaneReason => {
      const reason: LaneReason = { code: r.code, lane: r.lane, message: r.message };
      if (r.evidenceRef !== undefined) reason.evidenceRef = r.evidenceRef;
      return reason;
    }),
    shadow,
    blocked: context.ciStatus === "failed" || (evidence !== null && !context.evidenceVerified),
    requiresHumanApproval: diffStats === null || paths.some((p) => isPlatformFile(p)),
    checklist: buildChecklist(sorted, policy, revertAutoMerge),
  };
}
