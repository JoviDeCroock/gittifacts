import type { CommitSummary } from "@app/domain";
import { describe, expect, it } from "vitest";
import {
  activityGrid,
  blobHref,
  commitsByDay,
  dayLabel,
  formatBytes,
  pathCrumbs,
  splitLines,
  treeHref,
  weeklyTotals,
} from "../src/lib/code.js";

describe("code hrefs and paths", () => {
  it("encodes each segment and adds a ref only when given", () => {
    expect(treeHref("r1")).toBe("/repos/r1/tree");
    expect(treeHref("r1", "src/lib/", "v1")).toBe("/repos/r1/tree/src/lib?ref=v1");
    expect(blobHref("r1", "a b/#x.ts")).toBe("/repos/r1/blob/a%20b/%23x.ts");
    expect(pathCrumbs("src/lib/a.ts")).toEqual([
      { name: "src", path: "src" },
      { name: "lib", path: "src/lib" },
      { name: "a.ts", path: "src/lib/a.ts" },
    ]);
  });

  it("formats sizes and splits lines without a phantom last line", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([""]);
  });
});

describe("activity", () => {
  // Two whole weeks from Monday 2026-09-28, the second partial (to Wednesday 2026-10-07).
  const days = Array.from({ length: 10 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10),
    commits: [0, 1, 0, 0, 8, 0, 0, 0, 2, 4][i] ?? 0,
  }));

  it("lays days into Monday-first week columns with quarter levels", () => {
    const g = activityGrid({ days });
    expect(g.max).toBe(8);
    expect(g.weeks).toHaveLength(2);
    expect(g.weeks[0]?.map((c) => c?.level)).toEqual([0, 1, 0, 0, 4, 0, 0]);
    expect(g.weeks[1]?.map((c) => c?.level ?? null)).toEqual([0, 1, 2, null, null, null, null]);
    expect(g.months).toEqual([
      { column: 0, label: "Sep" },
      { column: 1, label: "Oct" },
    ]);
    expect(weeklyTotals({ days })).toEqual([
      { week: "2026-09-28", commits: 9 },
      { week: "2026-10-05", commits: 6 },
    ]);
    expect(dayLabel("2026-10-12")).toBe("Mon 12 Oct 2026");
  });

  it("groups commits by the UTC day they landed, keeping log order", () => {
    const c = (sha: string, at: string | null) =>
      ({
        sha,
        committer: { name: "", email: "", at },
        author: { name: "", email: "", at: null },
      }) as unknown as CommitSummary;
    const groups = commitsByDay([
      c("a", "2026-10-12T20:00:00Z"),
      c("b", "2026-10-12T01:00:00Z"),
      c("c", "2026-10-10T09:00:00Z"),
      c("d", null),
    ]);
    expect(groups.map((g) => [g.date, g.commits.map((x) => x.sha)])).toEqual([
      ["2026-10-12", ["a", "b"]],
      ["2026-10-10", ["c"]],
      [null, ["d"]],
    ]);
  });
});
