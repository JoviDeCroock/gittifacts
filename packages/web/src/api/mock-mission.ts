/**
 * Demo only: mission control's board moves while you watch. From the first load, a short script
 * moves billing-api's agents on (a lane assigned, a walkthrough ready, an approval joining the
 * queue, batch b_41 landing, a sent-back change pushed again), then holds. Nothing is written to
 * the mock backend; the script is applied to each fetched copy. `?still` holds the opening state;
 * `?t=26` starts 26 seconds in (screenshots).
 */
import type { QueueEntryView } from "./queue.js";
import type { MissionData } from "./mission.js";

type Step = { at: number; apply: (d: MissionData, when: string, whenMs: number) => void };

const S = 1000;

function change(d: MissionData, id: string): MissionData["changes"][number] | undefined {
  return d.changes.find((c) => c.id === id);
}

function entries(d: MissionData, ids: string[]): QueueEntryView[] {
  return (d.queue?.entries ?? []).filter((e) => ids.includes(e.changeId));
}

const B41 = ["chg_tz7k2", "chg_lc3m9"];

const SCRIPT: Step[] = [
  {
    at: 5 * S,
    apply: (d, when) => {
      const c = change(d, "chg_db7z2");
      if (c) Object.assign(c, { computedLane: 0, lane: 1, updatedAt: when });
    },
  },
  {
    at: 10 * S,
    apply: (d, when) => {
      const c = change(d, "chg_pt2c9");
      if (c) Object.assign(c, { status: "awaiting-review", updatedAt: when });
    },
  },
  {
    at: 15 * S,
    apply: (d, when, whenMs) => {
      const c = change(d, "chg_fc9w3");
      if (!c || !d.queue) return;
      Object.assign(c, { status: "queued", updatedAt: when });
      const last = Math.max(0, ...d.queue.entries.map((e) => e.position ?? 0));
      d.queue.entries.push({
        changeId: c.id, title: c.title, authorId: c.authorId, priority: "normal", lane: 1, state: "waiting", hold: null,
        trackId: "1", batch: null, position: last + 1, etaSeconds: 900, blocking: [], reason: "Waiting for the next batch on track 1.",
        predictedPassProbability: 0.9, frozen: false, enqueuedAt: whenMs, dependsOn: [], plangroup: null, ejectReason: null,
        mergedSha: null, stall: null,
      });
    },
  },
  {
    at: 20 * S,
    apply: (d) => {
      for (const e of entries(d, B41)) Object.assign(e, { state: "passed", batch: e.batch && { ...e.batch, state: "passed" } });
      for (const t of d.queue?.tracks ?? []) for (const b of t.batches) if (b.id === "b_41") b.state = "passed";
    },
  },
  {
    at: 26 * S,
    apply: (d, when) => {
      for (const e of entries(d, B41)) Object.assign(e, { state: "merged", position: null, batch: null });
      for (const id of B41) {
        const c = change(d, id);
        if (c) Object.assign(c, { status: "merged", updatedAt: when });
      }
      for (const t of d.queue?.tracks ?? []) t.batches = t.batches.filter((b) => b.id !== "b_41");
    },
  },
  {
    at: 32 * S,
    apply: (d, when) => {
      const c = change(d, "chg_tg3p5");
      if (c) Object.assign(c, { status: "running", lane: null, computedLane: null, updatedAt: when });
    },
  },
  {
    at: 38 * S,
    apply: (d, when) => {
      const c = change(d, "chg_db7z2");
      if (c) Object.assign(c, { status: "awaiting-review", updatedAt: when });
    },
  },
  {
    at: 44 * S,
    apply: (d, when) => {
      const c = change(d, "chg_tg3p5");
      if (c) Object.assign(c, { lane: 1, computedLane: 1, updatedAt: when });
    },
  },
];

let startedAt: number | null = null;

function offset(): { still: boolean; skip: number } {
  if (typeof window === "undefined") return { still: true, skip: 0 };
  const q = new URLSearchParams(window.location.search);
  const t = Number(q.get("t"));
  return { still: q.has("still"), skip: Number.isFinite(t) && t > 0 ? t * S : 0 };
}

/** The fetched data with every script step that is due applied, in order. */
export function playMissionScript(data: MissionData, now = Date.now()): MissionData {
  const { still, skip } = offset();
  if (startedAt === null) startedAt = now - skip;
  const elapsed = still ? skip : now - startedAt;
  const d = structuredClone(data);
  for (const step of SCRIPT) {
    if (step.at > elapsed) break;
    const whenMs = startedAt + step.at;
    step.apply(d, new Date(whenMs).toISOString(), whenMs);
  }
  return d;
}
