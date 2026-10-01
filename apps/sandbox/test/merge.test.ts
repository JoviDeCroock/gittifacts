/** merge-attempt and apply-resolution, through the built bundle, on throwaway repositories. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConflicts, resolutionScope, unifiedDiffOf } from "@app/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, document, ensureBundle, type Files, gitSync } from "./helpers.js";

const roots: string[] = [];
beforeAll(() => ensureBundle(), 120_000);
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const MARKERS = { size: 13, ours: "upstream", base: "base", theirs: "change" };

function write(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

interface Repo {
  dir: string;
  base: string;
  onto: string;
  head: string;
}

/** base on main; onto = main + an upstream commit; head = a Change branched from base. */
function repo(base: Files, upstream: Files, change: Files): Repo {
  const root = mkdtempSync(join(tmpdir(), "gittifacts-merge-"));
  roots.push(root);
  const dir = join(root, "repo");
  mkdirSync(dir);
  const commit = (msg: string) => {
    gitSync(dir, ["add", "-A"]);
    gitSync(dir, ["commit", "-q", "--allow-empty", "-m", msg]);
    return gitSync(dir, ["rev-parse", "HEAD"]);
  };
  gitSync(dir, ["init", "-q"]);
  write(dir, base);
  const baseSha = commit("base");
  write(dir, upstream);
  const onto = commit("upstream: chg_up");
  gitSync(dir, ["checkout", "-q", "-b", "change", baseSha]);
  write(dir, change);
  const head = commit("change: our work");
  return { dir, base: baseSha, onto, head };
}

async function attempt(r: Repo) {
  const res = await cli(
    ["merge-attempt", "--base", r.base, "--onto", r.onto, "--head", r.head, "--cwd", r.dir],
    r.dir,
  );
  expect(res.code, res.stderr).toBe(0);
  return document(res, "::merge::") as Record<string, unknown> & {
    status: string;
    files: Array<Record<string, unknown> & { path: string; merged_with_markers: string | null }>;
  };
}

const LIST = (...items: string[]) =>
  `export const list = [\n${items.map((i) => `  "${i}",\n`).join("")}];\n`;

describe("merge-attempt", () => {
  it("replays a non-conflicting change as one commit on the new base", async () => {
    const r = repo(
      { "a.txt": "1\n2\n3\n", "b.txt": "x\n" },
      { "a.txt": "1 upstream\n2\n3\n" },
      { "a.txt": "1\n2\n3 change\n", "c.txt": "new\n" },
    );
    const doc = await attempt(r);
    expect(doc).toMatchObject({
      status: "clean",
      base: r.base,
      onto: r.onto,
      head: r.head,
      files: [],
    });
    const sha = doc.newSha as string;
    expect(gitSync(r.dir, ["show", `${sha}:a.txt`])).toBe("1 upstream\n2\n3 change");
    expect(gitSync(r.dir, ["rev-parse", `${sha}^`])).toBe(r.onto);
    expect(gitSync(r.dir, ["log", "-1", "--format=%an|%s", sha])).toBe("Test|change: our work");
    // The checkout is untouched.
    expect(gitSync(r.dir, ["rev-parse", "HEAD"])).toBe(r.head);
  });

  it("reports content conflicts with exact markers, all three sides and a conflict commit", async () => {
    const r = repo(
      { "src/list.ts": LIST("a") },
      { "src/list.ts": LIST("a", "upstream") },
      { "src/list.ts": LIST("a", "change") },
    );
    const doc = await attempt(r);
    expect(doc.status).toBe("conflict");
    expect(doc.markers).toEqual(MARKERS);
    expect(doc.files).toHaveLength(1);
    const f = doc.files[0]!;
    expect(f).toMatchObject({
      path: "src/list.ts",
      kind: "content",
      mode: "100644",
      binary: false,
      tooLarge: false,
      base: LIST("a"),
      ours: LIST("a", "upstream"),
      theirs: LIST("a", "change"),
    });
    const parsed = parseConflicts(f.merged_with_markers ?? "", MARKERS);
    expect(parsed.ok && parsed.regions.map((x) => [x.ours, x.base, x.theirs])).toEqual([
      [['  "upstream",\n'], [], ['  "change",\n']],
    ]);
    const conflictSha = doc.conflictSha as string;
    expect(gitSync(r.dir, ["show", `${conflictSha}:src/list.ts`])).toBe(
      (f.merged_with_markers ?? "").trimEnd(),
    );
    expect(gitSync(r.dir, ["rev-parse", `${conflictSha}^`])).toBe(r.onto);
    expect(doc.upstreamCommits).toEqual([{ sha: r.onto, subject: "upstream: chg_up" }]);
    expect((doc.messages as string[])[0]).toMatch(/^CONFLICT \(content\)/);
    // Deterministic: a second run produces the same commit.
    expect((await attempt(r)).conflictSha).toBe(conflictSha);
  });

  it("replays exactly base..head: commits below --base are not carried over", async () => {
    // head = base0 + X (not on main) + the change; the Change's declared base is X. git's own
    // merge base would be base0 and would carry X's file along.
    const r = repo({ "a.txt": "1\n2\n3\n" }, { "b.txt": "upstream\n" }, { "x.txt": "X\n" });
    write(r.dir, { "a.txt": "1\n2 change\n3\n" });
    gitSync(r.dir, ["add", "-A"]);
    gitSync(r.dir, ["commit", "-q", "-m", "change on top of X"]);
    const head = gitSync(r.dir, ["rev-parse", "HEAD"]);
    const doc = await attempt({ ...r, base: r.head, head });
    expect(doc.status).toBe("clean");
    const tree = gitSync(r.dir, ["ls-tree", "--name-only", doc.newSha as string]).split("\n");
    expect(tree).toEqual(["a.txt", "b.txt"]);
    expect(gitSync(r.dir, ["show", `${doc.newSha as string}:a.txt`])).toBe("1\n2 change\n3");
  });

  it("reports modify/delete as a whole-file conflict with the surviving side", async () => {
    const r = repo(
      { "gone.ts": "export const x = 1;\n", "keep.ts": "k\n" },
      { "gone.ts": null },
      { "gone.ts": "export const x = 2;\n" },
    );
    const doc = await attempt(r);
    expect(doc.status).toBe("conflict");
    expect(doc.files[0]).toMatchObject({
      path: "gone.ts",
      kind: "modify-delete",
      ours: null,
      theirs: "export const x = 2;\n",
      merged_with_markers: "export const x = 2;\n",
    });
  });

  it("reports unknown commits as an error document and usage errors with exit 2", async () => {
    const r = repo({ "a.txt": "a\n" }, { "a.txt": "b\n" }, { "a.txt": "c\n" });
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const res = await cli(
      ["merge-attempt", "--base", missing, "--onto", r.onto, "--head", r.head, "--cwd", r.dir],
      r.dir,
    );
    expect(res.code).toBe(0);
    expect(document(res, "::merge::")).toMatchObject({ status: "error", files: [] });
    expect((await cli(["merge-attempt", "--base", r.base, "--cwd", r.dir], r.dir)).code).toBe(2);
    expect((await cli(["apply-resolution", "--cwd", r.dir], r.dir)).code).toBe(2);
  });
});

