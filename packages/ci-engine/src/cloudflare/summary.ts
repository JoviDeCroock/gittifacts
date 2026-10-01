/** Turning a replay into the same `StepStatus`/`RunSummary` shapes the Workflows engine reports. */
import type { EvidenceItem } from "@app/evidence";
import type { CiRunParams, EvidenceError, RunSummary, StepStatus } from "../engine.js";
import { parseEvidenceDocument } from "../runner/evidence.js";
import type { ReplayResult, ReplayStepResult } from "./replay.js";

export function replayStepStatus(r: ReplayStepResult): StepStatus {
  return {
    name: r.name,
    kind: r.kind,
    status: r.status,
    durationMs: r.durationMs,
    ...(r.durationMs === null
      ? {}
      : { computeMs: r.durationMs, timings: { totalMs: r.durationMs } }),
    // @cloudflare/ci keeps logs in its own step outputs, not in our bucket.
    logRef: null,
    cacheHit: false,
    exitCode: r.exitCode,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    ...(r.reason === null ? {} : { reason: r.reason.slice(0, 4000) }),
    ...(r.status === "failed" && r.output !== "" ? { tail: r.output.slice(-16 * 1024) } : {}),
  };
}

export function runningStepStatus(
  name: string,
  kind: "user" | "evidence",
  startedAt: string,
): StepStatus {
  return {
    name,
    kind,
    status: "running",
    durationMs: null,
    logRef: null,
    cacheHit: false,
    exitCode: null,
    startedAt,
    finishedAt: null,
  };
}

export function buildReplaySummary(
  req: CiRunParams,
  startedAt: string,
  finishedAt: string,
  result: ReplayResult,
): RunSummary {
  const evidence: EvidenceItem[] = [];
  const evidenceErrors: EvidenceError[] = [];
  for (const r of result.steps.filter((s) => s.kind === "evidence")) {
    if (r.evidenceRaw === null) {
      const why =
        r.status === "passed"
          ? "no ::evidence:: line was printed"
          : `${r.status}${r.reason === null ? "" : `: ${r.reason}`}`;
      evidenceErrors.push({ step: r.name, message: why.slice(0, 4000) });
      continue;
    }
    const parsed = parseEvidenceDocument(r.evidenceRaw);
    if (parsed.ok) evidence.push(...parsed.items);
    else evidenceErrors.push({ step: r.name, message: parsed.error.slice(0, 4000) });
  }
  const userSteps = result.steps.filter((s) => s.kind === "user");
  // @cloudflare/ci does not report container time; step wall time is the closest upper-bound
  // proxy (it includes sandbox start, checkout and backup).
  const computeMs = result.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const ran = result.steps.filter((s) => s.durationMs !== null).length;
  const runStart = Date.parse(startedAt);
  const starts = userSteps
    .map((s) => (s.startedAt === null ? Number.NaN : Date.parse(s.startedAt)))
    .filter((t) => !Number.isNaN(t));
  return {
    id: req.runId,
    changeId: req.changeId,
    headSha: req.headSha,
    baseSha: req.baseSha,
    engine: "cloudflare-ci",
    status: userSteps.every((s) => s.status === "passed") ? "passed" : "failed",
    startedAt,
    finishedAt,
    steps: result.steps.map(replayStepStatus),
    pipelineSource: "request",
    warnings: req.pipeline?.warnings ?? [],
    evidence,
    evidenceErrors,
    usage: {
      computeMs,
      ciMinutes: Math.ceil(computeMs / 600) / 100,
      byInstance: { sandbox: computeMs },
      containers: ran,
      cacheHits: 0,
      logBytes: 0,
    },
    timings: {
      totalMs: Math.max(0, Date.parse(finishedAt) - runStart),
      ...(starts.length === 0 ? {} : { firstStepMs: Math.max(0, Math.min(...starts) - runStart) }),
    },
  };
}
