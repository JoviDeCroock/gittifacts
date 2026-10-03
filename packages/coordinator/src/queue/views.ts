/**
 * Read-side views for `queue_status`, `queue_overview`, the HTTP API and the web queue view.
 * Built from the core's own queries (`entryStatus`, `overview`) plus what the shell knows
 * (titles, the halt, deploy trains).
 */
import {
  type EjectReason,
  type EntryStatus,
  entryStatus,
  type FreezeReason,
  overview,
  type QueueState,
  TERMINAL_STATES,
  type TrainState,
} from "@app/merge-queue";
import type { QueueIntent } from "./context.js";
import type { HaltInfo } from "./loop.js";
import { type QueueStall, stallFor } from "./stalls.js";

export interface QueueEntryView extends EntryStatus {
  title: string | null;
  authorId: string;
  priority: "revert" | "incident" | "security" | "normal";
  enqueuedAt: number;
  dependsOn: string[];
  plangroup: string | null;
  ejectReason: EjectReason | null;
  /**
   * What holds this Change up when something is not moving (its own step or its batch's):
   * "retrying" (a step keeps failing), "stalled" (nothing moves until a rebuild), "needs-human".
   * The overview's `stalls` has the why and the when. An entry with a stall has no ETA.
   */
  stall: QueueStall["state"] | null;
}

export interface TrainView {
  id: string;
  worker: string;
  state:
    | "deploying"
    | "watching"
    | "killing"
    | "rolling-back"
    | "released"
    | "rolled-back"
    | "failed";
  changeIds: string[];
  versionId: string | null;
  watchUntil: number | null;
  killed: string[];
}

export interface QueueOverviewView {
  repoId: string;
  mainSha: string;
  frozen: boolean;
  freezeReasons: FreezeReason[];
  halted: { code: string; message: string; at: number } | null;
  tracks: {
    id: string;
    express: boolean;
    batches: {
      id: string;
      state: string;
      kind: "chain" | "probe" | "landing";
      entries: string[];
    }[];
  }[];
  landing: { id: string; state: string; members: string[]; targets: "all" | string[] }[];
  entries: QueueEntryView[];
  waiting: number;
  resolving: number;
  throughputPerHour: number;
  timeInQueueMs: { p50: number | null; p95: number | null };
  ciDurationMs: number;
  quarantined: string[];
  flakeRates: Record<string, number>;
  trains: TrainView[];
  /** Steps that keep failing or stopped, with why and what happens next (empty: all moving). */
  stalls: QueueStall[];
  updatedAt: number;
}

export function entryView(
  s: QueueState,
  changeId: string,
  now: number,
  intentOf: (changeId: string) => QueueIntent | null,
  stalls: QueueStall[] = [],
): QueueEntryView | null {
  const st = entryStatus(s, changeId, now);
  const e = s.entries[changeId];
  if (st === null || e === undefined) return null;
  const terminal = TERMINAL_STATES.has(e.state);
  const stall = terminal ? null : stallFor(stalls, changeId, st.batch?.id ?? null);
  return {
    ...st,
    // A stalled Change has no honest ETA: the view says what happens next instead.
    etaSeconds: stall === null ? st.etaSeconds : null,
    reason: stall === null ? st.reason : `${stallLine(stall)} (${st.reason})`,
    stall: stall?.state ?? null,
    title: intentOf(changeId)?.title ?? null,
    authorId: e.authorId,
    priority: e.priority,
    enqueuedAt: e.enqueuedAt,
    dependsOn: e.dependsOn,
    plangroup: e.plangroup,
    ejectReason: e.ejectReason,
  };
}

export function trainViews(t: TrainState): TrainView[] {
  return Object.values(t.trains)
    .map((x) => ({
      id: x.id,
      worker: x.worker,
      state: x.state,
      changeIds: x.changes.map((c) => c.changeId),
      versionId: x.versionId,
      watchUntil: x.watchUntil,
      killed: x.killed,
    }))
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, 20);
}

/** Active entries first (in scheduling order), then the 30 most recent terminal ones. */
export function overviewView(input: {
  repoId: string;
  state: QueueState;
  trains: TrainState;
  halted: HaltInfo | null;
  now: number;
  intentOf: (changeId: string) => QueueIntent | null;
  stalls?: QueueStall[];
}): QueueOverviewView {
  const stalls = input.stalls ?? [];
  const { state: s, now } = input;
  const o = overview(s, now);
  const views = (ids: string[]) =>
    ids
      .map((id) => entryView(s, id, now, input.intentOf, stalls))
      .filter((v): v is QueueEntryView => v !== null);
  // Active first: in-flight (by batch, then arrival), then waiting in scheduling order.
  const active = views(
    Object.values(s.entries)
      .filter((e) => !TERMINAL_STATES.has(e.state))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.changeId),
  ).sort((a, b) => (a.position ?? -1) - (b.position ?? -1));
  const entries = [...active, ...views([...s.terminal].reverse().slice(0, 30))];
  return {
    repoId: input.repoId,
    mainSha: o.mainSha,
    frozen: o.frozen,
    freezeReasons: o.freezeReasons,
    halted:
      input.halted === null
        ? null
        : { code: input.halted.code, message: input.halted.message, at: input.halted.at },
    tracks: o.tracks,
    landing: o.landing,
    entries,
    waiting: o.waiting,
    resolving: o.resolving,
    throughputPerHour: o.throughputPerHour,
    timeInQueueMs: o.timeInQueueMs,
    ciDurationMs: o.ciDurationMs,
    quarantined: o.quarantined,
    flakeRates: o.flakeRates,
    trains: trainViews(input.trains),
    stalls,
    updatedAt: now,
  };
}

/** One line for an entry's reason (times are the view's to format). */
export function stallLine(x: QueueStall): string {
  const why = x.error === null ? "" : `: ${x.error.errorClass}: ${x.error.message}`;
  switch (x.state) {
    case "retrying":
      return `retrying: ${x.what.toLowerCase()} failed ${x.attempts} time${x.attempts === 1 ? "" : "s"}${why}`;
    case "stalled":
      return `stalled: ${x.what.toLowerCase()} stopped${why}; rebuilt automatically after the build timeout`;
    case "needs-human":
      return `needs a human: ${x.next.kind === "human" ? x.next.message : x.what.toLowerCase()}`;
  }
}
