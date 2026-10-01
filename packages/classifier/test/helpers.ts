/**
 * Builders for classifier inputs. `green()` is a fully green Lane-0 input; tests mutate exactly
 * one thing and look at the result. Every evidence item is validated against the evidence schema
 * so hand-built evidence cannot drift from the real contract.
 */
import {
  type ClaimedCategory,
  type DiffStats,
  type FileDiffStat,
  Plan,
  RepoPolicy,
  type RepoPolicyInput,
} from "@app/domain";
import {
  type AgentTrace,
  type ConflictResolution,
  type CoverageDelta,
  type DependencyDiff,
  EvidenceItem,
  type EvidenceKind,
  type LlmJudgment,
  type MutationScore,
  type PreviewDeploy,
  type PublicApiDiff,
  type Quarantine,
  type RedGreenProof,
  type ReproducibleTransform,
  type Screenshots,
  type SensitivePathHits,
  type TestRun,
} from "@app/evidence";
import {
  type ClassifyContext,
  type ClassifyResult,
  classify,
  type Gate,
  type ReasonCode,
} from "../src/index.js";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
export const AUTHOR = "agent-author";
export const APPROVER = "human-approver";

export interface ClassifyInput {
  evidence: { items: EvidenceItem[] } | null;
  policy: RepoPolicy;
  plan: Plan | null;
  diffStats: DiffStats | null;
  change: { category: ClaimedCategory };
  context: ClassifyContext;
}

// ---------------------------------------------------------------- immutability

/** Recursively freeze a value (tests run in strict mode, so any write throws). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Classify a deep-frozen input. The classifier must never mutate what it is given. */
export function run(input: ClassifyInput): ClassifyResult {
  const frozen = deepFreeze(input);
  return classify(
    frozen.evidence,
    frozen.policy,
    frozen.plan,
    frozen.diffStats,
    frozen.change,
    frozen.context,
  );
}

/** Copy-on-write edit: returns a modified deep clone, leaving `input` untouched. */
export function mutate(input: ClassifyInput, edit: (draft: ClassifyInput) => void): ClassifyInput {
  const draft = structuredClone(input);
  edit(draft);
  return draft;
}

// ---------------------------------------------------------------- policy, plan, diff

export function policy(overrides: RepoPolicyInput = {}): RepoPolicy {
  return RepoPolicy.parse({ lane0Enabled: true, ...overrides });
}

export function plan(overrides: Partial<Plan> = {}): Plan {
  return Plan.parse({
    id: "plan-1",
    repoId: "repo-1",
    title: "Fix slug generation for unicode titles",
    intent: "Titles with accented characters produce empty slugs; normalise before slugging.",
    acceptanceCriteria: ["slugify('Café') returns 'cafe'"],
    outOfScope: ["Do not change the public API", "src/legacy/**"],
    riskDeclarations: [],
    scopePaths: ["src/**", "test/**"],
    affectedRoutes: [],
    status: "approved",
    authorId: AUTHOR,
    approvedBy: APPROVER,
    approvedAt: "2026-10-01T10:00:00.000Z",
    approvalSignature: "c2lnbmF0dXJl",
    supersedes: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  });
}

export function file(
  path: string,
  additions: number,
  deletions: number,
  overrides: Partial<FileDiffStat> = {},
): FileDiffStat {
  return {
    path,
    previousPath: null,
    status: "modified",
    additions,
    deletions,
    binary: false,
    ...overrides,
  };
}

