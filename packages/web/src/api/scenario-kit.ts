/**
 * Builders that turn compact scenario descriptions into full API-shaped records.
 */
import type { Change, ClaimedCategory, Evidence, Lane, LaneReason, RolloutState, Tour, TourStop } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { fileStats, hunkFromText } from "../lib/diff.js";
import { NOW, PLATFORM_KEY_ID, ago, b64u, passedRun, sha } from "./fixture-kit.js";
import type { ChangeDiff, DiffFile, DiffFileStatus, DiffHunk, EvidenceVerification, LinkedIssue, PipelineRun, TimelineEvent } from "./types.js";

export interface Scenario {
  change: Change;
  diff: ChangeDiff;
  tour: Tour | null;
  evidence: Evidence | null;
  verification: EvidenceVerification;
  runs: PipelineRun[];
  issues: LinkedIssue[];
  /** A rollout timeline to the millisecond (with summaries); else the audit fixtures' events. */
  timeline?: TimelineEvent[];
}

export function hunk(oldStart: number, newStart: number, body: string): DiffHunk {
  return hunkFromText(oldStart, newStart, body);
}

export function file(
  path: string,
  status: DiffFileStatus,
  hunks: DiffHunk[],
  opts: { previousPath?: string; transformVerified?: boolean } = {},
): DiffFile {
  return {
    path,
    previousPath: opts.previousPath ?? null,
    status,
    ...fileStats(hunks),
    binary: false,
    transformVerified: opts.transformVerified ?? false,
    hunks,
    truncated: false,
  };
}

export const REVIEWER_ID = "prn_reviewer";

export interface ScenarioInput {
  id: string;
  repoId: string;
  planId: string | null;
  title: string;
  category: ClaimedCategory;
  summary?: string;
  authorId: string;
  status: Change["status"];
  computedLane: Lane | null;
  lane: Lane | null;
  reasons: LaneReason[];
  files: DiffFile[];
  createdMin: number;
  updatedMin: number;
  flagKey?: string | null;
  merged?: boolean;
  rolloutState?: RolloutState | null;
  revertOf?: string | null;
  revertedBy?: string | null;
  agentTrace?: boolean;
  /** Tour stops, least-confident and not-done lists. Omit when no tour exists yet. */
  tour?: { stops: TourStop[]; leastConfident: string[]; notDone: string[]; attempts?: number; costUsd?: number };
  items?: EvidenceItem[];
  verification?: EvidenceVerification;
  runs?: PipelineRun[];
  issues?: LinkedIssue[];
  noHead?: boolean;
  /** GitHub mode: the pull request this change grades. */
  host?: Change["host"];
}

export function scenario(s: ScenarioInput): Scenario {
  const baseSha = sha(`${s.id}:base`);
  const headSha = s.noHead ? null : sha(`${s.id}:head`);
  const evidenceId = s.items ? `ev_${s.id.slice(4)}` : null;
  const tourId = s.tour ? `tour_${s.id.slice(4)}` : null;
  const change: Change = {
    id: s.id,
    repoId: s.repoId,
    planId: s.planId,
    title: s.title,
    claim: { category: s.category, summary: s.summary ?? null },
    baseSha,
    headSha,
    forkName: `${s.id.slice(4)}-fork`,
    authorId: s.authorId,
    status: s.status,
    computedLane: s.computedLane,
    lane: s.lane,
    laneReasons: s.reasons,
    evidenceId,
    tourId,
    flagKey: s.flagKey ?? null,
    mergedSha: s.merged ? sha(`${s.id}:merged`) : null,
    rolloutState: s.rolloutState ?? null,
    revertOf: s.revertOf ?? null,
    revertedBy: s.revertedBy ?? null,
    agentTraceId: s.agentTrace === false ? null : `trace_${s.id.slice(4)}`,
    ...(s.host ? { host: s.host } : {}),
    createdAt: ago(s.createdMin),
    updatedAt: ago(s.updatedMin),
  };

  const head = headSha ?? baseSha;
  const tour: Tour | null =
    s.tour && tourId
      ? {
          id: tourId,
          changeId: s.id,
          headSha: head,
          stops: s.tour.stops,
          leastConfident: s.tour.leastConfident,
          notDone: s.tour.notDone,
          generatedBy: {
            principalId: REVIEWER_ID,
            model: "reviewer-large-2026-08",
            promptVersion: "tour/v7",
            attempts: s.tour.attempts ?? 1,
            costUsd: s.tour.costUsd ?? 0.07,
          },
          createdAt: ago(Math.max(0, s.updatedMin + 1)),
        }
      : null;

  const evidence: Evidence | null =
    s.items && evidenceId
      ? {
          id: evidenceId,
          changeId: s.id,
          headSha: head,
          baseSha,
          items: s.items,
          createdAt: ago(s.updatedMin + 2),
          notesWritten: true,
          attestation: {
            v: 1,
            alg: "Ed25519",
            keyId: PLATFORM_KEY_ID,
            payloadDigest: b64u(`${s.id}:digest`, 43),
            signature: b64u(`${s.id}:sig`, 86),
            signedAt: ago(s.updatedMin + 2),
            signer: "gittifacts-platform",
          },
        }
      : null;

  return {
    change,
    diff: {
      baseSha,
      headSha: head,
      files: s.files,
      additions: s.files.reduce((n, f) => n + f.additions, 0),
      deletions: s.files.reduce((n, f) => n + f.deletions, 0),
    },
    tour,
    evidence,
    verification: s.verification ?? (evidence ? { ok: true, keyId: PLATFORM_KEY_ID } : { ok: false, reason: "No evidence yet." }),
    runs: s.runs ?? (headSha ? [passedRun(s.id, headSha, s.updatedMin + 3)] : []),
    issues: s.issues ?? [],
  };
}