describe("apply-resolution", () => {
  async function conflicted() {
    const r = repo(
      { "src/list.ts": LIST("a"), "src/other.ts": "export const o = 1;\n" },
      { "src/list.ts": LIST("a", "upstream") },
      { "src/list.ts": LIST("a", "change") },
    );
    const doc = await attempt(r);
    const merged = doc.files[0]?.merged_with_markers ?? "";
    return { r, doc, merged, conflictSha: doc.conflictSha as string };
  }

  async function apply(r: Repo, onto: string, patch: string) {
    const file = join(dirname(r.dir), `p-${Math.random().toString(36).slice(2)}.patch`);
    writeFileSync(file, patch);
    const res = await cli(
      ["apply-resolution", "--patch", file, "--onto", onto, "--cwd", r.dir],
      r.dir,
    );
    expect(res.code, res.stderr).toBe(0);
    return document(res, "::merge::") as Record<string, unknown>;
  }

  it("commits the resolution as gittifacts-resolver on top of the conflict commit", async () => {
    const { r, merged, conflictSha } = await conflicted();
    const resolved = LIST("a", "upstream", "change");
    const doc = await apply(
      r,
      conflictSha,
      unifiedDiffOf([{ path: "src/list.ts", before: merged, after: resolved }]),
    );
    expect(doc).toMatchObject({
      status: "resolved",
      parentSha: conflictSha,
      files: ["src/list.ts"],
    });
    const sha = doc.newSha as string;
    expect(`${gitSync(r.dir, ["show", `${sha}:src/list.ts`])}\n`).toBe(resolved);
    expect(gitSync(r.dir, ["log", "-1", "--format=%an <%ae>|%cn", sha])).toBe(
      "gittifacts-resolver <resolver@gittifacts.dev>|gittifacts-resolver",
    );
    expect(gitSync(r.dir, ["log", "-1", "--format=%B", sha])).toContain(
      "Gittifacts-Resolver: system:resolver",
    );
    // The scope check agrees: only the conflict region changed.
    const scope = resolutionScope(
      [{ path: "src/list.ts", merged, resolved, conflicted: true }],
      MARKERS,
    );
    expect(scope.touchesOutsideConflictHunks).toBe(false);
  });

  it("refuses a patch that leaves conflict markers", async () => {
    const { r, merged, conflictSha } = await conflicted();
    const doc = await apply(
      r,
      conflictSha,
      unifiedDiffOf([
        { path: "src/other.ts", before: "export const o = 1;\n", after: "export const o = 2;\n" },
      ]),
    );
    expect(doc).toMatchObject({ status: "error" });
    expect(doc.note).toMatch(/unresolved conflict markers remain in: src\/list.ts/);
    expect(merged).toContain("<<<<<<<<<<<<< upstream");
  });

  it("an empty patch keeps the merge-attempt tree and is still committed by the resolver", async () => {
    const r = repo(
      { "gone.ts": "export const x = 1;\n" },
      { "gone.ts": null },
      { "gone.ts": "export const x = 2;\n" },
    );
    const merged = await attempt(r);
    const conflictSha = merged.conflictSha as string;
    const doc = await apply(r, conflictSha, "");
    expect(doc).toMatchObject({ status: "resolved", parentSha: conflictSha, files: [] });
    const sha = doc.newSha as string;
    expect(gitSync(r.dir, ["rev-parse", `${sha}^{tree}`])).toBe(
      gitSync(r.dir, ["rev-parse", `${conflictSha}^{tree}`]),
    );
    expect(gitSync(r.dir, ["log", "-1", "--format=%an", sha])).toBe("gittifacts-resolver");
  });

  it("reports a patch that does not apply", async () => {
    const { r, conflictSha } = await conflicted();
    const doc = await apply(
      r,
      conflictSha,
      unifiedDiffOf([{ path: "src/list.ts", before: "not the content\n", after: "x\n" }]),
    );
    expect(doc).toMatchObject({ status: "error", parentSha: conflictSha });
    expect(doc.note).toMatch(/does not apply/);
  });
});