export function diff(files: FileDiffStat[]): DiffStats {
  return {
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** Replace the diff's files (totals are recomputed). */
export function withFiles(input: ClassifyInput, files: FileDiffStat[]): ClassifyInput {
  return mutate(input, (d) => {
    d.diffStats = diff(files);
  });
}

/** Add files to the diff (totals are recomputed). */
export function addFiles(input: ClassifyInput, ...files: FileDiffStat[]): ClassifyInput {
  return withFiles(input, [...(input.diffStats?.files ?? []), ...files]);
}

// ---------------------------------------------------------------- evidence items

function item<T extends EvidenceItem>(value: T): T {
  return EvidenceItem.parse(value) as T;
}

export function testRun(overrides: Partial<TestRun> = {}): TestRun {
  return item<TestRun>({
    id: "test-run:unit",
    status: "ok",
    kind: "test-run",
    sha: HEAD_SHA,
    step: "unit",
    runner: "vitest",
    passed: 42,
    failed: 0,
    skipped: 0,
    durationMs: 1234,
    failures: [],
    ...overrides,
  });
}

export function redGreen(
  verdict: RedGreenProof["verdict"] = "proven",
  overrides: Partial<RedGreenProof> = {},
): RedGreenProof {
  const tests =
    verdict === "no-tests" ? [] : [{ id: "t1", file: "test/slugify.test.ts", name: "unicode" }];
  return item<RedGreenProof>({
    id: "red-green",
    status: "ok",
    kind: "red-green",
    tests,
    base: { sha: BASE_SHA, results: tests.map((t) => ({ id: t.id, outcome: "fail" as const })) },
    head: {
      sha: HEAD_SHA,
      results: tests.map((t) => ({
        id: t.id,
        outcome: verdict === "proven" ? ("pass" as const) : ("fail" as const),
      })),
    },
    verdict,
    ...overrides,
  });
}

export function coverage(ratio = 0.95, overrides: Partial<CoverageDelta> = {}): CoverageDelta {
  const changedLines = 20;
  return item<CoverageDelta>({
    id: "coverage",
    status: "ok",
    kind: "coverage",
    changedLines,
    coveredChangedLines: Math.round(ratio * changedLines),
    ratio,
    files: [],
    ...overrides,
  });
}

export function mutation(score = 0.85, overrides: Partial<MutationScore> = {}): MutationScore {
  const total = 20;
  const killed = Math.round(score * total);
  return item<MutationScore>({
    id: "mutation",
    status: "ok",
    kind: "mutation",
    tool: "stryker",
    files: ["src/slugify.ts"],
    killed,
    survived: total - killed,
    timedOut: 0,
    noCoverage: 0,
    score,
    survivors: [],
    ...overrides,
  });
}

export function publicApi(
  classification: PublicApiDiff["classification"] = "none",
  overrides: Partial<PublicApiDiff> = {},
): PublicApiDiff {
  const packages =
    classification === "none"
      ? []
      : [
          {
            name: "slugs",
            entry: "src/index.ts",
            added:
              classification === "additive"
                ? [{ symbol: "slugifyAll", after: "(xs: string[]) => string[]" }]
                : [],
            removed:
              classification === "breaking"
                ? [{ symbol: "slugify", before: "(s: string) => string" }]
                : [],
            changed: [],
          },
        ];
  return item<PublicApiDiff>({
    id: "public-api",
    status: "ok",
    kind: "public-api",
    classification,
    packages,
    ...overrides,
  });
}

export function dependencies(overrides: Partial<DependencyDiff> = {}): DependencyDiff {
  return item<DependencyDiff>({
    id: "dependencies",
    status: "ok",
    kind: "dependencies",
    added: [],
    removed: [],
    changed: [],
    newInstallScripts: [],
    lockfileChanged: false,
    ...overrides,
  });
}

export function bump(
  name: string,
  kind: DependencyDiff["changed"][number]["bump"],
  manifest = "package.json",
): DependencyDiff["changed"][number] {
  const to = {
    major: "2.0.0",
    minor: "1.3.0",
    patch: "1.2.4",
    prerelease: "1.3.0-beta.1",
    other: "github:x/y",
  }[kind];
  return { name, from: "1.2.3", to, bump: kind, dev: false, manifest };
}

export function sensitivePaths(
  hits: SensitivePathHits["hits"] = [],
  overrides: Partial<SensitivePathHits> = {},
): SensitivePathHits {
  return item<SensitivePathHits>({
    id: "sensitive-paths",
    status: "ok",
    kind: "sensitive-paths",
    patterns: policy().sensitivePaths,
    hits,
    ...overrides,
  });
}

export function preview(overrides: Partial<PreviewDeploy> = {}): PreviewDeploy {
  return item<PreviewDeploy>({
    id: "preview",
    status: "ok",
    kind: "preview",
    url: "https://preview.example.com",
    versionId: "v1",
    ...overrides,
  });
}

export function screenshots(overrides: Partial<Screenshots> = {}): Screenshots {
  return item<Screenshots>({
    id: "screenshots:/",
    status: "ok",
    kind: "screenshots",
    shots: [
      { route: "/", viewport: "mobile", beforeRef: "r2://b", afterRef: "r2://a", diffRatio: 0 },
    ],
    ...overrides,
  });
}

export function agentTrace(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return item<AgentTrace>({
    id: "agent-trace",
    status: "ok",
    kind: "agent-trace",
    provider: "claude-code",
    traceId: "trace-1",
    ...overrides,
  });
}

export function transform(
  files: string[],
  overrides: Partial<ReproducibleTransform> = {},
): ReproducibleTransform {
  return item<ReproducibleTransform>({
    id: "transform:rename",
    status: "ok",
    kind: "transform",
    transform: "rename-symbol",
    command: "node .platform/transforms/rename-symbol.ts getUser fetchUser",
    verified: true,
    files,
    mismatchedFiles: [],
    ...overrides,
  });
}

export function llm(
  outcome: LlmJudgment["outcome"],
  overrides: Partial<LlmJudgment> = {},
): LlmJudgment {
  return item<LlmJudgment>({
    id: `llm:${overrides.question ?? "scope-drift"}:${outcome}`,
    status: "ok",
    kind: "llm-judgment",
    question: "scope-drift",
    outcome,
    rationale: `The model says ${outcome}.`,
    model: "reviewer-model",
    ...overrides,
  });
}

/** A merge-queue conflict resolution that stayed inside its conflict hunks. */
export function resolution(overrides: Partial<ConflictResolution> = {}): ConflictResolution {
  return item<ConflictResolution>({
    id: "conflict-resolution",
    status: "ok",
    kind: "conflict-resolution",
    upstreamChanges: [{ changeId: "chg_upstream", sha: "c".repeat(40), planId: "plan-up" }],
    conflictHunks: [{ file: "src/slugify.ts", startLine: 3, endLine: 5 }],
    resolutionDiff:
      "diff --git a/src/slugify.ts b/src/slugify.ts\n--- a/src/slugify.ts\n+++ b/src/slugify.ts\n@@ -3,7 +3,2 @@\n",
    truncated: false,
    touchesOutsideConflictHunks: false,
    novelLines: 0,
    semanticConflictWith: null,
    rationale: "Kept both sides' list entries.",
    resolver: {
      model: "anthropic/claude-sonnet-5",
      principalId: "system:resolver",
      promptVersion: "resolver-test",
    },
    attempts: 1,
    ...overrides,
  });
}

/** Quarantined tests; by default one of them is in the Change's affected set. */
export function quarantine(overrides: Partial<Quarantine> = {}): Quarantine {
  return item<Quarantine>({
    id: "quarantine",
    status: "ok",
    kind: "quarantine",
    tests: [
      {
        id: "test/slugify.test.ts > flaky clock",
        file: "test/slugify.test.ts",
        name: "flaky clock",
        flakeRate: 0.12,
        quarantinedAt: "2026-10-01T08:00:00.000Z",
      },
      {
        id: "test/other.test.ts > network",
        file: "test/other.test.ts",
        name: "network",
        flakeRate: 0.3,
        quarantinedAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    inAffectedSet: ["test/slugify.test.ts > flaky clock"],
    ...overrides,
  });
}

// ---------------------------------------------------------------- evidence editing

function items(input: ClassifyInput): EvidenceItem[] {
  return input.evidence?.items ?? [];
}

/** Append evidence items (creates a bundle if there was none). */
export function withItems(input: ClassifyInput, ...extra: EvidenceItem[]): ClassifyInput {
  return mutate(input, (d) => {
    d.evidence = { items: [...items(d), ...structuredClone(extra)] };
  });
}

/** Remove every item of a kind. */
export function withoutKind(input: ClassifyInput, kind: EvidenceKind): ClassifyInput {
  return mutate(input, (d) => {
    d.evidence = { items: items(d).filter((i) => i.kind !== kind) };
  });
}

/** Replace every item of a kind with the given items. */
export function replaceKind(
  input: ClassifyInput,
  kind: EvidenceKind,
  ...replacement: EvidenceItem[]
): ClassifyInput {
  return withItems(withoutKind(input, kind), ...replacement);
}

/** Set the status (and note) of every item of a kind. */
export function setStatus(
  input: ClassifyInput,
  kind: EvidenceKind,
  status: "ok" | "skipped" | "error",
  note = `${kind} ${status} in test`,
): ClassifyInput {
  return mutate(input, (d) => {
    for (const i of items(d)) {
      if (i.kind === kind) {
        i.status = status;
        i.note = note;
      }
    }
  });
}

// ---------------------------------------------------------------- the green baseline

export const GREEN_FILES: FileDiffStat[] = [
  file("src/slugify.ts", 6, 2),
  file("test/slugify.test.ts", 12, 0),
];

/** Every signal present and ok; informational signals present too. */
export function greenItems(): EvidenceItem[] {
  return [
    testRun(),
    redGreen("proven"),
    coverage(0.95),
    mutation(0.85),
    publicApi("none"),
    dependencies(),
    sensitivePaths(),
    preview(),
    screenshots(),
    agentTrace(),
  ];
}

export function greenContext(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    ciStatus: "passed",
    evidenceVerified: true,
    budgetExceeded: false,
    tourStatus: "not-generated",
    pureRevertVerified: false,
    ...overrides,
  };
}

/**
 * A fully green Lane-0 input: approved plan with scopePaths, claimed fix with a proven red-green,
 * all evidence ok, small diff, lane0Enabled: true.
 */
export function green(): ClassifyInput {
  return {
    evidence: { items: greenItems() },
    policy: policy(),
    plan: plan(),
    diffStats: diff(structuredClone(GREEN_FILES)),
    change: { category: "fix" },
    context: greenContext(),
  };
}

// ---------------------------------------------------------------- result helpers

export function codes(result: ClassifyResult): string[] {
  return result.reasons.map((r) => r.code);
}

/** Codes of reasons that raise the lane (lane >= 1), excluding the shadow-mode reason. */
export function raisedCodes(result: ClassifyResult): string[] {
  return result.reasons
    .filter((r) => r.lane > 0 && r.code !== "shadow.lane0-disabled")
    .map((r) => r.code);
}

export function reasonFor(result: ClassifyResult, code: ReasonCode) {
  return result.reasons.find((r) => r.code === code);
}

export function gateOf(result: ClassifyResult, gate: Gate) {
  const entry = result.checklist.find((c) => c.gate === gate);
  if (!entry) throw new Error(`no checklist entry for ${gate}`);
  return entry;
}
