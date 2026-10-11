/**
 * Evidence item schemas.
 *
 * This package is standalone: it must not import anything from the rest of the
 * app. Every item carries a `status` so consumers (e.g. a risk classifier) can
 * tell "measured and fine" apart from "not measured" and "measurement failed".
 * Unknown is never the same as good.
 */
import { z } from "zod";

export const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "expected a full git object id");
export type Sha = z.infer<typeof Sha>;

/** ok = measured; skipped = deliberately not applicable; error = tried and failed. */
export const SignalStatus = z.enum(["ok", "skipped", "error"]);
export type SignalStatus = z.infer<typeof SignalStatus>;

const base = {
  /** Unique within a bundle, e.g. "red-green", "public-api", "screenshots:/settings". Tours cite these. */
  id: z.string().min(1).max(200),
  status: SignalStatus,
  /** Human-readable reason when status is "error" or "skipped". */
  note: z.string().max(4000).optional(),
  /** Opaque pointer to raw logs/artifacts (e.g. an R2 key). */
  logRef: z.string().max(500).optional(),
};

export const TestRef = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  name: z.string().min(1),
});
export type TestRef = z.infer<typeof TestRef>;

export const TestOutcome = z.enum(["pass", "fail", "error", "missing"]);
export type TestOutcome = z.infer<typeof TestOutcome>;

/**
 * Which tests a measurement ran. `all`: the whole suite (also whenever the Change's test impact
 * is unknown: unknown escalates). `affected`: only the test files whose import closure reaches
 * the Change (`@app/affected` test targets); `files` counts them, `tests` lists some.
 */
export const TestSelection = z.object({
  mode: z.enum(["all", "affected"]),
  reason: z.string().max(1000),
  files: z.number().int().nonnegative().optional(),
  tests: z.array(z.string()).max(200).optional(),
});
export type TestSelection = z.infer<typeof TestSelection>;

/**
 * Where the base-commit results a measurement compared against came from. `ok`: results for the
 * tests in question exist (`cache`: an earlier run on the same base commit; `run`: measured now).
 * `unavailable`: no baseline could be had, so nothing counts as pre-existing.
 */
export const BaselineInfo = z.object({
  sha: Sha,
  status: z.enum(["ok", "unavailable"]),
  source: z.enum(["cache", "run", "mixed"]).optional(),
  note: z.string().max(1000).optional(),
});
export type BaselineInfo = z.infer<typeof BaselineInfo>;

export const RedGreenProof = z.object({
  ...base,
  kind: z.literal("red-green"),
  tests: z.array(TestRef),
  base: z.object({
    sha: Sha,
    results: z.array(z.object({ id: z.string(), outcome: TestOutcome })),
  }),
  head: z.object({
    sha: Sha,
    results: z.array(z.object({ id: z.string(), outcome: TestOutcome })),
  }),
  /**
   * `tests`: the change's new/changed tests, plus pre-existing tests that fail on base (as
   * committed) and pass, or fail differently, on head (identical failures: `preExisting`).
   * proven: >=1 listed test fails (or is missing) on base and every one passes on head.
   * not-proven: tests are listed but the fail-then-pass pattern does not hold.
   * no-tests: nothing is listed (no new or changed test, and no test fails on base).
   */
  verdict: z.enum(["proven", "not-proven", "no-tests"]),
  /**
   * Pre-existing failures: tests (not new or changed by the Change) that fail on base and fail
   * identically on head (same first line of the failure). Not listed in `tests`, so an
   * unrelated failure on the default branch neither proves nor blocks the proof.
   */
  preExisting: z
    .array(TestRef.extend({ message: z.string().max(500).optional() }))
    .max(200)
    .optional(),
  selection: TestSelection.optional(),
});
export type RedGreenProof = z.infer<typeof RedGreenProof>;

