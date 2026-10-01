import { RolloutPolicy } from "@app/domain";
import { describe, expect, it } from "vitest";
import { evaluateHealth, type HealthSample, type HealthStatus } from "../../src/health.js";

const policy = RolloutPolicy.parse({
  maxErrorRateIncrease: 0.01,
  maxNewIssueGroups: 0,
  minRequests: 50,
});

const ok = (s: Partial<Extract<HealthSample, { ok: true }>> = {}): HealthSample => ({
  ok: true,
  at: "2026-10-01T12:00:00.000Z",
  requests: 1000,
  errorRate: 0.01,
  baselineErrorRate: 0.01,
  newIssueGroups: 0,
  ...s,
});
const down = (error = "telemetry 503"): HealthSample => ({
  ok: false,
  at: "2026-10-01T12:00:00.000Z",
  error,
});

const table: Array<[string, HealthSample[], HealthStatus]> = [
  ["no samples", [], "insufficient-data"],
  ["healthy: same error rate", [ok()], "healthy"],
  ["healthy: increase exactly at the threshold", [ok({ errorRate: 0.02 })], "healthy"],
  ["regression: increase above the threshold", [ok({ errorRate: 0.021 })], "regression"],
  ["healthy: error rate went down", [ok({ errorRate: 0, baselineErrorRate: 0.05 })], "healthy"],
  ["regression: a new issue group (max 0)", [ok({ newIssueGroups: 1 })], "regression"],
  [
    "regression: new issue groups count even with little traffic",
    [ok({ requests: 3, newIssueGroups: 2 })],
    "regression",
  ],
  [
    "insufficient: below minRequests even with a terrible rate",
    [ok({ requests: 49, errorRate: 1 })],
    "insufficient-data",
  ],
  ["healthy: exactly minRequests", [ok({ requests: 50 })], "healthy"],
  ["regression: unknown error rate with enough requests", [ok({ errorRate: null })], "regression"],
  [
    "insufficient: unknown error rate without enough requests",
    [ok({ requests: 10, errorRate: null })],
    "insufficient-data",
  ],
  [
    "baseline falls back to the last known one (old version at 0% traffic)",
    [ok({ baselineErrorRate: 0.01 }), ok({ errorRate: 0.015, baselineErrorRate: null })],
    "healthy",
  ],
  [
    "regression against the last known baseline",
    [ok({ baselineErrorRate: 0.01 }), ok({ errorRate: 0.05, baselineErrorRate: null })],
    "regression",
  ],
  [
    "no baseline ever: assumed 0 (conservative)",
    [ok({ errorRate: 0.02, baselineErrorRate: null })],
    "regression",
  ],
  [
    "no baseline ever, low error rate",
    [ok({ errorRate: 0.005, baselineErrorRate: null })],
    "healthy",
  ],
  ["one failed check: judge the last good sample", [ok(), down()], "healthy"],
  ["two failed checks still judge the last good sample", [ok(), down(), down()], "healthy"],
  [
    "three consecutive failed checks: regression (unknown → escalate)",
    [ok(), down(), down(), down()],
    "regression",
  ],
  ["failures that recovered do not count", [down(), down(), ok(), down()], "healthy"],
  ["only failures (fewer than 3)", [down(), down()], "insufficient-data"],
];

describe("evaluateHealth", () => {
  it.each(table)("%s", (_name, samples, expected) => {
    const verdict = evaluateHealth(policy, samples);
    expect(verdict.status).toBe(expected);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("respects a looser policy", () => {
    const loose = RolloutPolicy.parse({
      maxErrorRateIncrease: 0.1,
      maxNewIssueGroups: 3,
      minRequests: 0,
    });
    expect(evaluateHealth(loose, [ok({ errorRate: 0.1, newIssueGroups: 3 })]).status).toBe(
      "healthy",
    );
    expect(evaluateHealth(loose, [ok({ errorRate: 0.2 })]).status).toBe("regression");
  });
});
