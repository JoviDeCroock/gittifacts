/**
 * Evidence item schemas.
 *
 * This package is standalone: it must not import anything from the rest of the
 * app. Every item carries a `status` so consumers (e.g. a risk classifier) can
 * tell "measured and fine" apart from "not measured" and "measurement failed".
 * Unknown is never the same as good.
 */
import { z } from "zod";

export const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "expected a full git object id");
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

export const RedGreenProof = z.object({
  ...base,
  kind: z.literal("red-green"),
  tests: z.array(TestRef),
  base: z.object({ sha: Sha, results: z.array(z.object({ id: z.string(), outcome: TestOutcome })) }),
  head: z.object({ sha: Sha, results: z.array(z.object({ id: z.string(), outcome: TestOutcome })) }),
  /**
   * proven: >=1 new/changed test fails (or is missing) on base and every one passes on head.
   * not-proven: tests exist but the fail-then-pass pattern does not hold.
   * no-tests: the change has no new or changed tests.
   */
  verdict: z.enum(["proven", "not-proven", "no-tests"]),
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
});
export type TestRun = z.infer<typeof TestRun>;

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

export const DependencyDiff = z.object({
  ...base,
  kind: z.literal("dependencies"),
  added: z.array(z.object({ name: z.string(), version: z.string(), dev: z.boolean(), manifest: z.string() })),
  removed: z.array(z.object({ name: z.string(), version: z.string(), dev: z.boolean(), manifest: z.string() })),
  changed: z.array(
    z.object({
      name: z.string(),
      from: z.string(),
      to: z.string(),
      bump: SemverBump,
      dev: z.boolean(),
      manifest: z.string(),
    }),
  ),
  /** Lifecycle scripts (preinstall/install/postinstall/prepare) that appear in head but not base. */
  newInstallScripts: z.array(z.object({ name: z.string(), script: z.string(), command: z.string() })),
  lockfileChanged: z.boolean(),
});
export type DependencyDiff = z.infer<typeof DependencyDiff>;

export const SensitivePathHits = z.object({
  ...base,
  kind: z.literal("sensitive-paths"),
  patterns: z.array(z.string()),
  hits: z.array(z.object({ path: z.string(), pattern: z.string() })),
});
export type SensitivePathHits = z.infer<typeof SensitivePathHits>;

export const PreviewDeploy = z.object({
  ...base,
  kind: z.literal("preview"),
  url: z.string().url().optional(),
  versionId: z.string().optional(),
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
  v: z.literal(1),
  alg: z.literal("Ed25519"),
  /** base64url(SHA-256(raw public key)), first 16 bytes. */
  keyId: z.string(),
  /** base64url(SHA-256(canonical payload bytes)). */
  payloadDigest: z.string(),
  /** base64url Ed25519 signature over the canonical payload bytes. */
  signature: z.string(),
  signedAt: z.string().datetime(),
  signer: z.string(),
});
export type Attestation = z.infer<typeof Attestation>;

export const SignedEvidence = EvidencePayload.extend({
  attestation: Attestation,
});
export type SignedEvidence = z.infer<typeof SignedEvidence>;

/** On-disk format of a note under refs/notes/evidence. */
export const EVIDENCE_NOTES_REF = "refs/notes/evidence";
export const EVIDENCE_NOTE_FORMAT = "gittifacts.evidence/v1";
export const EvidenceNote = SignedEvidence.extend({
  format: z.literal(EVIDENCE_NOTE_FORMAT),
});
export type EvidenceNote = z.infer<typeof EvidenceNote>;