export const TestRun = z.object({
  ...base,
  kind: z.literal("test-run"),
  sha: Sha,
  step: z.string(),
  runner: z.string(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  failures: z.array(z.object({ name: z.string(), message: z.string().max(4000) })).max(200),
  /**
   * Names (from `failures`) that fail identically on the base commit (`baseline`): pre-existing,
   * so they do not count against the Change. `failed` still counts every failure.
   */
  preExisting: z.array(z.string()).max(200).optional(),
  baseline: BaselineInfo.optional(),
  selection: TestSelection.optional(),
});
export type TestRun = z.infer<typeof TestRun>;

/**
 * Failures of a test run that count against the Change: all of them, minus the ones proven
 * pre-existing against a usable baseline of `baseSha` (when given, the baseline must be of that
 * commit). Unknown baseline → every failure counts.
 */
export function newFailureCount(run: TestRun, baseSha?: string): number {
  const b = run.baseline;
  if (b === undefined || b.status !== "ok" || (baseSha !== undefined && b.sha !== baseSha))
    return run.failed;
  const listed = new Set(run.failures.map((f) => f.name));
  const pre = new Set((run.preExisting ?? []).filter((n) => listed.has(n)));
  return Math.max(0, run.failed - pre.size);
}

export const CoverageDelta = z.object({
  ...base,
  kind: z.literal("coverage"),
  changedLines: z.number().int().nonnegative(),
  coveredChangedLines: z.number().int().nonnegative(),
  /** coveredChangedLines / changedLines; 1 when no executable lines changed. */
  ratio: z.number().min(0).max(1),
  files: z.array(
    z.object({
      path: z.string(),
      changed: z.number().int().nonnegative(),
      covered: z.number().int().nonnegative(),
      uncoveredLines: z.array(z.number().int().positive()).max(2000),
    }),
  ),
  /**
   * Changed files with no entry at all in the coverage report. Per the contract their
   * lines count as non-executable, so they do not affect `ratio` — but a source file
   * missing from the report usually means "never loaded by any test". Listed so a
   * consumer can escalate instead of reading silence as safety.
   */
  unmeasuredFiles: z.array(z.string()).max(2000).optional(),
  selection: TestSelection.optional(),
});
export type CoverageDelta = z.infer<typeof CoverageDelta>;

export const MutationScore = z.object({
  ...base,
  kind: z.literal("mutation"),
  tool: z.string(),
  files: z.array(z.string()),
  killed: z.number().int().nonnegative(),
  survived: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  noCoverage: z.number().int().nonnegative(),
  /** killed+timedOut over all valid mutants on changed lines, 0..1. */
  score: z.number().min(0).max(1),
  survivors: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive(),
        mutator: z.string(),
        replacement: z.string().max(500).optional(),
        /** Survived = tests ran and passed; NoCoverage = no test exercised the mutant. */
        status: z.enum(["Survived", "NoCoverage"]).optional(),
      }),
    )
    .max(500),
});
export type MutationScore = z.infer<typeof MutationScore>;

export const ApiChange = z.object({
  symbol: z.string(),
  before: z.string().max(4000).optional(),
  after: z.string().max(4000).optional(),
});
export type ApiChange = z.infer<typeof ApiChange>;

export const ApiClassification = z.enum(["none", "additive", "breaking"]);
export type ApiClassification = z.infer<typeof ApiClassification>;

export const PublicApiDiff = z.object({
  ...base,
  kind: z.literal("public-api"),
  classification: ApiClassification,
  packages: z.array(
    z.object({
      name: z.string(),
      entry: z.string(),
      added: z.array(ApiChange),
      removed: z.array(ApiChange),
      changed: z.array(ApiChange),
    }),
  ),
});
export type PublicApiDiff = z.infer<typeof PublicApiDiff>;

export const SemverBump = z.enum(["major", "minor", "patch", "prerelease", "other"]);
export type SemverBump = z.infer<typeof SemverBump>;

