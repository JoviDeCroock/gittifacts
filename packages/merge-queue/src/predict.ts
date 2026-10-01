/**
 * Outcome prediction (§4.6). A transparent heuristic: a product of named factors, each logged with
 * the prediction (`Telemetry{kind:"prediction"}`) and later with the outcome, so a learned model can
 * replace it. A prediction only sizes and orders batches: it never skips a required check.
 */
import { ALL_TESTS, type Prediction, type QueueEntry } from "./schema.js";
import type { QueueState } from "./state.js";

export const PREDICTOR_MODEL = "heuristic-v1";

/** Prior pass rate for an author with no history, and how many observations it weighs. */
const AUTHOR_PRIOR = 0.95;
const AUTHOR_PRIOR_WEIGHT = 10;

export function flakeRate(s: QueueState, test: string): number {
  const f = s.flakes[test];
  if (f === undefined) return 0;
  return Math.min(0.5, f.flaky / Math.max(20, s.stats.fullRuns));
}

export function predict(s: QueueState, e: QueueEntry): Prediction {
  const factors: Record<string, number> = {};
  factors.base = 0.98;
  factors.lane = e.lane === 0 ? 1 : e.lane === 1 ? 0.99 : 0.97;
  const lines = e.size.lines;
  factors.size = lines > 1000 ? 0.94 : lines > 400 ? 0.97 : lines > 150 ? 0.99 : 1;
  const a = s.stats.authors[e.authorId];
  const rate =
    a === undefined
      ? AUTHOR_PRIOR
      : (a.passed + AUTHOR_PRIOR * AUTHOR_PRIOR_WEIGHT) / (a.passed + a.failed + AUTHOR_PRIOR_WEIGHT);
  factors.author = Math.min(1.02, rate / AUTHOR_PRIOR);
  factors.redGreen = e.evidence.redGreen === false ? 0.97 : e.evidence.redGreen === null ? 0.99 : 1;
  const cov = e.evidence.coverage;
  factors.coverage = cov === null ? 0.99 : cov < 0.5 ? 0.97 : cov < 0.8 ? 0.99 : 1;
  const mut = e.evidence.mutationScore;
  factors.mutation = mut === null ? 1 : mut < 0.4 ? 0.98 : 1;
  factors.publicApi = e.affected?.publicApi === true ? 0.98 : 1;
  factors.resolved = e.resolution?.resolved === true ? 0.95 : 1;
  factors.retried = e.attempts > 0 ? 0.9 : 1;
  let flake = 1;
  for (const t of e.affected?.testTargets ?? []) {
    if (t === ALL_TESTS) continue;
    if (s.quarantine[t] !== undefined) continue;
    flake *= 1 - flakeRate(s, t);
  }
  factors.flakiness = flake;
  let p = 1;
  for (const v of Object.values(factors)) p *= v;
  return { p: Math.min(0.999, Math.max(0.01, p)), factors, model: PREDICTOR_MODEL };
}
