import { describe, expect, it } from "vitest";
import type { QueueEntryView, QueueTrack } from "../src/api/queue.js";
import {
  durationShort,
  entryIndex,
  etaLabel,
  flakeRows,
  freezeTone,
  orderTracks,
  percentLabel,
  splitEntries,
  trackLabel,
  updatedLabel,
} from "../src/lib/queue.js";

const e = (
  changeId: string,
  state: QueueEntryView["state"],
  title: string | null = changeId,
): QueueEntryView => ({
  changeId,
  title,
  authorId: "prn_a",
  priority: "normal",
  lane: 1,
  state,
  hold: null,
  trackId: null,
  batch: null,
  position: null,
  etaSeconds: null,
  blocking: [],
  reason: "",
  predictedPassProbability: null,
  frozen: false,
  enqueuedAt: 0,
  dependsOn: [],
  plangroup: null,
  ejectReason: null,
  mergedSha: null,
  stall: null,
});

describe("etaLabel", () => {
  it("rounds to minutes and hours", () => {
    expect(etaLabel(20)).toBe("under 1 min");
    expect(etaLabel(540)).toBe("~9 min");
    expect(etaLabel(3600)).toBe("~1 h");
    expect(etaLabel(5100)).toBe("~1 h 25 min");
  });

  it("says so when there is no estimate", () => {
    expect(etaLabel(null)).toBe("No estimate");
    expect(etaLabel(-5)).toBe("No estimate");
    expect(etaLabel(Number.NaN)).toBe("No estimate");
  });
});

describe("durationShort", () => {
  it("keeps seconds under ten minutes and drops them above", () => {
    expect(durationShort(45_000)).toBe("45 s");
    expect(durationShort(400_000)).toBe("6 min 40 s");
    expect(durationShort(360_000)).toBe("6 min");
    expect(durationShort(23 * 60_000)).toBe("23 min");
    expect(durationShort(71 * 60_000)).toBe("1 h 11 min");
    expect(durationShort(120 * 60_000)).toBe("2 h");
  });

  it("never renders a missing measurement as a number", () => {
    expect(durationShort(null)).toBe("Not measured");
  });
});

describe("percentLabel", () => {
  it("shows whole percents", () => {
    expect(percentLabel(0.91)).toBe("91%");
    expect(percentLabel(0.426)).toBe("43%");
  });

  it("never rounds an uncertain prediction to certainty", () => {
    expect(percentLabel(0.997)).toBe("99%");
    expect(percentLabel(0.003)).toBe("1%");
    expect(percentLabel(1)).toBe("100%");
    expect(percentLabel(0)).toBe("0%");
  });

  it("labels a missing prediction", () => {
    expect(percentLabel(null)).toBe("Not predicted");
  });
});

describe("trackLabel and orderTracks", () => {
  it("names numbered tracks and the express track", () => {
    expect(trackLabel("2")).toBe("Track 2");
    expect(trackLabel("trk_3")).toBe("Track 3");
    expect(trackLabel("track-04")).toBe("Track 4");
    expect(trackLabel("t1")).toBe("Track 1");
    expect(trackLabel("billing")).toBe("Track billing");
    expect(trackLabel("anything", true)).toBe("Express track");
  });

  it("puts express tracks first and keeps the server order otherwise", () => {
    const t = (id: string, express = false): QueueTrack => ({ id, express, batches: [] });
    expect(orderTracks([t("1"), t("x", true), t("2")]).map((x) => x.id)).toEqual(["x", "1", "2"]);
  });
});

describe("splitEntries and entryIndex", () => {
  const entries = [
    e("a", "speculating"),
    e("b", "merged"),
    e("c", "waiting"),
    e("d", "ejected"),
    e("f", "dequeued"),
  ];

  it("separates active entries from finished ones, keeping order", () => {
    const { active, recent } = splitEntries(entries);
    expect(active.map((x) => x.changeId)).toEqual(["a", "c"]);
    expect(recent.map((x) => x.changeId)).toEqual(["b", "d", "f"]);
  });

  it("falls back to the change id when the title is missing or unknown", () => {
    const find = entryIndex([e("a", "waiting", "Fix it"), e("b", "waiting", null)]);
    expect(find("a").title).toBe("Fix it");
    expect(find("b").title).toBe("b");
    expect(find("zzz")).toEqual({ title: "zzz", entry: null });
  });
});

describe("freezeTone", () => {
  const r = (kind: "post-merge-check" | "revert-in-progress" | "manual") => ({
    kind,
    at: 0,
    sha: null,
    changeId: null,
    signer: null,
    message: "",
  });

  it("is danger for a failing main or a revert, warn for a manual freeze", () => {
    expect(freezeTone([r("revert-in-progress")])).toBe("danger");
    expect(freezeTone([r("manual"), r("post-merge-check")])).toBe("danger");
    expect(freezeTone([r("manual")])).toBe("warn");
  });
});

describe("flakeRows", () => {
  it("lists quarantined tests first, then other flaky ones, each by rate", () => {
    const rows = flakeRows(["q-low", "q-high", "q-unmeasured"], {
      "q-low": 0.05,
      "q-high": 0.2,
      other: 0.1,
      stable: 0,
    });
    expect(rows.map((x) => x.test)).toEqual(["q-high", "q-low", "q-unmeasured", "other"]);
    expect(rows[2]).toEqual({ test: "q-unmeasured", rate: null, quarantined: true });
  });

  it("never drops a quarantined test to fit the limit", () => {
    expect(flakeRows(["a", "b", "c"], { x: 0.3 }, 2).map((x) => x.test)).toEqual(["a", "b", "c"]);
  });
});

describe("updatedLabel", () => {
  it("counts seconds, then minutes", () => {
    expect(updatedLabel(1_000, 3_000)).toBe("Updated just now");
    expect(updatedLabel(0, 12_000)).toBe("Updated 12 s ago");
    expect(updatedLabel(0, 185_000)).toBe("Updated 3 min ago");
  });
});