export const DependencySection = z.enum([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
export type DependencySection = z.infer<typeof DependencySection>;

export const DependencyDiff = z.object({
  ...base,
  kind: z.literal("dependencies"),
  added: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      dev: z.boolean(),
      manifest: z.string(),
      section: DependencySection.optional(),
    }),
  ),
  removed: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      dev: z.boolean(),
      manifest: z.string(),
      section: DependencySection.optional(),
    }),
  ),
  changed: z.array(
    z.object({
      name: z.string(),
      from: z.string(),
      to: z.string(),
      bump: SemverBump,
      dev: z.boolean(),
      manifest: z.string(),
      section: DependencySection.optional(),
    }),
  ),
  /**
   * Lifecycle scripts (preinstall/install/postinstall/prepare) that appear in head but not
   * base, or whose command changed. `name` is the package name (or the manifest path when
   * the manifest has no name).
   */
  newInstallScripts: z.array(
    z.object({
      name: z.string(),
      script: z.string(),
      command: z.string(),
      manifest: z.string().optional(),
    }),
  ),
  lockfileChanged: z.boolean(),
  /**
   * The lockfile diff checked against the recorded bumps: `verified` when every changed entry is
   * a recorded patch bump re-resolved from the registry, with nothing added or removed. Absent:
   * the lockfiles were not read, so a lockfile change is unexplained (the classifier escalates).
   */
  lockfile: z
    .object({
      verified: z.boolean(),
      changes: z
        .array(
          z.object({
            lockfile: z.string().max(500),
            name: z.string().max(300),
            from: z.string().max(300),
            to: z.string().max(300),
          }),
        )
        .max(2000),
      problems: z.array(z.string().max(1000)).max(200),
    })
    .optional(),
});
export type DependencyDiff = z.infer<typeof DependencyDiff>;

export const SensitivePathHits = z.object({
  ...base,
  kind: z.literal("sensitive-paths"),
  patterns: z.array(z.string()),
  hits: z.array(z.object({ path: z.string(), pattern: z.string() })),
});
export type SensitivePathHits = z.infer<typeof SensitivePathHits>;

/**
 * Who produced a preview. Absent (older bundles) or `platform`: the platform's own preview
 * gateway. `integration`: an external deploy platform reported it (the platform still signs the
 * bundle; the item says whose deployment it is). A preview is informational: it never lowers a lane.
 */
export const PreviewSource = z.object({
  kind: z.enum(["platform", "integration"]),
  /** Integration id and display name (kind "integration"). */
  id: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200).optional(),
  /** The reported deployment this preview came from. */
  deploymentId: z.string().min(1).max(200).optional(),
  /** Where the deployment's build log lives, when the integration gave one. */
  logUrl: z.string().url().max(2048).optional(),
});
export type PreviewSource = z.infer<typeof PreviewSource>;

export const PreviewDeploy = z.object({
  ...base,
  kind: z.literal("preview"),
  url: z.string().url().optional(),
  versionId: z.string().optional(),
  source: PreviewSource.optional(),
});
export type PreviewDeploy = z.infer<typeof PreviewDeploy>;

export const Screenshots = z.object({
  ...base,
  kind: z.literal("screenshots"),
  shots: z.array(
    z.object({
      route: z.string(),
      viewport: z.enum(["mobile", "desktop"]),
      beforeRef: z.string().optional(),
      afterRef: z.string().optional(),
      /** Fraction of pixels that differ, 0..1, when computed. */
      diffRatio: z.number().min(0).max(1).optional(),
    }),
  ),
});
export type Screenshots = z.infer<typeof Screenshots>;

export const AgentTrace = z.object({
  ...base,
  kind: z.literal("agent-trace"),
  provider: z.string(),
  traceId: z.string(),
  url: z.string().url().optional(),
});
export type AgentTrace = z.infer<typeof AgentTrace>;

export const ReproducibleTransform = z.object({
  ...base,
  kind: z.literal("transform"),
  transform: z.string(),
  command: z.string(),
  /** True only when re-running on base in a clean sandbox reproduced every listed file byte-for-byte. */
  verified: z.boolean(),
  files: z.array(z.string()),
  mismatchedFiles: z.array(z.string()),
});
export type ReproducibleTransform = z.infer<typeof ReproducibleTransform>;

