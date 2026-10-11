/**
 * Mission control: every agent working on a repo, one row each, with the change it is closest to
 * landing, where that change is (pushed, grading, lane assigned, in review, queued, merging,
 * merged, sent back) and for how long. Pure: built from the repo's changes and its merge queue,
 * both read from the existing APIs; `now` is passed in.
 *
 * The queue is authoritative for queued changes (position, batch, landing); a missing queue only
 * leaves those details out, it never moves a change forward.
 */
import type { Lane } from "@app/domain";
import type { QueueEntryView, QueueOverviewView } from "../api/queue.js";
import type { ChangeSummary } from "../api/types.js";

export type Stage =
  | "started"
  | "sent-back"
  | "grading"
  | "failing"
  | "lane"
  | "review"
  | "approved"
  | "queued"
  | "ejected"
  | "merging"
  | "merged"
  | "closed";

/** The five stations a change passes; `step` is the station a stage sits at (5: past the last). */
export const STATIONS = ["Push", "Grade", "Review", "Queue", "Merge"] as const;

export type StageTone = "neutral" | "person" | "danger" | "done";

export const STAGE: Record<
  Stage,
  { label: string; step: number; tone: StageTone; working: boolean }
> = {
  started: { label: "Started", step: 0, tone: "neutral", working: true },
  "sent-back": { label: "Sent back", step: 0, tone: "neutral", working: true },
  grading: { label: "Grading", step: 1, tone: "neutral", working: true },
  failing: { label: "Checks failing", step: 1, tone: "danger", working: false },
  lane: { label: "Lane assigned", step: 1, tone: "neutral", working: true },
  review: { label: "In review", step: 2, tone: "person", working: false },
  approved: { label: "Approved", step: 3, tone: "neutral", working: true },
  queued: { label: "Queued", step: 3, tone: "neutral", working: true },
  ejected: { label: "Ejected from queue", step: 3, tone: "danger", working: false },
  merging: { label: "Merging", step: 4, tone: "neutral", working: true },
  merged: { label: "Merged", step: 5, tone: "done", working: false },
  closed: { label: "Closed", step: 5, tone: "neutral", working: false },
};

/** Closest to landing first: which of an agent's changes its row shows. */
const RANK: Record<Stage, number> = {
  merging: 0,
  queued: 1,
  approved: 2,
  review: 3,
  lane: 4,
  grading: 5,
  "sent-back": 6,
  started: 7,
  ejected: 8,
  failing: 9,
  merged: 10,
  closed: 11,
};

export interface MissionRow {
  agent: { id: string; name: string; ownerName: string | null };
  change: { id: string; title: string; category: string };
  stage: Stage;
  /** Readable detail for the stage ("#2 in the queue · batch b_41, CI running"). */
  detail: string;
  lane: Lane | null;
  /** Auto-merge computed while the repo calibrates: routed to a person, dashed tag. */
  calibrating: boolean;
  queue: { position: number | null; batchId: string | null; trackId: string | null } | null;
  /** epoch ms the change entered this stage (best known). */
  since: number;
  /** The agent's other changes still in flight. */
  more: number;
}

export interface MissionCounts {
  agents: number;
  working: number;
  inReview: number;
  queued: number;
  mergedToday: number;
}

export interface MissionInput {
  changes: ChangeSummary[];
  queue: QueueOverviewView | null;
  /** Owner names by agent id, where known. */
  owners: Record<string, string | null>;
  now: number;
}

const ACTIVE_ENTRY = new Set<QueueEntryView["state"]>([
  "waiting",
  "speculating",
  "resolving",
  "passed",
]);
const LANDING_BATCH = new Set(["passed", "landing", "landed"]);
const CLOSED = new Set(["reverted", "rejected", "abandoned"]);

