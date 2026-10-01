import { z } from "zod";

/**
 * Mechanism switches. Every mechanism of §4 can be turned off, so the simulator can show what each
 * one earns against the simpler alternative (and the baselines are just configurations).
 */
export const QueueFeatures = z.object({
  /** §4.1/4.2 conflict graph → independent tracks. Off: every entry conflicts with every other. */
  conflictGraph: z.boolean().default(true),
  /** §4.3 bisection of failed batches (parallel prefix probes). Off: re-test each unit alone. */
  bisection: z.boolean().default(true),
  /** §4.6 prediction: adaptive batch size + likely failures last. Off: fixed size, priority order. */
  prediction: z.boolean().default(true),
  /** §4.7 re-run failing tests on the batch tree and on main before believing a failure. */
  flakeRecheck: z.boolean().default(true),
  /** §4.4 agent conflict resolution. Off: conflicts are ejected. */
  resolver: z.boolean().default(true),
  /** §4.2 impacted-targets revalidation of stale tracks. Off: a stale track always re-runs everything. */
  revalidation: z.boolean().default(true),
  /** §4.5 priority classes. Off: FIFO. */
  priorities: z.boolean().default(true),
  /** §4.5 aging (no starvation). */
  aging: z.boolean().default(true),
  /** §4.5 weighted fair queuing per principal/session + in-flight cap. */
  fairness: z.boolean().default(true),
});
export type QueueFeatures = z.infer<typeof QueueFeatures>;

export const QueueConfig = z.object({
  features: QueueFeatures.default(QueueFeatures.parse({})),
  /** Upper bound on entries in one batch (a land-together unit may exceed it). */
  maxBatchSize: z.number().int().min(1).max(64).default(8),
  /** Batch size when prediction is off. */
  fixedBatchSize: z.number().int().min(1).max(64).default(4),
  /** Stop adding entries once the predicted batch pass probability falls below this. */
  targetBatchPassProbability: z.number().min(0).max(1).default(0.85),
  /** In-flight (untested) batches a new batch may speculate on, itself included (1 = no speculation). */
  maxSpeculationDepth: z.number().int().min(1).max(32).default(8),
  /**
   * A batch built on an in-flight predecessor can't land before it anyway, so it stays open for
   * joiners this long after its parent started (free batching: fewer CI runs, no added latency).
   */
  batchHoldMs: z.number().int().min(0).default(2 * 60_000),
  /**
   * In-flight chain batches across the repo. Backpressure: while it is reached, arrivals wait and
   * are batched together when a slot frees (bigger batches, fewer CI minutes).
   */
  maxInFlightBatches: z.number().int().min(1).max(1024).default(128),
  /** Independent units placed in the same pass may share one batch (saves CI; couples their fate). */
  coBatch: z.boolean().default(true),
  maxTracks: z.number().int().min(1).max(256).default(32),
  maxConcurrentRuns: z.number().int().min(1).max(1024).default(64),
  /** Revalidation (landing) batches in flight on top of each other. */
  maxLandingDepth: z.number().int().min(1).max(64).default(16),
  /**
   * Passed batches revalidated together in one landing batch. Small landing batches keep the
   * impacted-target runs short (they're on the landing critical path); the pipeline overlaps them.
   */
  maxLandingMembers: z.number().int().min(1).max(64).default(2),
  /** Parallel prefix probes per bisection round. */
  bisectProbes: z.number().int().min(1).max(16).default(3),
  /** Every `agingStepMs` of waiting raises an entry one priority class (never above `security`). */
  agingStepMs: z.number().int().min(1).default(15 * 60_000),
  /** Entries one agent session may have in batches at once. */
  maxInFlightPerSession: z.number().int().min(1).default(12),
  /** Fair-share weights per principal (default 1). */
  principalWeights: z.record(z.string(), z.number().positive()).default({}),
  resolutionMaxAttempts: z.number().int().min(1).max(10).default(2),
  /** An affected set not computed after this long is treated as unknown (conflicts with all). */
  affectedSetTimeoutMs: z.number().int().min(1).default(15 * 60_000),
  /** A CI run with no result after this long is cancelled and retried. */
  runTimeoutMs: z.number().int().min(1).default(90 * 60_000),
  maxInfraRetries: z.number().int().min(0).default(3),
  /** Prior for the CI duration estimate (ETAs) before any run has finished. */
  initialCiDurationMs: z.number().int().min(1).default(10 * 60_000),
  /** Landed main commits remembered for staleness checks. */
  mainLogLimit: z.number().int().min(16).default(2000),
  /** Terminal entries kept for status queries. */
  retainTerminal: z.number().int().min(0).default(500),
});
export type QueueConfig = z.infer<typeof QueueConfig>;
export type QueueConfigInput = z.input<typeof QueueConfig>;

export function queueConfig(input: QueueConfigInput = {}): QueueConfig {
  return QueueConfig.parse(input);
}

const ALL_OFF: QueueFeatures = {
  conflictGraph: false,
  bisection: false,
  prediction: false,
  flakeRecheck: false,
  resolver: false,
  revalidation: false,
  priorities: false,
  aging: false,
  fairness: false,
};

/**
 * The coordinator's original serial queue (`packages/coordinator/src/merge-queue.ts`) expressed as a
 * configuration: FIFO, one change at a time, rebased onto main and re-tested, CAS, next. A conflict
 * or a failing check ejects (no resolver, no flake re-check).
 */
export function serialConfig(): QueueConfig {
  return queueConfig({
    features: ALL_OFF,
    maxBatchSize: 1,
    fixedBatchSize: 1,
    maxSpeculationDepth: 1,
    maxInFlightBatches: 1,
    coBatch: false,
    maxTracks: 1,
    maxLandingDepth: 1,
  });
}

/** "Batch everything, no conflict graph": one speculative track, every other mechanism on. */
export function batchAllConfig(): QueueConfig {
  return queueConfig({ features: { ...QueueFeatures.parse({}), conflictGraph: false } });
}