/**
 * A model-produced judgment. Consumers must only ever use these to RAISE risk,
 * never to lower it.
 */
export const LlmJudgment = z.object({
  ...base,
  kind: z.literal("llm-judgment"),
  question: z.enum(["scope-drift", "plan-conformance", "hidden-behavior-change"]),
  /** "concern" means the model found something worth a human's attention. */
  outcome: z.enum(["no-concern", "concern", "unsure"]),
  rationale: z.string().max(4000),
  model: z.string(),
});
export type LlmJudgment = z.infer<typeof LlmJudgment>;

/** Cap on `ConflictResolution.resolutionDiff`, in UTF-8 bytes. Longer diffs are cut at a line boundary. */
export const RESOLUTION_DIFF_MAX_BYTES = 64 * 1024;

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** An upstream Change (already accepted, now part of the new base) the resolution was made against. */
export const UpstreamChangeRef = z.object({
  changeId: z.string().min(1).max(200),
  sha: Sha,
  planId: z.string().min(1).max(200).optional(),
});
export type UpstreamChangeRef = z.infer<typeof UpstreamChangeRef>;

/** Where one conflict region ended up in the resolved file: 1-based, inclusive head-side lines. */
export const ConflictHunk = z
  .object({
    file: z.string().min(1).max(1000),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((h) => h.endLine >= h.startLine, { message: "endLine must be >= startLine" });
export type ConflictHunk = z.infer<typeof ConflictHunk>;

/**
 * A merge conflict resolved by the platform's resolver agent (never the Change's author) when the
 * Change no longer applied cleanly onto its new base (textual conflict), or failed together with
 * upstream Changes although each passed alone (semantic conflict, found by batch bisection).
 *
 * `conflictHunks` and `touchesOutsideConflictHunks` are computed mechanically from the merge with
 * conflict markers and the resolved files (`resolutionScope`), never taken from the model.
 * status "error" = the resolver ran and failed (the Change is ejected, not merged).
 * Consumers may only use this item to RAISE risk.
 */
export const ConflictResolution = z.object({
  ...base,
  kind: z.literal("conflict-resolution"),
  upstreamChanges: z.array(UpstreamChangeRef).max(200),
  /** The new base the Change was rebased onto, when known. */
  ontoSha: Sha.optional(),
  conflictHunks: z.array(ConflictHunk).max(2000),
  /** Head-side ranges edited outside any conflict region (what `touchesOutsideConflictHunks` found). */
  outsideHunks: z.array(ConflictHunk).max(2000).optional(),
  /**
   * Unified diff from the mechanical merge (conflicted files with their markers) to the resolved
   * tree. At most RESOLUTION_DIFF_MAX_BYTES UTF-8 bytes; `truncated` says it was cut.
   */
  resolutionDiff: z
    .string()
    .max(RESOLUTION_DIFF_MAX_BYTES)
    .refine((s) => utf8Length(s) <= RESOLUTION_DIFF_MAX_BYTES, {
      message: `resolutionDiff exceeds ${RESOLUTION_DIFF_MAX_BYTES} UTF-8 bytes`,
    }),
  truncated: z.boolean(),
  /** True when any edit is not explained by replacing conflict regions (or no regions exist). */
  touchesOutsideConflictHunks: z.boolean(),
  /** Resolved lines found verbatim on neither side of their conflict region (written by the resolver). */
  novelLines: z.number().int().nonnegative().optional(),
  /**
   * Lines of either side's change the resolution lost, reordered or undid (0 = every region is an
   * in-order merge of both sides). Absent on items from before 2026-10-11.
   */
  droppedLines: z.number().int().nonnegative().optional(),
  /** Semantic conflicts: the upstream changeId the resolver blamed; null for textual conflicts. */
  semanticConflictWith: z.string().min(1).max(200).nullable(),
  /** Semantic conflicts: the test ids that failed on the merged tree before the resolution. */
  failingTests: z.array(z.string().min(1).max(1000)).max(200).optional(),
  /** The resolver's own explanation (model text: may only raise risk). */
  rationale: z.string().max(4000),
  resolver: z.object({
    model: z.string().min(1).max(200),
    principalId: z.string().min(1).max(200),
    promptVersion: z.string().min(1).max(200),
  }),
  /** Model calls made (0 when the resolver refused before calling the model). */
  attempts: z.number().int().nonnegative(),
});
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const QuarantinedTest = TestRef.extend({
  /** Observed flake rate of the test target, 0..1. */
  flakeRate: z.number().min(0).max(1),
  quarantinedAt: z.string().datetime(),
  /** The Plan auto-opened to fix the test, if any. */
  planId: z.string().min(1).max(200).optional(),
});
export type QuarantinedTest = z.infer<typeof QuarantinedTest>;

/**
 * Tests the merge queue quarantined as suspected-flaky (failed on main's head too). A quarantined
 * test never silently counts as passing: every bundle whose test runs excluded or ignored
 * quarantined tests carries this item, and `inAffectedSet` names (by test id) the ones inside the
 * Change's affected set. An unknown affected set counts every quarantined test as affected.
 */
export const Quarantine = z.object({
  ...base,
  kind: z.literal("quarantine"),
  tests: z.array(QuarantinedTest).max(2000),
  inAffectedSet: z.array(z.string().min(1)).max(2000),
});
export type Quarantine = z.infer<typeof Quarantine>;

/** What a QA run's verdict on one acceptance criterion can be. "couldnt-test" is never a pass. */
export const QaVerdict = z.enum(["pass", "fail", "couldnt-test"]);
export type QaVerdict = z.infer<typeof QaVerdict>;

export const QA_ACTIONS = [
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "wait",
  "expect_text",
  "expect_no_text",
  "expect_visible",
  "expect_url",
  "expect_count",
] as const;
export const QaAction = z.enum(QA_ACTIONS);
export type QaAction = z.infer<typeof QaAction>;

export const QaStepResult = z.object({
  action: QaAction,
  target: z.string().max(500).optional(),
  value: z.string().max(500).optional(),
  ok: z.boolean(),
  /** Why it failed, or what was observed. */
  detail: z.string().max(1000).optional(),
  /** Name of the screenshot artifact taken after this step. */
  shot: z.string().max(200).optional(),
  /**
   * Expectations only: whether it traces to the criterion's own words (rule in @app/qa trace.ts).
   * An untraced expectation is run and reported as a note; it never decides the verdict.
   */
  traced: z.boolean().optional(),
});
export type QaStepResult = z.infer<typeof QaStepResult>;

export const QaCriterionResult = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(1000),
  /** "plan": an acceptance criterion; "smoke": synthesized when the Change has no Plan. */
  source: z.enum(["plan", "smoke"]),
  verdict: QaVerdict,
  reason: z.string().max(2000),
  /** Screenshot artifact taken before the first step. */
  before: z.string().max(200).optional(),
  steps: z.array(QaStepResult).max(30),
  consoleErrors: z.number().int().nonnegative(),
  networkErrors: z.number().int().nonnegative(),
  /** "Also observed": untraced expectations that did not hold (they never decide the verdict). */
  notes: z.array(z.string().max(500)).max(10).optional(),
});
export type QaCriterionResult = z.infer<typeof QaCriterionResult>;

