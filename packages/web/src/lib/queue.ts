/**
 * Merge queue vocabulary and pure formatting helpers. No I/O, no clocks: `now` is passed in.
 */
import type {
  BatchKind,
  BatchState,
  EjectCode,
  EntryState,
  FreezeKind,
  FreezeReason,
  Hold,
  Priority,
  QueueEntryView,
  QueueTrack,
  TrainState,
} from "../api/queue.js";
import type { IconId } from "../components/Icon.js";
import type { StatusMeta, Tone } from "./vocab.js";

export const ENTRY_STATE: Record<EntryState, StatusMeta> = {
  waiting: { label: "Waiting", tone: "neutral", icon: "clock" },
  speculating: { label: "In a batch", tone: "neutral", icon: "layers" },
  resolving: { label: "Resolving conflict", tone: "warn", icon: "bot" },
  passed: { label: "Passed, landing", tone: "ok", icon: "check-circle" },
  merged: { label: "Merged", tone: "ok", icon: "git-merge" },
  ejected: { label: "Ejected", tone: "danger", icon: "x-circle" },
  dequeued: { label: "Dequeued", tone: "neutral", icon: "archive" },
};

export const BATCH_STATE: Record<BatchState, StatusMeta> = {
  pending: { label: "Pending", tone: "neutral", icon: "circle-dashed" },
  building: { label: "Building tree", tone: "neutral", icon: "package" },
  ready: { label: "Ready", tone: "neutral", icon: "circle-dot" },
  running: { label: "CI running", tone: "neutral", icon: "loader" },
  rechecking: { label: "Rechecking", tone: "neutral", icon: "test-tube" },
  passed: { label: "Passed", tone: "ok", icon: "check-circle" },
  landing: { label: "Landing", tone: "ok", icon: "git-merge" },
  landed: { label: "Landed", tone: "ok", icon: "git-merge" },
  failed: { label: "Failed", tone: "danger", icon: "x-circle" },
  bisecting: { label: "Bisecting", tone: "warn", icon: "search" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "ban" },
};

export const BATCH_KIND: Record<BatchKind, string> = {
  chain: "Speculative batch",
  probe: "Bisect probe",
  landing: "Landing",
};

export const TRAIN_STATE: Record<TrainState, StatusMeta> = {
  deploying: { label: "Deploying", tone: "neutral", icon: "rocket" },
  watching: { label: "Watching", tone: "warn", icon: "eye" },
  killing: { label: "Killing a flag", tone: "danger", icon: "flag" },
  "rolling-back": { label: "Rolling back", tone: "danger", icon: "undo" },
  released: { label: "Released", tone: "ok", icon: "badge-check" },
  "rolled-back": { label: "Rolled back", tone: "danger", icon: "undo" },
  failed: { label: "Failed", tone: "danger", icon: "x-circle" },
};

export const PRIORITY: Record<Priority, { label: string; icon: IconId | null }> = {
  revert: { label: "Revert", icon: "undo" },
  incident: { label: "Incident fix", icon: "triangle-alert" },
  security: { label: "Security fix", icon: "shield-alert" },
  normal: { label: "Normal priority", icon: null },
};

export const HOLD: Record<Hold, string> = {
  affected: "Held: overlaps a change ahead",
  dependency: "Held: waits for its stack",
  group: "Held: waits for its plan group",
  approval: "Held: needs approval",
};

export const FREEZE_KIND: Record<FreezeKind, string> = {
  "post-merge-check": "Post-merge checks failed on main",
  "revert-in-progress": "Automatic revert in progress",
  manual: "Frozen by hand",
};

export const EJECT_CODE: Record<EjectCode, string> = {
  "tests-failed": "Tests failed",
  "semantic-conflict": "Semantic conflict",
  "textual-conflict": "Conflict could not be resolved",
  "resolution-budget-exhausted": "Resolver budget used up",
  "dependency-ejected": "A change it depends on was ejected",
  "group-member-failed": "Another change in its plan group failed",
  "infra-error": "Infrastructure error",
  superseded: "Superseded",
};

const TERMINAL: ReadonlySet<EntryState> = new Set(["merged", "ejected", "dequeued"]);

