import { type QueueConfig, queueConfig } from "./config.js";
import type { AffectedSet, Batch, FreezeReason, QueueEntry, Track } from "./schema.js";

/** One landed main commit (only the queue lands, so every entry is a CAS the core issued). */
export interface MainLogEntry {
  seq: number;
  sha: string;
  parentSha: string | null;
  /** Changes this commit added. `affected: null` = unknown (external push). */
  changes: { changeId: string; affected: AffectedSet | null; revertOf: string | null }[];
  at: number;
  kind: "genesis" | "cas" | "external";
}

export interface PendingCas {
  casId: string;
  batchId: string;
  expectedOld: string;
  newSha: string;
  treeSha: string;
  entries: string[];
  issuedAt: number;
}

export interface FlakeStats {
  /** Failures that did not reproduce on the same tree, or reproduced on main. */
  flaky: number;
  /** Failures that reproduced on the batch tree but not on main. */
  real: number;
  lastAt: number;
}

export interface QuarantineRecord {
  test: string;
  at: number;
  batchId: string;
  treeSha: string;
  mainSha: string;
}

export interface QueueStats {
  /** EWMA of first-run outcomes of chain batches (real failures only). */
  batchPassRate: number;
  /** EWMA of full CI run duration (ETAs). */
  ciDurationMs: number;
  /** Full-scope runs observed (denominator for flake rates). */
  fullRuns: number;
  /** Author pass/fail counts (prediction). */
  authors: Record<string, { passed: number; failed: number }>;
  /** Recent merges: time in queue (overview p50/p95, throughput). */
  recentMerged: { changeId: string; at: number; waitMs: number }[];
  merged: number;
  ejected: number;
}

export interface QueueState {
  v: 1;
  config: QueueConfig;
  nextId: number;
  main: { sha: string; seq: number };
  mainLog: MainLogEntry[];
  entries: Record<string, QueueEntry>;
  batches: Record<string, Batch>;
  tracks: Record<string, Track>;
  /** Landing (revalidation) batches, in CAS order. */
  landing: string[];
  cas: PendingCas | null;
  /** Earliest time a rejected CAS may be retried. */
  casRetryAt: number | null;
  freeze: { reasons: FreezeReason[]; badSeq: number | null };
  flakes: Record<string, FlakeStats>;
  quarantine: Record<string, QuarantineRecord>;
  fairness: { vtime: number; finish: Record<string, number> };
  stats: QueueStats;
  seq: number;
  /** Terminal entries in the order they ended (GC'd beyond `retainTerminal`). */
  terminal: string[];
}

export function initialState(
  mainSha: string,
  config: QueueConfig = queueConfig(),
  now = 0,
): QueueState {
  return {
    v: 1,
    config,
    nextId: 1,
    main: { sha: mainSha, seq: 0 },
    mainLog: [{ seq: 0, sha: mainSha, parentSha: null, changes: [], at: now, kind: "genesis" }],
    entries: {},
    batches: {},
    tracks: {},
    landing: [],
    cas: null,
    casRetryAt: null,
    freeze: { reasons: [], badSeq: null },
    flakes: {},
    quarantine: {},
    fairness: { vtime: 0, finish: {} },
    stats: {
      batchPassRate: 0.9,
      ciDurationMs: config.initialCiDurationMs,
      fullRuns: 0,
      authors: {},
      recentMerged: [],
      merged: 0,
      ejected: 0,
    },
    seq: 0,
    terminal: [],
  };
}

/**
 * Copy-on-step: entities are copied one level deep; nested arrays and affected sets are treated as
 * immutable everywhere in the core (always replaced, never mutated in place).
 */
export function cloneState(s: QueueState): QueueState {
  const entries: Record<string, QueueEntry> = {};
  for (const [k, e] of Object.entries(s.entries)) entries[k] = { ...e };
  const batches: Record<string, Batch> = {};
  for (const [k, b] of Object.entries(s.batches)) batches[k] = { ...b };
  const tracks: Record<string, Track> = {};
  for (const [k, t] of Object.entries(s.tracks)) tracks[k] = { ...t };
  const authors: Record<string, { passed: number; failed: number }> = {};
  for (const [k, a] of Object.entries(s.stats.authors)) authors[k] = { ...a };
  const flakes: Record<string, FlakeStats> = {};
  for (const [k, f] of Object.entries(s.flakes)) flakes[k] = { ...f };
  return {
    ...s,
    main: { ...s.main },
    mainLog: [...s.mainLog],
    entries,
    batches,
    tracks,
    landing: [...s.landing],
    cas: s.cas === null ? null : { ...s.cas },
    freeze: { reasons: [...s.freeze.reasons], badSeq: s.freeze.badSeq },
    flakes,
    quarantine: { ...s.quarantine },
    fairness: { vtime: s.fairness.vtime, finish: { ...s.fairness.finish } },
    stats: { ...s.stats, authors, recentMerged: [...s.stats.recentMerged] },
    terminal: [...s.terminal],
  };
}

export function isFrozen(s: QueueState): boolean {
  return s.freeze.reasons.length > 0;
}
