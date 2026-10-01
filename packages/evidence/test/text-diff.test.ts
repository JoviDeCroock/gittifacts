import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  diffLines,
  type FileChange,
  parseUnifiedDiff,
  quoteGitPath,
  splitLines,
  unifiedDiffOf,
  unifiedFileDiff,
} from "../src/index.js";

/** Apply one file's unified diff (our own output) to `before`. Test oracle, not production code. */
function applyFileDiff(before: string, diff: string): string {
  const a = splitLines(before);
  const out: string[] = [];
  let ai = 0;
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith("@@")) i++;
  while (i < lines.length) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number(m[1]);
    const oldCount = Number(m[2]);
    const from = oldCount === 0 ? oldStart : oldStart - 1;
    while (ai < from) out.push(a[ai++]!);
    i++;
    while (i < lines.length && !lines[i]!.startsWith("@@") && lines[i] !== "") {
      const l = lines[i]!;
      const noEol = lines[i + 1]?.startsWith("\\ No newline") ?? false;
      const text = l.slice(1) + (noEol ? "" : "\n");
      if (l[0] === " ") {
        expect(a[ai]).toBe(text);
        out.push(text);
        ai++;
      } else if (l[0] === "-") {
        expect(a[ai]).toBe(text);
        ai++;
      } else if (l[0] === "+") out.push(text);
      i += noEol ? 2 : 1;
    }
  }
  while (ai < a.length) out.push(a[ai++]!);
  return out.join("");
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(r: () => number, lines: number): string {
  const vocab = ["a", "b", "c", "}", "", "  return x;", "import y;", "é ☕"];
  let s = "";
  for (let i = 0; i < lines; i++) s += `${vocab[Math.floor(r() * vocab.length)]}\n`;
  return r() < 0.2 ? s.replace(/\n$/, "") : s;
}

function mutateText(r: () => number, text: string): string {
  const ls = splitLines(text);
  const n = Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const at = Math.floor(r() * (ls.length + 1));
    const roll = r();
    if (roll < 0.4 && ls.length > 0) ls.splice(Math.min(at, ls.length - 1), 1);
    else if (roll < 0.8) ls.splice(at, 0, `new ${Math.floor(r() * 100)}\n`);
    else if (ls.length > 0) ls[Math.min(at, ls.length - 1)] = "changed\n";
  }
  return ls.join("");
}

describe("splitLines / diffLines", () => {
  it("keeps terminators and a missing final newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n\nb")).toEqual(["a\n", "\n", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a\r\n", "b\r\n"]);
  });

  it("produces a minimal edit script that transforms a into b", () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const a = splitLines(randomText(r, Math.floor(r() * 30)));
      const b = splitLines(mutateText(r, a.join("")));
      const ops = diffLines(a, b);
      const rebuilt: string[] = [];
      for (const o of ops) if (o.op !== "del") rebuilt.push(o.op === "eq" ? a[o.a]! : b[o.b]!);
      expect(rebuilt).toEqual(b);
      expect(ops.filter((o) => o.op !== "ins").map((o) => (o.op === "eq" ? o.a : o.a))).toEqual(
        a.map((_, i) => i),
      );
    }
  });

  it("degrades to a full replacement past the edit-distance cap (still correct)", () => {
    const a = ["1\n", "2\n", "3\n"];
    const b = ["x\n", "y\n", "z\n"];
    const ops = diffLines(a, b, { maxEditDistance: 1 });
    expect(ops.filter((o) => o.op === "del")).toHaveLength(3);
    expect(ops.filter((o) => o.op === "ins")).toHaveLength(3);
  });
});

describe("unifiedFileDiff", () => {
  it("round-trips random edits through its own hunks", () => {
    const r = rng(42);
    for (let n = 0; n < 300; n++) {
      const before = randomText(r, Math.floor(r() * 40));
      const after = mutateText(r, before);
      const diff = unifiedFileDiff({ path: "f.ts", before, after });
      if (before === after) expect(diff).toBe("");
      else expect(applyFileDiff(before, diff)).toBe(after);
    }
  });

  it("marks a missing final newline like git", () => {
    const d = unifiedFileDiff({ path: "a.txt", before: "x\ny", after: "x\nz\n" });
    expect(d).toContain("-y\n\\ No newline at end of file\n+z\n");
  });

  it("quotes unusual paths and leaves spaces alone", () => {
    expect(quoteGitPath("src/a b.ts")).toBe("src/a b.ts");
    expect(quoteGitPath('we"ird')).toBe('"we\\"ird"');
    expect(quoteGitPath("café.ts")).toBe('"caf\\303\\251.ts"');
  });

  it("is parsed back by parseUnifiedDiff with the right head lines", () => {
    const diff = unifiedDiffOf([
      {
        path: "src/a.ts",
        before: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
        after: "1\n2\nX\n4\n5\n6\n7\n8\n9\n10\nY\n",
      },
      { path: "src/new.ts", before: null, after: "n\n" },
      { path: "src/old.ts", before: "o\n", after: null },
    ]);
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files.map((f) => [f.path, f.status])).toEqual([
      ["src/a.ts", "modified"],
      ["src/new.ts", "added"],
      ["src/old.ts", "deleted"],
    ]);
    expect(parsed.changedLines["src/a.ts"]).toEqual([3, 11]);
  });
});

describe("git apply accepts the output", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

  it("applies adds, deletes, modifications, CRLF, no-EOL and odd paths", () => {
    const root = mkdtempSync(join(tmpdir(), "gtf-textdiff-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    const changes: FileChange[] = [
      { path: "src/a.ts", before: "a\nb\nc\n", after: "a\nB\nc\nd\n" },
      { path: "src/no-eol.txt", before: "x\ny", after: "x\ny\nz" },
      { path: "src/crlf.txt", before: "1\r\n2\r\n", after: "1\r\n2!\r\n" },
      { path: "src/new file.ts", before: null, after: "hello\n" },
      { path: "src/gone.ts", before: "bye\n", after: null },
      { path: "src/empty.txt", before: null, after: "" },
      { path: "docs/café.md", before: "un\n", after: "deux\n" },
    ];
    for (const c of changes) {
      if (c.before === null) continue;
      const full = join(root, c.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, c.before);
    }
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    const patch = join(root, "..", `${root.split("/").pop()}.patch`);
    writeFileSync(patch, unifiedDiffOf(changes));
    execFileSync("git", ["apply", "--index", patch], { cwd: root, env });
    for (const c of changes) {
      const full = join(root, c.path);
      if (c.after === null) expect(() => readFileSync(full)).toThrow();
      else expect(readFileSync(full, "utf8")).toBe(c.after);
    }
    rmSync(patch, { force: true });
  });
});