/** A change's stage, its detail line and since when, with the queue entry when it has one. */
export function stageOf(
  c: ChangeSummary,
  entry: QueueEntryView | undefined,
): { stage: Stage; detail: string; since: number } {
  const updated = Date.parse(c.updatedAt);
  if (entry && (ACTIVE_ENTRY.has(entry.state) || entry.state === "ejected")) {
    const since = entry.enqueuedAt;
    if (entry.state === "ejected")
      return {
        stage: "ejected",
        detail: entry.ejectReason?.message ?? entry.reason,
        since: updated,
      };
    const batch = entry.batch;
    if (entry.state === "passed" || (batch && LANDING_BATCH.has(batch.state)))
      return {
        stage: "merging",
        detail: batch ? `Batch ${batch.id} passed, landing on main` : "Passed, landing on main",
        since,
      };
    const pos = entry.position === null ? "" : `#${entry.position} in the queue`;
    const what =
      entry.state === "resolving"
        ? "resolving a conflict"
        : entry.hold
          ? `held: ${entry.hold}`
          : batch
            ? `batch ${batch.id}, ${batch.state === "running" ? "CI running" : batch.state}`
            : "waiting for a batch";
    return { stage: "queued", detail: [pos, what].filter(Boolean).join(" · "), since };
  }
  if (
    entry?.state === "merged" ||
    c.status === "merged" ||
    c.status === "rolling-out" ||
    c.status === "released"
  ) {
    const tail =
      c.status === "rolling-out" ? "rolling out" : c.status === "released" ? "released" : "on main";
    return { stage: "merged", detail: `Merged, ${tail}`, since: updated };
  }
  if (CLOSED.has(c.status))
    return {
      stage: "closed",
      detail:
        c.status === "reverted" ? "Reverted" : c.status === "rejected" ? "Rejected" : "Abandoned",
      since: updated,
    };
  switch (c.status) {
    case "awaiting-push":
      return c.headSha
        ? {
            stage: "sent-back",
            detail: "A reviewer asked for changes; the next push is graded again",
            since: updated,
          }
        : { stage: "started", detail: "Fork open, waiting for the first push", since: updated };
    case "running":
      return c.lane === null
        ? {
            stage: "grading",
            detail: "Checks, tests and signed evidence on the pushed head",
            since: updated,
          }
        : {
            stage: "lane",
            detail: "Routed; the reviewer agent is writing the walkthrough",
            since: updated,
          };
    case "failing":
      return { stage: "failing", detail: "A check failed; the agent pushes a fix", since: updated };
    case "awaiting-review":
      return {
        stage: "review",
        detail: "The walkthrough is ready; waits on a person",
        since: updated,
      };
    case "approved":
    case "queued":
      return { stage: "approved", detail: "Approved, joining the merge queue", since: updated };
    default:
      return { stage: "closed", detail: c.status, since: updated };
  }
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** One row per agent author with a change in flight or merged today, in a stable (name) order. */
export function missionFrom({ changes, queue, owners, now }: MissionInput): {
  rows: MissionRow[];
  counts: MissionCounts;
} {
  const entries = new Map((queue?.entries ?? []).map((e) => [e.changeId, e]));
  const staged = changes.map((c) => ({ c, ...stageOf(c, entries.get(c.id)) }));
  const byAgent = new Map<string, typeof staged>();
  for (const s of staged) {
    if (s.c.authorKind !== "agent") continue;
    const recent = STAGE[s.stage].step < 5 || sameDay(s.since, now);
    if (!recent) continue;
    byAgent.set(s.c.authorId, [...(byAgent.get(s.c.authorId) ?? []), s]);
  }
  const rows: MissionRow[] = [];
  for (const [id, list] of byAgent) {
    const pick = [...list].sort(
      (a, b) =>
        RANK[a.stage] - RANK[b.stage] ||
        (entries.get(a.c.id)?.position ?? Number.POSITIVE_INFINITY) -
          (entries.get(b.c.id)?.position ?? Number.POSITIVE_INFINITY) ||
        b.since - a.since,
    )[0];
    if (!pick) continue;
    const e = entries.get(pick.c.id);
    const inQueue = pick.stage === "queued" || pick.stage === "merging";
    rows.push({
      agent: { id, name: pick.c.authorName, ownerName: owners[id] ?? null },
      change: { id: pick.c.id, title: pick.c.title, category: pick.c.claim.category },
      stage: pick.stage,
      detail: pick.detail,
      lane: pick.c.lane,
      calibrating: pick.c.computedLane === 0 && pick.c.lane !== 0,
      queue:
        inQueue && e
          ? { position: e.position, batchId: e.batch?.id ?? null, trackId: e.trackId }
          : null,
      since: pick.since,
      more: list.filter((s) => s !== pick && STAGE[s.stage].step < 5).length,
    });
  }
  rows.sort((a, b) => a.agent.name.localeCompare(b.agent.name));
  const active = staged.filter((s) => STAGE[s.stage].step < 5);
  return {
    rows,
    counts: {
      agents: rows.length,
      working: rows.filter((r) => STAGE[r.stage].working).length,
      inReview: active.filter((s) => s.stage === "review").length,
      queued: active.filter((s) => s.stage === "queued" || s.stage === "merging").length,
      mergedToday: staged.filter((s) => s.stage === "merged" && sameDay(s.since, now)).length,
    },
  };
}

/** A stage clock: "0:42", "12:05", "1:04:09". */
export function stageClock(since: number, now: number): string {
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
