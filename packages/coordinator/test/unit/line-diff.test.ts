import { describe, expect, it } from "vitest";
import {
  applyEdits,
  diffLines,
  diffText,
  splitLines,
  toHunks,
} from "../../src/adapters/line-diff.js";

const lines = (s: string) => (s === "" ? [] : s.split(""));

describe("diffLines (Myers)", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["abc", "abc"],
    ["", "abc"],
    ["abc", ""],
    ["abcabba", "cbabac"],
    ["abcdef", "abxdef"],
    ["xaaaay", "xaaay"],
    ["aaaa", "bbbb"],
    ["abcd", "dcba"],
    ["the quick brown fox", "the quack brown fix"],
  ];
  it.each(cases)("%j → %j round-trips with a minimal script", (a, b) => {
    const [x, y] = [lines(a), lines(b)];
    const edits = diffLines(x, y);
    expect(applyEdits(x, y, edits)).toEqual(y);
    // Old side is consumed in order too.
    const olds = edits.filter((e) => e.kind !== "add").map((e) => e.oldIndex);
    expect(olds).toEqual(x.map((_, i) => i));
  });

  it("finds the classic minimal edit distance (abcabba → cbabac = 5)", () => {
    const edits = diffLines(lines("abcabba"), lines("cbabac"));
    expect(edits.filter((e) => e.kind !== "eq")).toHaveLength(5);
  });

  it("falls back to replacing the middle block past maxEditDistance (over-reports, never under)", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const edits = diffLines(["head", ...a, "tail"], ["head", ...b, "tail"], {
      maxEditDistance: 10,
    });
    expect(edits.filter((e) => e.kind === "del")).toHaveLength(50);
    expect(edits.filter((e) => e.kind === "add")).toHaveLength(50);
    expect(applyEdits(["head", ...a, "tail"], ["head", ...b, "tail"], edits)).toEqual([
      "head",
      ...b,
      "tail",
    ]);
  });
});

describe("hunks", () => {
  it("produces git-style headers with 3 lines of context", () => {
    const old = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const neu = old.replace("line 10\n", "line ten\n");
    const d = diffText(old, neu);
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]?.header).toBe("@@ -7,7 +7,7 @@");
    expect(d.hunks[0]?.lines.map((l) => l.kind)).toEqual([
      "ctx",
      "ctx",
      "ctx",
      "del",
      "add",
      "ctx",
      "ctx",
      "ctx",
    ]);
    expect(d.hunks[0]?.lines[3]).toEqual({ kind: "del", oldNo: 10, newNo: null, text: "line 10" });
    expect(d.hunks[0]?.lines[4]).toEqual({ kind: "add", oldNo: null, newNo: 10, text: "line ten" });
  });

  it("merges nearby changes and splits distant ones", () => {
    const old = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const near = [...old];
    near[5] = "x";
    near[9] = "y";
    expect(toHunks(old, near, diffLines(old, near)).hunks).toHaveLength(1);
    const far = [...old];
    far[2] = "x";
    far[30] = "y";
    expect(toHunks(old, far, diffLines(old, far)).hunks).toHaveLength(2);
  });

  it("new and deleted files use 0-line sides", () => {
    expect(diffText("", "a\nb\n").hunks[0]?.header).toBe("@@ -0,0 +1,2 @@");
    expect(diffText("a\nb\n", "").hunks[0]?.header).toBe("@@ -1,2 +0,0 @@");
  });

  it("a missing final newline is a change", () => {
    expect(splitLines("a\nb")).toHaveLength(2);
    const d = diffText("a\nb\n", "a\nb");
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.hunks[0]?.lines.find((l) => l.kind === "add")?.text).toBe("b");
  });

  it("identical texts have no hunks", () => {
    expect(diffText("same\n", "same\n")).toEqual({ hunks: [], additions: 0, deletions: 0 });
  });
});
