import type { ChangeDiff, DiffHunk } from "@app/domain";
import { describe, expect, it } from "vitest";
import type { MergedPr } from "../src/backtest/listing.js";
import { carryLine, findPatches } from "../src/backtest/patches.js";
import { backtestReport, evidenceLane, type GradedPr } from "../src/backtest/report.js";
import { findReverts } from "../src/backtest/reverts.js";

const sha = (n: number) => ((n * 2654435761) % 0xffffffff).toString(16).padStart(8, "0").repeat(5);
const pr = (n: number, over: Partial<MergedPr> = {}): MergedPr => ({
  number: n, title: `PR ${n}`, body: null, createdAt: `2026-07-${String(n).padStart(2, "0")}T08:00:00Z`,
  mergedAt: `2026-07-${String(n).padStart(2, "0")}T10:00:00Z`, headRefName: `feature-${n}`,
  author: { login: "dev", id: 1, type: "User" }, mergeSha: sha(n), files: [{ path: "src/a.ts", additions: 1, deletions: 1 }],
  labels: [], closingIssues: [], ...over,
});

describe("reverts", () => {
  it("finds GitHub's revert button, Reverts #N, git's message and Revert \"title\"", () => {
    const prs = [
      pr(1, { title: "Add totals" }), pr(2), pr(3), pr(4, { title: "Fix rounding" }),
      pr(5, { headRefName: "revert-1-feature-1", title: 'Revert "Add totals"' }),
      pr(6, { body: "Reverts acme/app#2\n\nBroke prod." }),
      pr(7, { body: `This reverts commit ${sha(3).slice(0, 12)}.` }),
      pr(8, { title: 'Revert "Fix rounding"' }),
    ];
    const r = findReverts(prs, "acme/app");
    expect([...r.entries()].map(([n, l]) => [n, l.by, l.how])).toEqual([[1, 5, "branch"], [2, 6, "body"], [3, 7, "sha"], [4, 8, "title"]]);
  });
});

const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffHunk["lines"]): DiffHunk => ({
  header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, oldStart, oldLines, newStart, newLines, lines,
});

describe("carrying lines to a later commit", () => {
  it("shifts past insertions and deletions above, follows context, drops rewritten lines", () => {
    // Two lines inserted after line 2; line 6 rewritten.
    const hunks = [
      hunk(2, 1, 2, 3, [
        { kind: "ctx", oldNo: 2, newNo: 2, text: "b" },
        { kind: "add", oldNo: null, newNo: 3, text: "x" },
        { kind: "add", oldNo: null, newNo: 4, text: "y" },
      ]),
      hunk(6, 1, 8, 1, [
        { kind: "del", oldNo: 6, newNo: null, text: "f" },
        { kind: "add", oldNo: null, newNo: 8, text: "F" },
      ]),
    ];
    expect(carryLine(1, hunks)).toBe(1);
    expect(carryLine(2, hunks)).toBe(2);
    expect(carryLine(4, hunks)).toBe(6);
    expect(carryLine(6, hunks)).toBeNull();
    expect(carryLine(9, hunks)).toBe(11);
  });
});

describe("patched within 14 days (mirror diffs)", () => {
  const file = (path: string, hunks: DiffHunk[]) => ({ path, previousPath: null, status: "modified" as const, additions: 1, deletions: 1, binary: false, transformVerified: false, hunks, truncated: false });
  const diff = (files: ReturnType<typeof file>[]): ChangeDiff => ({ baseSha: sha(0), headSha: sha(0), files, additions: 1, deletions: 1 });
  // PR 1 adds line 10; PR 2 (2 days later) rewrites line 10; PR 3 (3 days later) touches line 40.
  const own: Record<string, ChangeDiff> = {
    [sha(1)]: diff([file("src/a.ts", [hunk(9, 1, 9, 2, [{ kind: "ctx", oldNo: 9, newNo: 9, text: "" }, { kind: "add", oldNo: null, newNo: 10, text: "bug" }])])]),
    [sha(3)]: diff([file("src/a.ts", [hunk(10, 1, 10, 1, [{ kind: "del", oldNo: 10, newNo: null, text: "bug" }, { kind: "add", oldNo: null, newNo: 10, text: "fix" }])])]),
    [sha(4)]: diff([file("src/a.ts", [hunk(40, 1, 40, 1, [{ kind: "del", oldNo: 40, newNo: null, text: "z" }, { kind: "add", oldNo: null, newNo: 40, text: "Z" }])])]),
  };
  const mirror = {
    parent: async (s: string) => `p${s}`,
    diff: async (base: string, head: string) => (base.startsWith("p") ? (own[head] as ChangeDiff) : diff([])),
  };
  it("a later PR rewriting the lines a PR added patches it; touching other lines doesn't", async () => {
    const prs = [pr(1, { mergeSha: sha(1) }), pr(3, { mergeSha: sha(3) }), pr(4, { mergeSha: sha(4) })];
    const out = await findPatches(prs, mirror, { now: new Date("2026-09-30T00:00:00Z") });
    expect(out.get(1)).toEqual({ by: 3, at: prs[1]?.mergedAt });
    expect(out.get(3)).toBe("none");
    expect(out.get(4)).toBe("none");
    // Inside the 14 days the outcome isn't known yet.
    expect((await findPatches([pr(4, { mergeSha: sha(4) })], mirror, { now: new Date("2026-07-05T00:00:00Z") })).get(4)).toBe("unknown");
  });
});

describe("report and calibration", () => {
  const g = (number: number, lane: 0 | 1 | 2, reasons: GradedPr["reasons"] = []): GradedPr => ({ number, lane, computedLane: lane, blocked: false, requiresHumanApproval: false, reasons });
  it("evidence lane sets aside the Plan requirement and shadow mode, never other reasons", () => {
    expect(evidenceLane(g(1, 1, [{ code: "plan.missing", lane: 1 }, { code: "shadow.lane0-disabled", lane: 1 }]))).toBe(0);
    expect(evidenceLane(g(1, 2, [{ code: "plan.missing", lane: 1 }, { code: "api.breaking", lane: 2 }]))).toBe(2);
  });

  it("counts would-auto-merge, what happened to them, the fastest full reviews; calibration needs clean history", () => {
    const listed = Array.from({ length: 30 }, (_, i) => pr(i + 1));
    const graded = new Map(listed.map((p) => [p.number, g(p.number, 1, p.number % 3 === 0 ? [{ code: "api.breaking", lane: 2 }] : [{ code: "plan.missing", lane: 1 }])]));
    const reverts = new Map([[1, { by: 30, how: "branch" as const, at: "x" }]]);
    const patches = new Map(listed.map((p) => [p.number, "none" as const]));
    const r = backtestReport({ since: new Date("2026-07-01"), until: new Date("2026-09-29"), listed, graded, skipped: [], reverts, patches });
    expect(r.graded).toBe(30);
    expect(r.evidenceLanes).toEqual({ "0": 20, "1": 0, "2": 10 });
    expect(r.wouldAutoMerge).toEqual({ count: 20, percent: 66.7 });
    expect(r.afterwards.reverted).toEqual([{ number: 1, by: 30 }]);
    expect(r.fastFullReviews).toHaveLength(3);
    expect(r.calibration).toMatchObject({ samples: 30, candidates: 20, bad: 1, eligible: false });
    expect(r.calibration.reason).toMatch(/tighten the policy/);
    const clean = backtestReport({ since: new Date("2026-07-01"), until: new Date("2026-09-29"), listed, graded, skipped: [], reverts: new Map(), patches });
    expect(clean.calibration).toMatchObject({ bad: 0, eligible: true });
  });
});
