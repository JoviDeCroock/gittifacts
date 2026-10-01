import { describe, expect, it } from "vitest";
import type { ChangeDiff } from "../src/api/types.js";
import { compressLines, excerptForRef, fileStats, hunkFromText, splitPath, tokenize } from "../src/lib/diff.js";

const hunk = hunkFromText(
  10,
  10,
  `
 function a() {
-  return 1;
+  const x = 2;
+  return x;
 }
 
 function b() {
-  return "old";
+  return "new";
 }`,
);

const diff: ChangeDiff = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  additions: 3,
  deletions: 2,
  files: [
    {
      path: "src/x.ts",
      previousPath: null,
      status: "modified",
      ...fileStats([hunk]),
      binary: false,
      transformVerified: false,
      truncated: false,
      hunks: [hunk],
    },
  ],
};

describe("hunkFromText", () => {
  it("numbers lines on both sides and counts them", () => {
    expect(hunk.header).toBe("@@ -10,7 +10,8 @@");
    expect(hunk.lines[0]).toEqual({ kind: "ctx", oldNo: 10, newNo: 10, text: "function a() {" });
    expect(hunk.lines[1]).toEqual({ kind: "del", oldNo: 11, newNo: null, text: "  return 1;" });
    expect(hunk.lines[2]).toEqual({ kind: "add", oldNo: null, newNo: 11, text: "  const x = 2;" });
    expect(hunk.lines.at(-1)).toEqual({ kind: "ctx", oldNo: 16, newNo: 17, text: "}" });
  });

  it("treats a blank row as an empty context line", () => {
    expect(hunk.lines[5]).toEqual({ kind: "ctx", oldNo: 13, newNo: 14, text: "" });
  });

  it("reports additions and deletions", () => {
    expect(fileStats([hunk])).toEqual({ additions: 3, deletions: 2 });
  });
});

describe("excerptForRef", () => {
  it("cuts the cited head lines plus context, pulling in the deletions they replace", () => {
    const ex = excerptForRef(diff, { file: "src/x.ts", startLine: 11, endLine: 12, side: "head" }, 1);
    expect(ex?.missing).toBe(false);
    const rows = ex?.rows.filter((r) => r.type === "line") ?? [];
    expect(rows.map((r) => (r.type === "line" ? r.line.text : ""))).toEqual([
      "function a() {",
      "  return 1;",
      "  const x = 2;",
      "  return x;",
      "}",
    ]);
    const cited = rows.filter((r) => r.type === "line" && r.cited).map((r) => (r.type === "line" ? r.line.kind : ""));
    expect(cited).toEqual(["del", "add", "add"]);
  });

  it("cites deleted lines by their base-side numbers", () => {
    const ex = excerptForRef(diff, { file: "src/x.ts", startLine: 15, endLine: 15, side: "base" }, 0);
    const cited = ex?.rows.filter((r) => r.type === "line" && r.cited) ?? [];
    expect(cited).toHaveLength(1);
    expect(cited[0]?.type === "line" && cited[0].line.text).toBe('  return "old";');
  });

  it("returns null for a file outside the diff and missing for lines outside it", () => {
    expect(excerptForRef(diff, { file: "nope.ts", startLine: 1, endLine: 2, side: "head" })).toBeNull();
    expect(excerptForRef(diff, { file: "src/x.ts", startLine: 400, endLine: 410, side: "head" })?.missing).toBe(true);
  });
});

describe("tokenize", () => {
  it("separates keywords, strings, numbers and comments without losing text", () => {
    const line = 'const ttl = 12 * 60; // "hours"';
    const tokens = tokenize(line);
    expect(tokens.map((t) => t.text).join("")).toBe(line);
    expect(tokens.find((t) => t.text === "const")?.kind).toBe("keyword");
    expect(tokens.find((t) => t.text === "12")?.kind).toBe("number");
    expect(tokens.find((t) => t.kind === "comment")?.text).toBe('// "hours"');
  });

  it("keeps template literals whole and ignores # unless asked", () => {
    expect(tokenize("`Invoice ${n}`")[0]?.kind).toBe("string");
    expect(tokenize("# heading").some((t) => t.kind === "comment")).toBe(false);
    expect(tokenize("# comment", { hashComments: true })[0]?.kind).toBe("comment");
  });
});

describe("path and line helpers", () => {
  it("splits paths", () => {
    expect(splitPath("src/time/zoned.ts")).toEqual({ dir: "src/time/", name: "zoned.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });

  it("compresses line numbers into ranges", () => {
    expect(compressLines([9, 3, 4, 5, 12, 11])).toEqual(["3–5", "9", "11–12"]);
    expect(compressLines([])).toEqual([]);
  });
});
