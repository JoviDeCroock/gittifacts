/**
 * Invariant enforcement. `InvariantViolation` is thrown by the core when it is about to break a
 * non-negotiable rule (§1) — the step is then rejected as a whole and must not be persisted. The
 * shell alerts; it never "fixes" the state by hand.
 */
import { conflicts, isWildcard } from "./conflict.js";
import { TERMINAL_STATES } from "./schema.js";
import type { QueueState } from "./state.js";

export class InvariantViolation extends Error {
  override readonly name = "InvariantViolation";
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
  }
}

export function invariant(
  cond: unknown,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): asserts cond {
  if (!cond) throw new InvariantViolation(code, message, details);
}

/**
 * Structural consistency of a state (used by tests and the simulator after every step; cheap enough
 * for the DO to run in debug builds).
 */
export function checkStateInvariants(s: QueueState): void {
  const seen = new Map<string, string>();
  for (const t of Object.values(s.tracks)) {
    invariant(t.chain.length > 0, "track.empty", `track ${t.id} has an empty chain`);
    for (const bid of t.chain) {
      const b = s.batches[bid];
      invariant(b !== undefined, "track.dangling", `track ${t.id} references missing batch ${bid}`);
      invariant(b.kind === "chain", "track.kind", `track ${t.id} holds non-chain batch ${bid}`);
      invariant(b.trackId === t.id, "track.owner", `batch ${bid} is in track ${t.id} but says ${b.trackId}`);
      invariant(
        !["landed", "cancelled", "failed", "bisecting"].includes(b.state),
        "track.terminal",
        `track ${t.id} holds ${b.state} batch ${bid}`,
      );
      for (const u of b.units)
        for (const id of u.changeIds) {
          invariant(!seen.has(id), "entry.duplicated", `${id} is in ${seen.get(id)} and ${bid}`);
          seen.set(id, bid);
          const e = s.entries[id];
          invariant(e !== undefined, "entry.lost", `batch ${bid} holds unknown entry ${id}`);
          invariant(e.batchId === bid, "entry.batch", `${id} in ${bid} points at ${e.batchId}`);
          invariant(
            e.state === "speculating" || e.state === "passed",
            "entry.state",
            `${id} in chain batch ${bid} is ${e.state}`,
          );
        }
    }
  }
  for (const b of Object.values(s.batches)) {
    if (b.kind !== "chain" || b.state !== "bisecting") continue;
    for (const u of b.units)
      for (const id of u.changeIds) {
        const e = s.entries[id];
        if (e === undefined || TERMINAL_STATES.has(e.state)) continue;
        invariant(!seen.has(id), "entry.duplicated", `${id} is in ${seen.get(id)} and bisecting ${b.id}`);
        seen.set(id, b.id);
      }
  }
  for (const e of Object.values(s.entries)) {
    if (e.state === "speculating" || e.state === "passed") {
      invariant(seen.has(e.changeId), "entry.lost", `${e.changeId} is ${e.state} but in no batch`);
    }
    if (e.state === "waiting" || e.state === "resolving") {
      invariant(!seen.has(e.changeId), "entry.duplicated", `${e.changeId} is ${e.state} but in a batch`);
      invariant(e.batchId === null, "entry.batch", `${e.changeId} is ${e.state} with batch ${e.batchId}`);
    }
    invariant(e.lane >= 0 && e.lane <= 2, "lane.range", `${e.changeId} lane ${e.lane}`);
  }
  // Independent tracks never conflict; an unknown affected set never shares the queue with another track.
  const tracks = Object.values(s.tracks);
  if (s.config.features.conflictGraph) {
    for (let i = 0; i < tracks.length; i++)
      for (let j = i + 1; j < tracks.length; j++) {
        const a = trackEntries(s, tracks[i]?.id ?? "");
        const b = trackEntries(s, tracks[j]?.id ?? "");
        for (const x of a)
          for (const y of b) {
            const ax = s.entries[x]?.affected ?? null;
            const ay = s.entries[y]?.affected ?? null;
            invariant(
              !conflicts(ax, ay),
              isWildcard(ax) || isWildcard(ay) ? "parallel.unknown" : "parallel.conflict",
              `${x} (track ${tracks[i]?.id}) conflicts with ${y} (track ${tracks[j]?.id})`,
            );
          }
      }
  } else {
    invariant(tracks.length <= 1, "parallel.no-graph", "without a conflict graph there is one track");
  }
  if (s.cas !== null) {
    invariant(s.batches[s.cas.batchId] !== undefined, "cas.batch", "CAS in flight for a missing batch");
  }
}

export function trackEntries(s: QueueState, trackId: string): string[] {
  const t = s.tracks[trackId];
  if (t === undefined) return [];
  const out: string[] = [];
  for (const bid of t.chain) for (const u of s.batches[bid]?.units ?? []) out.push(...u.changeIds);
  return out;
}