export function isTerminal(state: EntryState): boolean {
  return TERMINAL.has(state);
}

/** Active entries in server order, then finished ones (merged, ejected, dequeued). */
export function splitEntries(entries: QueueEntryView[]): {
  active: QueueEntryView[];
  recent: QueueEntryView[];
} {
  return {
    active: entries.filter((e) => !isTerminal(e.state)),
    recent: entries.filter((e) => isTerminal(e.state)),
  };
}

/** "Track 2" from ids like `2`, `t2`, `trk_2`, `track-2`; the express track is named as such. */
export function trackLabel(id: string, express = false): string {
  if (express) return "Express track";
  const m = /^(?:t|trk|track)?[-_ ]?(\d+)$/i.exec(id);
  return m ? `Track ${Number(m[1])}` : `Track ${id}`;
}

/** Express tracks first, then the server's order. */
export function orderTracks(tracks: QueueTrack[]): QueueTrack[] {
  return [...tracks.filter((t) => t.express), ...tracks.filter((t) => !t.express)];
}

/** Rough ETA for humans: "under 1 min", "~9 min", "~1 h 25 min", or "No estimate". */
export function etaLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "No estimate";
  if (seconds < 60) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `~${h} h ${m} min` : `~${h} h`;
}

/** Durations for stats: "45 s", "6 min 40 s", "23 min", "1 h 11 min"; null → "Not measured". */
export function durationShort(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "Not measured";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 600) {
    const rest = s % 60;
    return rest ? `${Math.floor(s / 60)} min ${rest} s` : `${Math.floor(s / 60)} min`;
  }
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const m = minutes % 60;
  return m ? `${Math.floor(minutes / 60)} h ${m} min` : `${Math.floor(minutes / 60)} h`;
}

/** A probability as a whole percent; never rounds a non-certain value up to 100% or down to 0%. */
export function percentLabel(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "Not predicted";
  const v = Math.max(0, Math.min(1, p)) * 100;
  let r = Math.round(v);
  if (r === 100 && v < 100) r = 99;
  if (r === 0 && v > 0) r = 1;
  return `${r}%`;
}

/** A failed check or a revert on main is a stop; a manual freeze is a hold. */
export function freezeTone(reasons: FreezeReason[]): Tone {
  return reasons.some((r) => r.kind !== "manual") ? "danger" : "warn";
}

/** "Updated just now", "Updated 12 s ago", "Updated 3 min ago". */
export function updatedLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "Updated just now";
  if (s < 60) return `Updated ${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m} min ago`;
  return `Updated ${Math.floor(m / 60)} h ago`;
}

export interface FlakeRow {
  test: string;
  rate: number | null;
  quarantined: boolean;
}

/**
 * Quarantined tests first (they never count as passing), then other flaky targets, each group
 * by flake rate, highest first. A quarantined test with no measured rate keeps `rate: null`.
 */
export function flakeRows(
  quarantined: string[],
  rates: Record<string, number>,
  limit = 8,
): FlakeRow[] {
  const q = new Set(quarantined);
  const rows: FlakeRow[] = [
    ...quarantined.map((test) => ({ test, rate: rates[test] ?? null, quarantined: true })),
    ...Object.entries(rates)
      .filter(([test, rate]) => !q.has(test) && rate > 0)
      .map(([test, rate]) => ({ test, rate, quarantined: false })),
  ];
  const byRate = (a: FlakeRow, b: FlakeRow) => (b.rate ?? -1) - (a.rate ?? -1);
  return [
    ...rows.filter((r) => r.quarantined).sort(byRate),
    ...rows.filter((r) => !r.quarantined).sort(byRate),
  ].slice(0, Math.max(limit, quarantined.length));
}

/** Lookup by change id; the title falls back to the id so a member is never blank. */
export function entryIndex(
  entries: QueueEntryView[],
): (id: string) => { title: string; entry: QueueEntryView | null } {
  const map = new Map(entries.map((e) => [e.changeId, e]));
  return (id) => {
    const entry = map.get(id) ?? null;
    return { title: entry?.title ?? id, entry };
  };
}
