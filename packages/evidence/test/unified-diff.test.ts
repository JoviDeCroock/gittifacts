import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiffParseError, parseUnifiedDiff, touchedPaths, unquoteGitPath } from "../src/index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseUnifiedDiff — real `git diff -U0 -M` output", () => {
  const diff = parseUnifiedDiff(fixture("rename-binary.u0.diff"));
  const byPath = new Map(diff.files.map((f) => [f.path, f]));

  it("finds every file with the right status", () => {
    expect(diff.files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["assets/icon.bin", "added", true],
      ["assets/logo.png", "modified", true],
      ["docs/README.md", "modified", false],
      ["obsolete.txt", "deleted", false],
      ["run.sh", "modified", false],
      ["src/café.ts", "added", false],
      ["src/math.ts", "modified", false],
      ["src/text.ts", "renamed", false],
      ["src/with space.ts", "added", false],
    ]);
  });

  it("parses renames", () => {
    const f = byPath.get("src/text.ts");
    expect(f).toMatchObject({ oldPath: "src/strings.ts", newPath: "src/text.ts", similarity: 87 });
    expect(f?.hunks).toEqual([
      { file: "src/text.ts", oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 },
    ]);
    expect(f?.addedLines).toEqual([10]);
    expect(f?.removedLines).toEqual([10]);
  });

  it("parses deletions, additions and mode changes", () => {
    expect(byPath.get("obsolete.txt")).toMatchObject({
      oldPath: "obsolete.txt",
      newPath: null,
      oldMode: "100644",
      removedLines: [1],
      addedLines: [],
      hunks: [{ file: "obsolete.txt", oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }],
    });
    expect(byPath.get("assets/icon.bin")).toMatchObject({
      oldPath: null,
      newMode: "100644",
      hunks: [],
    });
    expect(byPath.get("run.sh")).toMatchObject({ oldMode: "100644", newMode: "100755", hunks: [] });
  });

  it("handles C-quoted non-ASCII paths and paths with spaces", () => {
    expect(byPath.get("src/café.ts")?.addedLines).toEqual([1]);
    expect(byPath.get("src/with space.ts")).toMatchObject({
      newPath: "src/with space.ts",
      addedLines: [1],
    });
  });

  it("computes changed head lines with -U0 (pure deletion hunks contribute nothing)", () => {
    const math = byPath.get("src/math.ts");
    expect(math?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [9, 4, 8, 0],
      [13, 0, 10, 1],
      [15, 0, 13, 4],
    ]);
    expect(math?.addedLines).toEqual([10, 13, 14, 15, 16]);
    expect(math?.removedLines).toEqual([9, 10, 11, 12]);
  });

  it("handles '\\ No newline at end of file' between - and + lines", () => {
    const readme = byPath.get("docs/README.md");
    expect(readme?.hunks).toHaveLength(2);
    expect(readme?.addedLines).toEqual([1, 3]);
    expect(readme?.removedLines).toEqual([1, 3]);
  });

  it("exposes changedLines for text files that exist in head", () => {
    expect(diff.changedLines).toEqual({
      "docs/README.md": [1, 3],
      "src/café.ts": [1],
      "src/math.ts": [10, 13, 14, 15, 16],
      "src/text.ts": [10],
      "src/with space.ts": [1],
    });
    expect(diff.hunks).toHaveLength(diff.files.reduce((n, f) => n + f.hunks.length, 0));
  });

  it("gives the same changed lines with default context (-U3)", () => {
    const u3 = parseUnifiedDiff(fixture("rename-binary.u3.diff"));
    expect(u3.changedLines).toEqual(diff.changedLines);
    expect(u3.files.map((f) => f.status)).toEqual(diff.files.map((f) => f.status));
  });

  it("touchedPaths includes both sides of a rename and deleted files", () => {
    expect(touchedPaths(diff)).toEqual([
      "assets/icon.bin",
      "assets/logo.png",
      "docs/README.md",
      "obsolete.txt",
      "run.sh",
      "src/café.ts",
      "src/math.ts",
      "src/strings.ts",
      "src/text.ts",
      "src/with space.ts",
    ]);
  });
});

