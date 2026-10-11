import { AuditEvent, LinkedIssue } from "@app/domain";
import { describe, expect, it } from "vitest";
import { TRAIN_SCENARIOS } from "../src/api/scenarios-trains.js";
import type { TimelineEvent } from "../src/api/types.js";
import { detectionSentence, findIncident, healthGapCopy, signalOf, timelineRows } from "../src/lib/rollout-incident.js";
import { formatClock, formatWhenPrecise, spanLabel } from "../src/lib/time.js";

const T0 = Date.parse("2026-10-03T09:03:00.000Z");
let seq = 830;
function ev(ms: number, action: string, summary?: string, subject = "change:c1"): TimelineEvent {
  return { seq: seq++, at: new Date(T0 + ms).toISOString(), principalId: "system", action, subject, payloadHash: "p", prevHash: "q", hash: "h", signature: "s", keyId: "k", ...(summary ? { summary } : {}) };
}
const issue = (firstMs: number): LinkedIssue => ({ id: "iss1", changeId: "c1", title: "m4 regression · at / (index.js)", count: 6, firstSeen: new Date(T0 + firstMs).toISOString(), lastSeen: new Date(T0 + firstMs + 30_000).toISOString(), versionId: "v1", url: null });

// The live M4 run 8 (STATUS.md): first 5xx +161.7 s, poll detection +185.6 s, flag off +0.1 s,
// rollback +1.1 s, revert opened +6.8 s after the detection.
const run8 = () => [
  ev(0, "change.merged", "Merged as abc1234"),
  ev(3_200, "rollout.via-train"),
  ev(185_600, "deploy.regression-attributed", "Regression attributed in train t2, seen by the Workers Logs poll (telemetry-t2-1)"),
  ev(185_700, "deploy.flag-off"),
  ev(186_700, "rollout.rolled-back", "Rolled back to the previous version"),
  ev(192_400, "change.revert-opened", "Revert change rv-1 opened"),
];

describe("findIncident", () => {
  it("times every automatic step to the tenth of a second", () => {
    const inc = findIncident(run8(), [issue(161_700)]);
    expect(inc?.signal).toBe("workers-logs");
    expect(inc?.detectedAfterMs).toBe(23_900);
    expect(inc?.steps.map((s) => [s.key, spanLabel(s.afterMs)])).toEqual([
      ["flag", "0.1 s"],
      ["rollback", "1.1 s"],
      ["revert", "6.8 s"],
    ]);
    expect(detectionSentence(inc!, spanLabel)).toBe("The Workers Logs poll detected the regression 23.9 s after the first error.");
  });

  it("names Workers Issues when the webhook won, and knows no signal it cannot read", () => {
    expect(signalOf(ev(0, "deploy.regression-attributed", "Regression attributed in train t5, seen by Workers Issues (issue abc)"))).toBe("workers-issues");
    expect(signalOf(ev(0, "deploy.regression-attributed"))).toBeNull();
    expect(signalOf(ev(0, "rollout.regression", "Error rate 3.1% exceeded the 1.0% limit"))).toBe("health-check");
    expect(signalOf(ev(0, "rollout.killed"))).toBe("person");
  });

  it("ignores issues that came after the detection or long before it", () => {
    expect(findIncident(run8(), [issue(190_000)])?.firstError).toBeNull();
    expect(findIncident(run8(), [issue(185_600 - 16 * 60_000)])?.firstError).toBeNull();
  });

  it("is null for a rollout that was never stopped", () => {
    expect(findIncident([ev(0, "change.merged"), ev(5_000, "rollout.released")], [])).toBeNull();
  });
});

describe("the health panel's copy without a stored sample", () => {
  it("says what stopped the rollout instead of 'no result was recorded'", () => {
    const inc = findIncident(run8(), [issue(161_700)])!;
    const copy = healthGapCopy(inc, formatClock);
    expect(copy).toContain("Health monitoring stopped this rollout: the Workers Logs poll reported the regression at");
    expect(copy).not.toMatch(/No health check result/);
  });
});

describe("timelineRows", () => {
  it("adds the first error and the revert's landing, newest first, with offsets after the detection", () => {
    const events = run8();
    const revert = [ev(192_900, "change.revert-verified", undefined, "change:rv-1"), ev(273_900, "change.merged", undefined, "change:rv-1")];
    const rows = timelineRows(events, revert, findIncident(events, [issue(161_700)]));
    expect(rows.map((r) => [r.label, r.afterMs === null ? null : spanLabel(r.afterMs)])).toEqual([
      ["Revert merged into main", "1 min 28 s"],
      ["Revert change opened", "6.8 s"],
      ["Rolled back to the previous version", "1.1 s"],
      ["Flag turned off", "0.1 s"],
      ["Regression traced to this change", "0.0 s"],
      ["First error in production", null],
      ["Rolling out in a deploy batch", null],
      ["Merged into main", null],
    ]);
    expect(rows.find((r) => r.action === "deploy.regression-attributed")?.detail).toContain("Workers Logs poll");
    expect(rows.find((r) => r.source === "issue")).toMatchObject({ seq: null, bad: true, actorId: null });
    expect(rows.find((r) => r.action === "deploy.flag-off")?.actorId).toBe("system");
  });

  it("says which stage: the percent the server names, else the nth stage of the rollout", () => {
    const stages = [{ percent: 5 }, { percent: 25 }, { percent: 100 }];
    const server = [ev(0, "rollout.stage", "Stage 5% started"), ev(60_000, "rollout.stage", "Stage 25% started"), ev(120_000, "rollout.watching")];
    expect(timelineRows(server, [], null, stages).map((r) => r.label)).toEqual(["Watch window opened", "Moved to 25%", "Started at 5%"]);
    const unnamed = [ev(0, "rollout.stage.started"), ev(60_000, "rollout.stage.completed"), ev(60_000, "rollout.stage.started")];
    expect(timelineRows(unnamed, [], null, stages).map((r) => r.label)).toEqual(["Moved to 25%", "Finished 5%", "Started at 5%"]);
    // No stages and no percent: the plain label, never a guess.
    expect(timelineRows([ev(0, "rollout.stage.completed")], [], null).map((r) => r.label)).toEqual(["Stage completed"]);
  });
});

describe("second-level times", () => {
  it("formats clock times and spans", () => {
    const iso = "2026-10-03T09:06:12.300Z";
    expect(formatClock(iso)).toMatch(/^\d\d:\d\d:12$/);
    expect(formatWhenPrecise(iso, Date.parse(iso) + 3_600_000)).toBe(formatClock(iso));
    expect(formatWhenPrecise(iso, Date.parse(iso) + 3 * 86_400_000)).toMatch(/^Oct 3, \d\d:\d\d:12$/);
    expect(spanLabel(40)).toBe("0.0 s");
    expect(spanLabel(100)).toBe("0.1 s");
    expect(spanLabel(23_900)).toBe("23.9 s");
    expect(spanLabel(81_500)).toBe("1 min 22 s");
  });
});

describe("the train rollback fixture", () => {
  it("is valid audit data timed like M4 run 8", () => {
    for (const s of TRAIN_SCENARIOS) for (const e of s.timeline ?? []) expect(AuditEvent.safeParse(e).success).toBe(true);
    const [change] = TRAIN_SCENARIOS;
    const inc = findIncident(change!.timeline ?? [], change!.issues);
    expect(inc?.detectedAfterMs).toBe(23_900);
    expect(inc?.steps.map((s) => s.afterMs)).toEqual([100, 1_100, 6_800]);
  });
});
