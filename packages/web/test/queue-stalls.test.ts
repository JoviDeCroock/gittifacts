/**
 * The queue view never hides a stall (journey 06, take 1): the banner says what stopped, why
 * (error class and redacted message), what happens next and when; held Changes show no ETA.
 */
import { h } from "preact";
import prerender from "preact-iso/prerender";
import { describe, expect, it } from "vitest";
import { mockQueueOverview } from "../src/api/mock-queue.js";
import { parseQueueOverview, type QueueStall } from "../src/api/queue.js";
import { QueueEntries } from "../src/components/QueueEntries.js";
import { QueueStalls } from "../src/components/QueueStalls.js";
import { attemptsLabel, inLabel, stallNextLabel, stallTone } from "../src/lib/queue.js";

/** Rendered HTML without preact-iso's empty hydration script. */
async function html(vnode: Parameters<typeof prerender>[0]): Promise<string> {
  return (await prerender(vnode)).html.replace('<script type="isodata"></script>', "");
}

const NOW = Date.UTC(2026, 9, 3, 9, 30, 0);
const base: QueueStall = {
  state: "retrying",
  what: "Building the batch tree",
  command: "BuildBatchTree",
  batchId: "b3",
  changeIds: ["c1"],
  attempts: 2,
  maxAttempts: 6,
  error: { errorClass: "TypeError", message: "fetch failed" },
  since: null,
  next: { kind: "retry", at: NOW + 40_000 },
};

describe("stall wording", () => {
  it("says when the next automatic step happens, or who has to act", () => {
    expect(stallNextLabel(base.next, NOW)).toMatch(/^Retries automatically at .+ \(in 40 s\)$/);
    expect(stallNextLabel({ kind: "rebuild", at: NOW + 8 * 60_000 }, NOW)).toMatch(
      /^Rebuilt automatically at .+ \(in 8 min\), and a person is notified$/,
    );
    expect(stallNextLabel({ kind: "rebuild", at: null }, NOW)).toBe("Rebuilding the batch now");
    expect(stallNextLabel({ kind: "rebuild", at: NOW - 1 }, NOW)).toBe("Rebuilding the batch now");
    expect(stallNextLabel({ kind: "human", message: "approve it" }, NOW)).toBe(
      "Needs a person: approve it",
    );
    expect(inLabel(NOW - 5, NOW)).toBe("now");
    expect(attemptsLabel(base)).toBe("2 of 6 attempts failed");
    expect(attemptsLabel({ ...base, attempts: 0 })).toBe("No failed attempt recorded");
  });
  it("is a warning while retrying and a stop once anything stopped or needs a person", () => {
    expect(stallTone([base])).toBe("warn");
    expect(stallTone([base, { ...base, state: "stalled" }])).toBe("danger");
    expect(stallTone([{ ...base, state: "needs-human" }])).toBe("danger");
  });
});

describe("the stalled queue view", () => {
  it("shows the stall with its reason and next step, and no ETA for the Changes it holds", async () => {
    const q = parseQueueOverview(
      await mockQueueOverview("repo_billing", { frozen: false, halted: false, stalled: true }),
    );
    const banner = await html(h(QueueStalls, { q, now: q.updatedAt }));
    expect(banner).toContain("Queue stalled");
    expect(banner).toContain("WorkflowInternalError");
    expect(banner).toContain("Rebuilt automatically at");
    expect(banner).toContain("Retries automatically at");
    const held = q.entries.find((e) => e.changeId === "chg_cm6t3");
    expect(held?.stall).toBe("stalled");
    expect(held?.etaSeconds).toBeNull();
    const rows = await html(h(QueueEntries, { q, now: q.updatedAt }));
    expect(rows).toContain("None while stalled");
    expect(rows).toContain("Waits on a person");
  });
  it("renders nothing when everything moves, and older servers without stalls still parse", async () => {
    const raw = (await mockQueueOverview("repo_billing", {
      frozen: false,
      halted: false,
      stalled: false,
    })) as Record<string, unknown>;
    const { stalls: _drop, ...older } = raw;
    const q = parseQueueOverview({
      ...older,
      entries: (older.entries as Record<string, unknown>[]).map(({ stall: _s, ...e }) => e),
    });
    expect(q.stalls).toEqual([]);
    expect(q.entries.every((e) => e.stall === null)).toBe(true);
    expect(await html(h(QueueStalls, { q, now: q.updatedAt }))).toBe("");
  });
});