describe("parseUnifiedDiff — edge cases", () => {
  it("handles --binary patches, 100% renames, empty new files and header-looking content", () => {
    const d = parseUnifiedDiff(fixture("edge-binary-patch.u0.diff"));
    expect(d.files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["blob.bin", "modified", true],
      ["dir/moved.txt", "renamed", false],
      ["new-empty.txt", "added", false],
      ["tricky.sql", "modified", false],
    ]);
    expect(d.files[1]).toMatchObject({ oldPath: "moved.txt", similarity: 100, hunks: [] });
    // "--- b" and "-++ c" are removed CONTENT lines, not file headers.
    expect(d.files[3]).toMatchObject({
      oldPath: "tricky.sql",
      removedLines: [2, 3],
      addedLines: [],
    });
    expect(d.changedLines).toEqual({});
  });

  it("parses hunk headers without counts, copies, and quoted renames", () => {
    const text = [
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -3 +3 @@",
      "-x",
      "+y",
      "diff --git a/src/a b.ts b/lib/a b.ts",
      "similarity index 95%",
      "copy from src/a b.ts",
      "copy to lib/a b.ts",
      'diff --git "a/tab\\there" "b/new\\"name"',
      "similarity index 100%",
      'rename from "tab\\there"',
      'rename to "new\\"name"',
      "",
    ].join("\n");
    const d = parseUnifiedDiff(text);
    expect(d.files[0]?.hunks[0]).toEqual({
      file: "one.txt",
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 1,
    });
    expect(d.files[1]).toMatchObject({
      status: "copied",
      oldPath: "src/a b.ts",
      newPath: "lib/a b.ts",
    });
    expect(d.files[2]).toMatchObject({
      status: "renamed",
      oldPath: "tab\there",
      newPath: 'new"name',
    });
  });

  it("tolerates CRLF and a commit preamble (git show)", () => {
    const text = [
      "commit 0123456789abcdef0123456789abcdef01234567",
      "Author: t <t@t>",
      "",
      "    --- not a header",
      "",
      "diff --git a/x.txt b/x.txt",
      "index 1..2 100644",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
    ].join("\r\n");
    const d = parseUnifiedDiff(text);
    expect(d.files).toHaveLength(1);
    expect(d.changedLines).toEqual({ "x.txt": [2] });
  });

  it("treats a blank line inside a hunk as context (whitespace-stripped diffs)", () => {
    const d = parseUnifiedDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n",
    );
    expect(d.changedLines).toEqual({ f: [3] });
  });

  it("rejects truncated, malformed and combined diffs", () => {
    expect(() =>
      parseUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n"),
    ).toThrow(DiffParseError);
    expect(() => parseUnifiedDiff("diff --git a/f b/f\n@@ -x +1 @@\n")).toThrow(/malformed hunk/);
    expect(() => parseUnifiedDiff("diff --git a/f b/f\n@@ -1 +1 @@\n?what\n")).toThrow(
      /unexpected line/,
    );
    expect(() => parseUnifiedDiff("diff --cc file.txt\n")).toThrow(/combined/);
  });

  it("parses plain (non-git) unified diffs such as `diff -ruN`", () => {
    const text = [
      "diff -ruN a/x.txt b/x.txt",
      "--- a/x.txt\t2026-10-01 12:00:00.000000000 +0000",
      "+++ b/x.txt\t2026-10-01 12:01:00.000000000 +0000",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " same",
      "--- /dev/null\t1970-01-01 00:00:00.000000000 +0000",
      "+++ b/y.txt\t2026-10-01 12:01:00.000000000 +0000",
      "@@ -0,0 +1 @@",
      "+fresh",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(text);
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ["x.txt", "modified"],
      ["y.txt", "added"],
    ]);
    expect(d.changedLines).toEqual({ "x.txt": [1], "y.txt": [1] });
  });

  it("refuses colored diffs instead of reporting no changes", () => {
    expect(() =>
      parseUnifiedDiff("\u001b[1mdiff --git a/f b/f\u001b[m\n\u001b[36m@@ -1 +1 @@\u001b[m\n"),
    ).toThrow(/--no-color/);
  });

  it("returns nothing for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], hunks: [], changedLines: {} });
  });

  it("unquotes git C-style paths", () => {
    expect(unquoteGitPath('"caf\\303\\251 \\"q\\" \\\\ \\t"')).toBe('café "q" \\ \t');
    expect(unquoteGitPath("plain path")).toBe("plain path");
  });
});