export const QaArtifact = z.object({
  name: z.string().min(1).max(200),
  /** Opaque blob reference (an R2 key). */
  ref: z.string().min(1).max(500),
  /** Lowercase hex SHA-256 of the bytes: the signature covers the screenshots through this. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(100),
  role: z.enum(["before", "step", "thumb", "recording", "log"]),
});
export type QaArtifact = z.infer<typeof QaArtifact>;

/**
 * An on-request QA run: an agent drove the app built from the head in a real browser against the
 * Plan's acceptance criteria. Model-planned, but its verdicts only ever raise risk: a failed
 * criterion raises the lane, "couldnt-test" is unknown (never a pass), and an absent item means QA
 * was not requested (it lowers nothing and raises nothing).
 */
export const QaRun = z.object({
  ...base,
  kind: z.literal("qa-run"),
  runId: z.string().min(1).max(200),
  trigger: z.enum(["platform", "mcp", "cli", "github-check", "github-comment"]),
  requestedBy: z.string().min(1).max(200),
  app: z.object({
    source: z.literal("private-preview"),
    snapshotStep: z.enum(["build", "install"]),
    origin: z.string().url().max(300),
  }),
  model: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(100),
  criteria: z.array(QaCriterionResult).max(50),
  artifacts: z.array(QaArtifact).max(200),
  /** Origins other than the app's that the page tried to reach (blocked during QA). */
  blockedOrigins: z.array(z.string().max(300)).max(50),
  usage: z.object({
    wallMs: z.number().int().nonnegative(),
    browserMs: z.number().int().nonnegative(),
    llmCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    llmUsd: z.number().nonnegative(),
  }),
});
export type QaRun = z.infer<typeof QaRun>;

export const EvidenceItem = z.discriminatedUnion("kind", [
  RedGreenProof,
  TestRun,
  CoverageDelta,
  MutationScore,
  PublicApiDiff,
  DependencyDiff,
  SensitivePathHits,
  PreviewDeploy,
  Screenshots,
  AgentTrace,
  ReproducibleTransform,
  LlmJudgment,
  ConflictResolution,
  Quarantine,
  QaRun,
]);
export type EvidenceItem = z.infer<typeof EvidenceItem>;
export type EvidenceKind = EvidenceItem["kind"];

/** The exact object that gets signed. Field set is fixed: {changeId, headSha, items}. */
export const EvidencePayload = z.object({
  changeId: z.string().min(1),
  headSha: Sha,
  items: z.array(EvidenceItem),
});
export type EvidencePayload = z.infer<typeof EvidencePayload>;

export const Attestation = z.object({
  /**
   * 2: the signature covers the attestation header (`typ`, `v`, `alg`, `keyId`, `payloadDigest`,
   * `signedAt`, `signer`), so the signing time is signed. 1 (before 2026-10-11): it covers the
   * payload bytes only; `signedAt` and `signer` are unsigned claims. See attest.ts.
   */
  v: z.union([z.literal(1), z.literal(2)]),
  alg: z.literal("Ed25519"),
  /** base64url(SHA-256(raw public key)), first 16 bytes. */
  keyId: z.string(),
  /** base64url(SHA-256(canonical payload bytes)). */
  payloadDigest: z.string(),
  /** base64url Ed25519 signature: over the header (v2) or the canonical payload bytes (v1). */
  signature: z.string(),
  signedAt: z.string().datetime(),
  signer: z.string(),
});
export type Attestation = z.infer<typeof Attestation>;

export const SignedEvidence = EvidencePayload.extend({
  attestation: Attestation,
});
export type SignedEvidence = z.infer<typeof SignedEvidence>;

/**
 * Detached signature over an arbitrary JSON document (plan approvals, audit-log
 * entries). Signed bytes are canonical JSON of `{ document, purpose }`, so a
 * document signature can never be replayed as an evidence attestation (whose
 * signed object has the keys `{changeId, headSha, items}`) or across purposes.
 */
export const DocumentSignature = Attestation.extend({
  /** Domain-separation label, e.g. "plan-approval", "audit-log". */
  purpose: z.string().min(1).max(200),
});
export type DocumentSignature = z.infer<typeof DocumentSignature>;

/** On-disk format of a note under refs/notes/evidence. */
export const EVIDENCE_NOTES_REF = "refs/notes/evidence";
export const EVIDENCE_NOTE_FORMAT = "gittifacts.evidence/v1";
export const EvidenceNote = SignedEvidence.extend({
  format: z.literal(EVIDENCE_NOTE_FORMAT),
});
export type EvidenceNote = z.infer<typeof EvidenceNote>;
