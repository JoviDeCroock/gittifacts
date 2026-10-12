import { describe, expect, it } from "vitest";
import {
  CodeRef,
  classifyFile,
  commitActivity,
  commitTitle,
  MAX_INLINE_FILE_BYTES,
  normalizeRepoPath,
  readmeOf,
  sortTreeEntries,
} from "../src/code.js";

describe("normalizeRepoPath", () => {
  it("trims slashes and refuses traversal, empty and NUL segments", () => {
    expect(normalizeRepoPath("")).toBe("");
    expect(normalizeRepoPath("/")).toBe("");
    expect(normalizeRepoPath("/src/a.ts/")).toBe("src/a.ts");
    expect(normalizeRepoPath("src/../etc")).toBeNull();
    expect(normalizeRepoPath("./src")).toBeNull();
    expect(normalizeRepoPath("src//a")).toBeNull();
    expect(normalizeRepoPath("a\0b")).toBeNull();
    expect(normalizeRepoPath("x".repeat(1025))).toBeNull();
  });
});

describe("CodeRef", () => {
  it("takes branches, tags and shas, refuses ranges and options", () => {
    for (const ok of ["main", "feature/x", "v1.2.0", "a".repeat(40)])
      expect(CodeRef.safeParse(ok).success).toBe(true);
    for (const bad of ["main..dev", "-x y", "/main", "main/", "a b", ""])
      expect(CodeRef.safeParse(bad).success).toBe(false);
  });
});

describe("classifyFile", () => {
  const enc = new TextEncoder();
  it("is text for UTF-8, binary for a NUL or invalid UTF-8, too-large past the cap", () => {
    expect(classifyFile(enc.encode("héllo\n"))).toEqual({ kind: "text", text: "héllo\n" });
    expect(classifyFile(new Uint8Array([0x50, 0x00, 0x4e]))).toEqual({
      kind: "binary",
      text: null,
    });
    expect(classifyFile(new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({
      kind: "binary",
      text: null,
    });
    expect(classifyFile(new Uint8Array(MAX_INLINE_FILE_BYTES + 1)).kind).toBe("too-large");
  });
});

describe("tree helpers", () => {
  it("lists directories first, then by name; README.md wins over README.txt", () => {
    const entries = [
      { name: "z.ts", kind: "file" as const },
      { name: "src", kind: "dir" as const },
      { name: "README.txt", kind: "file" as const },
      { name: "a", kind: "dir" as const },
      { name: "readme.md", kind: "file" as const },
    ];
    expect(sortTreeEntries(entries).map((e) => e.name)).toEqual([
      "a",
      "src",
      "README.txt",
      "readme.md",
      "z.ts",
    ]);
    expect(readmeOf(entries)?.name).toBe("readme.md");
    expect(readmeOf([{ name: "README", kind: "dir" as const }])).toBeNull();
  });

  it("titles a commit by its first line", () => {
    expect(commitTitle("\n  Fix rounding  \n\nbody")).toBe("Fix rounding");
    expect(commitTitle("   ")).toBe("(no message)");
  });
});

describe("commitActivity", () => {
  // Wednesday 2026-10-14, 15:00 UTC.
  const nowMs = Date.UTC(2026, 9, 14, 15);
  const at = (iso: string) => Date.parse(iso) / 1000;

  it("buckets by UTC day over Monday-aligned whole weeks, counts authors", () => {
    const a = commitActivity(
      [
        { at: at("2026-10-14T09:00:00Z"), author: "Ada" },
        { at: at("2026-10-14T01:00:00Z"), author: "agent-7" },
        { at: at("2026-10-05T12:00:00Z"), author: "Ada" },
        { at: at("2026-09-01T12:00:00Z"), author: "Ada" }, // before the window
        { at: null, author: "Ghost" },
      ],
      { nowMs, weeks: 2, capped: false },
    );
    expect(a.from).toBe("2026-10-05");
    expect(a.to).toBe("2026-10-14");
    expect(a.days).toHaveLength(10);
    expect(a.days.at(-1)).toEqual({ date: "2026-10-14", commits: 2 });
    expect(a.days[0]).toEqual({ date: "2026-10-05", commits: 1 });
    expect(a.total).toBe(3);
    expect(a.authors).toEqual([
      { name: "Ada", commits: 2 },
      { name: "agent-7", commits: 1 },
    ]);
    expect(a.truncated).toBe(false);
  });

  it("is truncated only when a capped read never left the window", () => {
    const inside = [{ at: at("2026-10-13T00:00:00Z"), author: "Ada" }];
    expect(commitActivity(inside, { nowMs, weeks: 1, capped: true }).truncated).toBe(true);
    const reachedOlder = [...inside, { at: at("2026-01-01T00:00:00Z"), author: "Ada" }];
    expect(commitActivity(reachedOlder, { nowMs, weeks: 1, capped: true }).truncated).toBe(false);
    expect(commitActivity([], { nowMs, weeks: 1, capped: true }).truncated).toBe(true);
  });
});
