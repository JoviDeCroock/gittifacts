/**
 * Rollout health: a pure decision over telemetry samples. Table-driven tests live in
 * test/unit/health.test.ts.
 *
 * Regression (architecture.md, Rollout §3):
 * - more than `maxNewIssueGroups` new Workers Issues groups attributed to the version, or
 * - error rate increase over the baseline > `maxErrorRateIncrease`, once the version has served
 *   at least `minRequests` requests.
 * Unknown → escalate: an unknown error rate with enough requests is a regression, and so is
 * telemetry that stays unavailable for `UNAVAILABLE_LIMIT` consecutive checks. Too little traffic
 * is "insufficient-data", which never fails a stage on its own.
 */
import type { RolloutPolicy } from "@app/domain";

export type HealthSample =
  | {
      ok: true;
      at: string;
      requests: number;
      errorRate: number | null;
      baselineErrorRate: number | null;
      newIssueGroups: number;
    }
  | { ok: false; at: string; error: string };

export type HealthStatus = "healthy" | "insufficient-data" | "regression";

export interface HealthVerdict {
  status: HealthStatus;
  reasons: string[];
}

/** Consecutive failed telemetry checks that count as a regression. */
export const UNAVAILABLE_LIMIT = 3;

const EPSILON = 1e-9;

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

export function evaluateHealth(
  policy: Pick<RolloutPolicy, "maxErrorRateIncrease" | "maxNewIssueGroups" | "minRequests">,
  samples: readonly HealthSample[],
): HealthVerdict {
  if (samples.length === 0) return { status: "insufficient-data", reasons: ["no telemetry yet"] };

  let failures = 0;
  for (let i = samples.length - 1; i >= 0 && samples[i]?.ok === false; i--) failures++;
  if (failures >= UNAVAILABLE_LIMIT) {
    const last = samples[samples.length - 1];
    const detail = last && !last.ok ? `: ${last.error}` : "";
    return {
      status: "regression",
      reasons: [`telemetry unavailable for ${failures} consecutive checks${detail}`],
    };
  }

  const okSamples = samples.filter((s): s is Extract<HealthSample, { ok: true }> => s.ok);
  const latest = okSamples[okSamples.length - 1];
  if (latest === undefined) {
    return { status: "insufficient-data", reasons: [`telemetry unavailable (${failures} failed checks)`] };
  }
  const notes = failures > 0 ? [`latest ${failures} check(s) failed; judging the last good sample`] : [];

  if (latest.newIssueGroups > policy.maxNewIssueGroups) {
    return {
      status: "regression",
      reasons: [
        `${latest.newIssueGroups} new Workers Issues group(s) attributed to the version (max ${policy.maxNewIssueGroups})`,
      ],
    };
  }

  if (latest.requests < policy.minRequests) {
    return {
      status: "insufficient-data",
      reasons: [...notes, `${latest.requests} request(s) so far; error rates are trusted from ${policy.minRequests}`],
    };
  }

  if (latest.errorRate === null) {
    return {
      status: "regression",
      reasons: [`error rate unknown after ${latest.requests} requests (unknown → escalate)`],
    };
  }

  // The previous version may get no traffic at 100%: fall back to the last known baseline, and to
  // 0 when there never was one (conservative: any error rate then counts as an increase).
  let baseline = latest.baselineErrorRate;
  for (let i = okSamples.length - 2; baseline === null && i >= 0; i--) {
    baseline = okSamples[i]?.baselineErrorRate ?? null;
  }
  const baselineKnown = baseline !== null;
  const base = baseline ?? 0;
  const increase = latest.errorRate - base;
  if (increase - policy.maxErrorRateIncrease > EPSILON) {
    return {
      status: "regression",
      reasons: [
        `error rate ${pct(latest.errorRate)} vs ${baselineKnown ? "baseline" : "assumed baseline"} ${pct(base)}: +${pct(increase)} > ${pct(policy.maxErrorRateIncrease)}`,
      ],
    };
  }
  return {
    status: "healthy",
    reasons: [
      ...notes,
      `error rate ${pct(latest.errorRate)} vs ${baselineKnown ? "baseline" : "assumed baseline"} ${pct(base)} over ${latest.requests} requests`,
    ],
  };
}