export function stop(
  kind: TourStop["kind"],
  verdict: TourStop["verdict"],
  title: string,
  why: string,
  hunkRefs: { file: string; startLine: number; endLine: number; side?: "head" | "base" }[] = [],
  evidenceRefs: string[] = [],
): TourStop {
  return {
    kind,
    verdict,
    title,
    why,
    hunkRefs: hunkRefs.map((h) => ({ ...h, side: h.side ?? "head" })),
    evidenceRefs,
  };
}

export function reason(code: string, lane: Lane, message: string, evidenceRef?: string): LaneReason {
  return evidenceRef ? { code, lane, message, evidenceRef } : { code, lane, message };
}

// ---------------------------------------------------------------- evidence item builders

type Outcome = "pass" | "fail" | "error" | "missing";

export function redGreen(
  changeId: string,
  tests: { file: string; name: string }[],
  verdict: "proven" | "not-proven" | "no-tests",
  base: Outcome[] = tests.map(() => "fail"),
  head: Outcome[] = tests.map(() => "pass"),
): EvidenceItem {
  const refs = tests.map((t, i) => ({ id: `t${i + 1}`, file: t.file, name: t.name }));
  return {
    id: "red-green",
    kind: "red-green",
    status: "ok",
    tests: refs,
    base: { sha: sha(`${changeId}:base`), results: refs.map((t, i) => ({ id: t.id, outcome: base[i] ?? "missing" })) },
    head: { sha: sha(`${changeId}:head`), results: refs.map((t, i) => ({ id: t.id, outcome: head[i] ?? "missing" })) },
    verdict,
    ...(verdict === "no-tests" ? { note: "The change adds or edits no test files." } : {}),
  };
}

export function testRun(changeId: string, passed: number, failures: { name: string; message: string }[] = [], skipped = 3): EvidenceItem {
  return {
    id: "test-run:unit",
    kind: "test-run",
    status: "ok",
    sha: sha(`${changeId}:head`),
    step: "unit tests",
    runner: "vitest 4.1",
    passed,
    failed: failures.length,
    skipped,
    durationMs: 21_800,
    failures,
  };
}

export function coverage(changed: number, covered: number, files: { path: string; changed: number; covered: number; uncoveredLines: number[] }[]): EvidenceItem {
  return {
    id: "coverage",
    kind: "coverage",
    status: "ok",
    changedLines: changed,
    coveredChangedLines: covered,
    ratio: changed === 0 ? 1 : covered / changed,
    files,
  };
}

export function apiNone(): EvidenceItem {
  return { id: "public-api", kind: "public-api", status: "ok", classification: "none", packages: [] };
}

export function depsNone(): EvidenceItem {
  return { id: "dependencies", kind: "dependencies", status: "ok", added: [], removed: [], changed: [], newInstallScripts: [], lockfileChanged: false };
}

export const DEFAULT_SENSITIVE = ["**/auth/**", "**/payments/**", "**/billing/**", "**/migrations/**", "**/*.sql", ".platform/**", ".github/workflows/**", "**/wrangler.jsonc"];

export function sensitive(hits: { path: string; pattern: string }[]): EvidenceItem {
  return { id: "sensitive-paths", kind: "sensitive-paths", status: "ok", patterns: DEFAULT_SENSITIVE, hits };
}

export function preview(changeId: string, repo: string): EvidenceItem {
  return {
    id: "preview",
    kind: "preview",
    status: "ok",
    url: `https://${changeId.slice(4)}.${repo}.preview.gittifacts.dev`,
    versionId: `v-${sha(`${changeId}:ver`).slice(0, 7)}`,
  };
}

export function trace(changeId: string): EvidenceItem {
  return {
    id: "agent-trace",
    kind: "agent-trace",
    status: "ok",
    provider: "Claude Agent SDK",
    traceId: `trace_${changeId.slice(4)}`,
    url: `https://traces.example.com/t/${changeId.slice(4)}`,
  };
}

export function judgment(
  question: "scope-drift" | "plan-conformance" | "hidden-behavior-change",
  outcome: "no-concern" | "concern" | "unsure",
  rationale: string,
): EvidenceItem {
  return { id: `llm-judgment:${question}`, kind: "llm-judgment", status: "ok", question, outcome, rationale, model: "judge-small-2026-07" };
}

export { NOW };
