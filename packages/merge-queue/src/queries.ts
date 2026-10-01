/**
 * Read-side views of the queue state for `queue_status`, `queue_overview` and `enqueue` replies
 * (§5). Pure functions of (state, now).
 */
import { conflicts } from "./conflict.js";
import { flakeRate, predict } from "./predict.js";
import { compareOrder, effectiveRank } from "./priority.js";
import type { Batch, EjectReason, EntryState, FreezeReason, HoldReason, Lane, QueueEntry } from "./schema.js";
import { TERMINAL_STATES } from "./schema.js";
import { isFrozen, type QueueState } from "./state.js";

export interface EntryStatus {
  changeId: string;
  state: EntryState;
  hold: HoldReason | null;
  lane: Lane;
  trackId: string | null;
  batch: { id: string; state: Batch["state"]; size: number; chainPosition: number } | null;
  /** Position among waiting entries in scheduling order (0 = next), null when not waiting. */
  position: number | null;
  etaSeconds: number | null;
  /** Entries this one is waiting behind or on. */
  blocking: string[];
  /** Human/agent-readable reason for the current wait. */
  reason: string;
  predictedPassProbability: number | null;
  frozen: boolean;
  ejectReason: EjectReason | null;
  mergedSha: string | null;
}

function waitingOrder(s: QueueState, now: number): QueueEntry[] {
  return Object.values(s.entries)
    .filter((e) => e.state === "waiting")
    .map((e) => ({ e, o: { rank: effectiveRank(e, now, s.config), tag: e.wfqTag, seq: e.seq } }))
    .sort((a, b) => compareOrder(a.o, b.o))
    .map((x) => x.e);
}

function chainOf(s: QueueState, trackId: string): Batch[] {
  return (s.tracks[trackId]?.chain ?? []).map((id) => s.batches[id]).filter((b): b is Batch => b !== undefined);
}

function entriesOf(b: Batch): string[] {
  return b.units.flatMap((u) => u.changeIds);
}

/** Rough ETA: time left on the batch (and its ancestors) + a landing allowance. */
function batchEtaMs(s: QueueState, b: Batch, now: number): number {
  const ci = s.stats.ciDurationMs;
  const left = (x: Batch): number => {
    if (x.state === "passed" || x.state === "landing") return 0;
    if (x.state === "running" && x.startedAt !== null) return Math.max(0, x.startedAt + ci - now);
    return ci;
  };
  let eta = left(b);
  for (const a of chainOf(s, b.trackId ?? "")) {
    if (a.id === b.id) break;
    eta = Math.max(eta, left(a));
  }
  return eta + Math.round(ci * 0.2);
}

