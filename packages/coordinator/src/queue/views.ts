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

export interface QueueEntryView extends EntryStatus {
  title: string | null;
  authorId: string;
  priority: "revert" | "incident" | "security" | "normal";
  enqueuedAt: number;
  dependsOn: string[];
  plangroup: string | null;
  ejectReason: EjectReason | null;
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
  updatedAt: number;
}

export function entryView(
  s: QueueState,
  changeId: string,
  now: number,
  intentOf: (changeId: string) => QueueIntent | null,
): QueueEntryView | null {
  const st = entryStatus(s, changeId, now);
  const e = s.entries[changeId];
  if (st === null || e === undefined) return null;
  return {
    ...st,
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
}): QueueOverviewView {
  const { state: s, now } = input;
  const o = overview(s, now);
  const active = Object.values(s.entries)
    .filter((e) => !TERMINAL_STATES.has(e.state))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.changeId);
  const recent = [...s.terminal].reverse().slice(0, 30);
  const entries = [...active, ...recent]
    .map((id) => entryView(s, id, now, input.intentOf))
    .filter((v): v is QueueEntryView => v !== null);
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
    updatedAt: now,
  };
}
