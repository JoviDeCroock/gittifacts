/** The calm PR presentation: which stops go inline, the one-line review, the summary's headline. */
import type { Tour, TourStop } from "@app/domain";
import { describe, expect, it } from "vitest";
import { flaggedStops, summaryBody, type SummaryState, tourReview } from "../src/pr-writes.js";

const stop = (over: Partial<TourStop>): TourStop => ({
  kind: "behavior", title: "t", why: "w", verdict: "proven", evidenceRefs: [],
  hunkRefs: [{ file: "src/a.ts", startLine: 3, endLine: 3, side: "head" }], ...over,
});
const tour = (stops: TourStop[]): Tour => ({
  id: "t1", changeId: "gh-1-2", headSha: "a".repeat(40), stops, leastConfident: ["x"], notDone: ["y"],
  generatedBy: { principalId: "p", model: "m", promptVersion: "v", attempts: 1, costUsd: 0 }, createdAt: "2026-10-04T00:00:00.000Z",
});

describe("inline stops", () => {
  it("only risk, not covered and not proven stops with a line, riskiest first, at most 3", () => {
    const t = tour([
      stop({ kind: "intent", verdict: "unproven", title: "intent" }),
      stop({ verdict: "unproven", title: "unproven" }),
      stop({ kind: "proof", verdict: "proven", title: "proof" }),
      stop({ kind: "uncovered", verdict: "unproven", title: "uncovered" }),
      stop({ kind: "risk", verdict: "risk", title: "risk" }),
      stop({ kind: "risk", verdict: "risk", title: "risk without a line", hunkRefs: [] }),
      stop({ verdict: "unproven", title: "unproven 2" }),
    ]);
    expect(flaggedStops(t).map((x) => x.stop.title)).toEqual(["risk", "uncovered", "unproven"]);
  });

  it("no flagged stop, no review; the review body is one line", () => {
    expect(tourReview(tour([stop({}), stop({ kind: "intent", verdict: "unproven" })]), "https://x")).toBeNull();
    const r = tourReview(tour([stop({ kind: "risk", verdict: "risk" })]), "https://x")!;
    expect(r.body).toBe("1 spot worth a look, from the walkthrough of `aaaaaaa`. [All 1 stop on gittifacts](https://x)");
    expect(r.comments).toHaveLength(1);
    // GitHub refused an anchor: the same stops go in the body, still no inline comment.
    const fallback = tourReview(tour([stop({ kind: "risk", verdict: "risk" })]), "https://x", { inline: false })!;
    expect(fallback.comments).toEqual([]);
    expect(fallback.body).toContain("`src/a.ts:3` · **Risk**");
  });
});

describe("summary comment", () => {
  const base: SummaryState = {
    headSha: "b".repeat(40),
    verdict: { lane: 2, computedLane: 2, shadow: false, blocked: false, requiresHumanApproval: false, reasons: [
      { code: "api.breaking", lane: 2, message: "Public API has breaking changes: f." },
      { code: "plan.missing", lane: 1, message: "No plan is attached to this change." },
    ] },
    tour: "ready", stops: 5, flagged: 2, inline: false, qa: null, plan: null, approvals: [], changesRequested: [], fullReview: [],
    detailsUrl: "https://x/changes/gh-1-2", shadow: true,
  };
  const headline = (s: SummaryState) => summaryBody(s).split("<details>")[0]!.trim().split("\n").slice(1);

  it("3–5 lines up top: lane and why, the ask, the walkthrough; the rest folded", () => {
    expect(headline(base)).toEqual([
      "**Full review (Lane 2)** · breaking public API change.  ",
      "A person reads the diff, with the walkthrough as a guide.  ",
      "[Open the walkthrough on gittifacts](https://x/changes/gh-1-2): 5 stops, 2 worth a look.",
    ]);
    expect(summaryBody(base)).toContain("- Lane 1 · no Plan linked");
  });

  it("approvals, changes requested and full-review requests make one status line", () => {
    const s = { ...base, approvals: [{ by: "a", via: "GitHub review" }], fullReview: [{ by: "b" }] };
    expect(headline(s)[2]).toBe("Approved by a (GitHub review). Full review requested by b.  ");
    expect(headline(s).length).toBeLessThanOrEqual(5);
  });

  it("an optional QA section: one line up top, details folded, never a mention or a fake marker", () => {
    const s = { ...base, qa: { status: "3 screens checked, 1 looks off\n(@octo please look)", details: "![home](https://x/a.png) <!-- gittifacts:summary --> cc @octo" } };
    const top = headline(s);
    expect(top.length).toBeLessThanOrEqual(5);
    expect(top.at(-1)).toBe("**QA** · 3 screens checked, 1 looks off (@\u200bocto please look)");
    const body = summaryBody(s);
    expect(body.match(/<!-- gittifacts:summary -->/g)).toHaveLength(1);
    expect(body).toMatch(/<details><summary>QA details<\/summary>\n\n!\[home\]\(https:\/\/x\/a.png\) &lt;!-- gittifacts:summary --> cc @\u200bocto\n\n<\/details>$/);
    expect(summaryBody({ ...base, qa: null })).not.toContain("QA");
  });

  it("grading, blocked and a failed walkthrough say so plainly", () => {
    expect(headline({ ...base, verdict: null, tour: "pending" })[0]).toMatch(/^\*\*gittifacts\*\* is grading `bbbbbbb`/);
    const blocked = { ...base, verdict: { ...base.verdict!, blocked: true, reasons: [{ code: "ci.failed", lane: 2 as const, message: "CI failed." }] } };
    expect(headline(blocked)[0]).toBe("**Blocked: CI failed.** Nothing can merge until it is fixed.  ");
    expect(headline({ ...base, tour: "failed" }).at(-1)).toMatch(/^No walkthrough could be written/);
  });
});