export function entryStatus(s: QueueState, changeId: string, now: number): EntryStatus | null {
  const e = s.entries[changeId];
  if (e === undefined) return null;
  const frozen = isFrozen(s);
  const base = {
    changeId,
    state: e.state,
    hold: e.hold,
    lane: e.lane,
    trackId: e.trackId,
    predictedPassProbability: e.prediction?.p ?? (TERMINAL_STATES.has(e.state) ? null : predict(s, e).p),
    frozen,
    ejectReason: e.ejectReason,
    mergedSha: e.mergedSha,
  };
  if (TERMINAL_STATES.has(e.state)) {
    return { ...base, batch: null, position: null, etaSeconds: null, blocking: [], reason: e.state };
  }
  const b = e.batchId === null ? undefined : s.batches[e.batchId];
  if (b !== undefined) {
    const chain = chainOf(s, b.trackId ?? "");
    const pos = chain.findIndex((x) => x.id === b.id);
    const ahead = chain.slice(0, Math.max(0, pos)).flatMap(entriesOf);
    let reason: string;
    if (frozen && e.priority !== "revert" && e.priority !== "incident")
      reason = "queue is frozen: speculating, but only reverts and incident fixes land until it thaws";
    else if (b.state === "bisecting") reason = `batch ${b.id} failed; bisecting to find the culprit`;
    else if (b.state === "passed") reason = ahead.length > 0 ? `passed; landing after ${ahead.join(", ")}` : "passed; landing";
    else if (b.state === "landing") reason = "landing (revalidating on main / CAS)";
    else reason = `testing in batch ${b.id} (track ${b.trackId})${ahead.length ? ` on top of ${ahead.length} change(s)` : ""}`;
    return {
      ...base,
      batch: { id: b.id, state: b.state, size: entriesOf(b).length, chainPosition: pos },
      position: null,
      etaSeconds: Math.round(batchEtaMs(s, b, now) / 1000),
      blocking: ahead,
      reason,
    };
  }
  if (e.state === "resolving") {
    return {
      ...base,
      batch: null,
      position: null,
      etaSeconds: Math.round((s.stats.ciDurationMs * 1.5) / 1000),
      blocking: e.resolution?.upstream ?? [],
      reason: `resolving a ${e.resolution?.kind ?? ""} conflict (attempt ${e.resolution?.attempts ?? 1})`,
    };
  }
  const order = waitingOrder(s, now);
  const position = order.findIndex((x) => x.changeId === changeId);
  let reason = "waiting for the next batch";
  let blocking: string[] = [];
  if (e.hold === "affected") reason = "waiting for the affected-set analysis";
  else if (e.hold === "approval") reason = `lane rose to ${e.lane}: waiting for a human approval`;
  else if (e.hold === "dependency") {
    blocking = e.dependsOn;
    reason = `waiting on stacked dependency ${e.dependsOn.join(", ")}`;
  } else if (e.hold === "group") reason = `waiting for every member of plan group ${e.plangroup}`;
  else {
    const hits: { track: string; change: string }[] = [];
    for (const t of Object.values(s.tracks)) {
      const ids = chainOf(s, t.id).flatMap(entriesOf);
      const hit = ids.find((id) => conflicts(s.entries[id]?.affected ?? null, e.affected));
      if (hit !== undefined) hits.push({ track: t.id, change: hit });
    }
    blocking = hits.map((h) => h.change);
    if (hits.length > 1)
      reason = `waiting on conflicting ${hits.map((h) => `Change ${h.change} in track ${h.track}`).join(" and ")}`;
    else if (hits.length === 1) reason = `waiting for a speculation slot in track ${hits[0]?.track} (conflicts with ${hits[0]?.change})`;
  }
  const tracks = Math.max(1, Object.keys(s.tracks).length);
  const rounds = 1 + Math.floor(Math.max(0, position) / (tracks * s.config.maxBatchSize));
  return {
    ...base,
    batch: null,
    position,
    etaSeconds: Math.round((s.stats.ciDurationMs * (rounds + 0.2)) / 1000),
    blocking,
    reason,
  };
}

/** Reply to `enqueue` (§5): computed on the state right after the Enqueued step. */
export function enqueueReply(
  s: QueueState,
  changeId: string,
  now: number,
): { position: number; track: string | null; etaSeconds: number; predictedPassProbability: number } | null {
  const st = entryStatus(s, changeId, now);
  if (st === null) return null;
  return {
    position: st.position ?? 0,
    track: st.trackId,
    etaSeconds: st.etaSeconds ?? 0,
    predictedPassProbability: st.predictedPassProbability ?? 0,
  };
}

export interface QueueOverview {
  frozen: boolean;
  freezeReasons: FreezeReason[];
  mainSha: string;
  tracks: {
    id: string;
    express: boolean;
    batches: { id: string; state: Batch["state"]; entries: string[]; kind: Batch["kind"] }[];
  }[];
  landing: { id: string; state: Batch["state"]; members: string[]; targets: Batch["targets"] }[];
  waiting: number;
  resolving: number;
  throughputPerHour: number;
  timeInQueueMs: { p50: number | null; p95: number | null };
  ciDurationMs: number;
  quarantined: string[];
  flakeRates: Record<string, number>;
}

function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

export function flakeRates(s: QueueState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of Object.keys(s.flakes)) out[t] = flakeRate(s, t);
  return out;
}

export function overview(s: QueueState, now: number): QueueOverview {
  const recent = s.stats.recentMerged;
  const lastHour = recent.filter((r) => now - r.at <= 3_600_000).length;
  const waits = recent.map((r) => r.waitMs);
  return {
    frozen: isFrozen(s),
    freezeReasons: s.freeze.reasons,
    mainSha: s.main.sha,
    tracks: Object.values(s.tracks).map((t) => ({
      id: t.id,
      express: t.express,
      batches: chainOf(s, t.id).map((b) => ({ id: b.id, state: b.state, entries: entriesOf(b), kind: b.kind })),
    })),
    landing: s.landing
      .map((id) => s.batches[id])
      .filter((b): b is Batch => b !== undefined)
      .map((b) => ({ id: b.id, state: b.state, members: b.members, targets: b.targets })),
    waiting: Object.values(s.entries).filter((e) => e.state === "waiting").length,
    resolving: Object.values(s.entries).filter((e) => e.state === "resolving").length,
    throughputPerHour: lastHour,
    timeInQueueMs: { p50: quantile(waits, 0.5), p95: quantile(waits, 0.95) },
    ciDurationMs: s.stats.ciDurationMs,
    quarantined: Object.keys(s.quarantine),
    flakeRates: flakeRates(s),
  };
}
