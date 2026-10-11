/**
 * Mission control's view model (lib/mission.ts): the stage each change is at, which change an
 * agent's row shows, and the header counts. Pure logic; the E2E (web-mission.spec.ts) covers the
 * screen.
 */
import { describe, expect, it } from "vitest";
import type { QueueEntryView, QueueOverviewView } from "../src/api/queue.js";
import type { ChangeSummary } from "../src/api/types.js";
import { missionFrom, stageClock, stageOf } from "../src/lib/mission.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function chg(id: string, over: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    id,
    repoId: "r",
    planId: null,
    title: `Change ${id}`,
    claim: { category: "fix", summary: null },
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    forkName: `${id}-fork`,
    authorId: "a1",
    status: "running",
    computedLane: null,
    lane: null,
    laneReasons: [],
    evidenceId: null,
    tourId: null,
    flagKey: null,
    mergedSha: null,
    rolloutState: null,
    revertOf: null,
    revertedBy: null,
    agentTraceId: null,
    createdAt: iso(60),
    updatedAt: iso(5),
    planTitle: null,
    authorName: "coder-a",
    authorKind: "agent",
    ...over,
  };
}

function entry(changeId: string, over: Partial<QueueEntryView> = {}): QueueEntryView {
  return {
    changeId,
    title: null,
    authorId: "a1",
    priority: "normal",
    lane: 1,
    state: "waiting",
    hold: null,
    trackId: "1",
    batch: null,
    position: 3,
    etaSeconds: null,
    blocking: [],
    reason: "",
    predictedPassProbability: null,
    frozen: false,
    enqueuedAt: NOW - 120_000,
    dependsOn: [],
    plangroup: null,
    ejectReason: null,
    mergedSha: null,
    stall: null,
    ...over,
  };
}

const queue = (entries: QueueEntryView[]) =>
  ({ entries, tracks: [] }) as unknown as QueueOverviewView;

describe("stageOf", () => {
  it("reads the change's own status when it isn't queued", () => {
    expect(stageOf(chg("c", { status: "awaiting-push", headSha: null }), undefined).stage).toBe(
      "started",
    );
    expect(stageOf(chg("c", { status: "awaiting-push" }), undefined).stage).toBe("sent-back");
    expect(stageOf(chg("c", { status: "running" }), undefined).stage).toBe("grading");
    expect(stageOf(chg("c", { status: "running", lane: 1 }), undefined).stage).toBe("lane");
    expect(stageOf(chg("c", { status: "awaiting-review", lane: 2 }), undefined).stage).toBe(
      "review",
    );
    expect(stageOf(chg("c", { status: "failing" }), undefined).stage).toBe("failing");
    expect(stageOf(chg("c", { status: "rolling-out" }), undefined).stage).toBe("merged");
  });

  it("takes position, batch and landing from the queue, timed from the enqueue", () => {
    const q = stageOf(
      chg("c", { status: "awaiting-review" }),
      entry("c", {
        state: "speculating",
        position: 2,
        batch: { id: "b_41", state: "running", size: 2, chainPosition: 1 },
      }),
    );
    expect(q).toMatchObject({ stage: "queued", since: NOW - 120_000 });
    expect(q.detail).toBe("#2 in the queue · batch b_41, CI running");
    expect(stageOf(chg("c"), entry("c", { state: "passed" })).stage).toBe("merging");
    expect(stageOf(chg("c"), entry("c", { state: "merged" })).stage).toBe("merged");
    expect(stageOf(chg("c"), entry("c", { state: "ejected" })).stage).toBe("ejected");
  });
});

describe("missionFrom", () => {
  it("shows each agent's change closest to landing, counts the rest, and skips people", () => {
    const changes = [
      chg("c1", { status: "running" }),
      chg("c2", { status: "awaiting-review", lane: 1 }),
      chg("c3", { status: "awaiting-review", lane: 1 }),
      chg("c4", { authorId: "a2", authorName: "bumper", status: "merged", updatedAt: iso(30) }),
      chg("c5", {
        authorId: "h1",
        authorName: "Maya",
        authorKind: "human",
        status: "awaiting-review",
      }),
    ];
    const { rows, counts } = missionFrom({
      changes,
      queue: queue([entry("c3", { position: 4 })]),
      owners: { a1: "Maya Okafor" },
      now: NOW,
    });
    expect(rows.map((r) => [r.agent.name, r.change.id, r.stage])).toEqual([
      ["bumper", "c4", "merged"],
      ["coder-a", "c3", "queued"],
    ]);
    expect(rows[1]).toMatchObject({
      more: 2,
      agent: { ownerName: "Maya Okafor" },
      queue: { position: 4, trackId: "1" },
    });
    expect(counts).toEqual({ agents: 2, working: 1, inReview: 2, queued: 1, mergedToday: 1 });
  });

  it("marks auto-merge computed while calibrating, and drops agents with nothing today", () => {
    const changes = [
      chg("c1", { computedLane: 0, lane: 1, status: "awaiting-review" }),
      chg("c2", { authorId: "a3", authorName: "old", status: "merged", updatedAt: iso(60 * 30) }),
    ];
    const { rows } = missionFrom({ changes, queue: null, owners: {}, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calibrating: true, queue: null, agent: { ownerName: null } });
  });
});

it("formats the stage clock", () => {
  expect(stageClock(NOW - 42_000, NOW)).toBe("0:42");
  expect(stageClock(NOW - (12 * 60 + 5) * 1000, NOW)).toBe("12:05");
  expect(stageClock(NOW - (3600 + 4 * 60 + 9) * 1000, NOW)).toBe("1:04:09");
  expect(stageClock(NOW + 5000, NOW)).toBe("0:00");
});
