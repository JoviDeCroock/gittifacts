import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import {
  type Commit,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  formatSignature,
  hashObject,
  parseSignature,
  type TreeEntry,
} from "../src/index.js";
import { git, gitBytes, tempDir } from "./support/git.js";

let dir: string;
let cleanup: () => void;
beforeAll(() => {
  ({ path: dir, cleanup } = tempDir());
  git(dir, ["init", "-q", "--bare", "repo.git"]);
  dir = `${dir}/repo.git`;
});
afterAll(() => cleanup());

const writeBlob = (content: string | Uint8Array) =>
  git(dir, ["hash-object", "-w", "--stdin"], { input: content });

describe("hashObject", () => {
  it.each([
    ["empty", ""],
    ["text", "hello world\n"],
    ["unicode", "héllo ✓ 🚀\n"],
    ["binary", new Uint8Array(3000).map((_, i) => (i * 7) % 256)],
  ])("matches git hash-object for %s blobs", async (_, content) => {
    const data = typeof content === "string" ? utf8(content) : content;
    expect(await hashObject({ type: "blob", data })).toBe(writeBlob(content));
  });
});

describe("trees", () => {
  it("encodes in git's canonical order (dirs sort as name + '/')", async () => {
    const a = writeBlob("a\n");
    const b = writeBlob("b\n");
    const sub = git(dir, ["mktree"], { input: `100644 blob ${a}\tinner\n` });
    const gitlink = "1234567890abcdef1234567890abcdef12345678";
    const entries: TreeEntry[] = [
      { mode: "100644", name: "foo0", sha: a },
      { mode: "40000", name: "foo", sha: sub },
      { mode: "100644", name: "foo.txt", sha: b },
      { mode: "100755", name: "foo-bar", sha: a },
      { mode: "120000", name: "link", sha: b },
      { mode: "160000", name: "submodule", sha: gitlink },
      { mode: "100644", name: "é.txt", sha: a },
      { mode: "100644", name: "Z", sha: b },
    ];
    const mktreeInput = entries
      .map(
        (e) =>
          `${e.mode === "40000" ? "040000" : e.mode} ${e.mode === "40000" ? "tree" : e.mode === "160000" ? "commit" : "blob"} ${e.sha}\t${e.name}\n`,
      )
      .join("");
    const expected = git(dir, ["mktree", "--missing"], { input: mktreeInput });
    const data = encodeTree(entries);
    expect(await hashObject({ type: "tree", data })).toBe(expected);
    expect(Buffer.from(data).equals(gitBytes(dir, ["cat-file", "tree", expected]))).toBe(true);
    expect(decodeTree(data).map((e) => e.name)).toEqual([
      "Z",
      "foo-bar",
      "foo.txt",
      "foo",
      "foo0",
      "link",
      "submodule",
      "é.txt",
    ]);
  });

  it("decodes git's raw tree bytes", () => {
    const a = writeBlob("x\n");
    const sha = git(dir, ["mktree"], { input: `100644 blob ${a}\tb\n100755 blob ${a}\ta\n` });
    expect(decodeTree(gitBytes(dir, ["cat-file", "tree", sha]))).toEqual([
      { mode: "100755", name: "a", sha: a },
      { mode: "100644", name: "b", sha: a },
    ]);
  });

  it("rejects invalid entries", () => {
    const sha = "a".repeat(40);
    expect(() => encodeTree([{ mode: "100644", name: "a/b", sha }])).toThrow(
      /invalid tree entry name/,
    );
    expect(() => encodeTree([{ mode: "100644", name: "", sha }])).toThrow();
    expect(() => encodeTree([{ mode: "100644", name: "x", sha: "nope" }])).toThrow(/SHA-1/);
    expect(() =>
      encodeTree([
        { mode: "100644", name: "x", sha },
        { mode: "100755", name: "x", sha },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("commits", () => {
  const author = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    timestamp: 1700000000,
    timezone: "+0100",
  };
  const committer = {
    name: "Bot",
    email: "bot@example.com",
    timestamp: 1700000123,
    timezone: "-0730",
  };

  it("encodes exactly like git commit-tree", async () => {
    const tree = git(dir, ["mktree"], { input: "" });
    const p1 = git(dir, ["commit-tree", tree, "-m", "p1"]);
    const p2 = git(dir, ["commit-tree", tree, "-m", "p2"]);
    const message = "Merge things\n\nWith a body.\nAnd ünïcode.\n";
    const expected = git(dir, ["commit-tree", tree, "-p", p1, "-p", p2], {
      input: message,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: "1700000000 +0100",
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: "1700000123 -0730",
      },
    });
    const commit: Commit = { tree, parents: [p1, p2], author, committer, message };
    expect(await hashObject({ type: "commit", data: encodeCommit(commit) })).toBe(expected);
    expect(decodeCommit(gitBytes(dir, ["cat-file", "commit", expected]))).toEqual(commit);
  });

  it("round-trips extra multi-line headers (gpgsig) byte for byte", async () => {
    const tree = git(dir, ["mktree"], { input: "" });
    const raw = [
      `tree ${tree}`,
      "author A <a@x> 1 +0000",
      "committer C <c@x> 2 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " iQEzBAABCAAdFiEE",
      " -----END PGP SIGNATURE-----",
      "",
      "signed\n",
    ].join("\n");
    const sha = git(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: raw });
    const decoded = decodeCommit(utf8(raw));
    expect(decoded.extraHeaders).toEqual([
      ["gpgsig", "-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEE\n-----END PGP SIGNATURE-----"],
    ]);
    expect(await hashObject({ type: "commit", data: encodeCommit(decoded) })).toBe(sha);
  });

  it("formats and parses signatures", () => {
    expect(formatSignature(committer)).toBe("Bot <bot@example.com> 1700000123 -0730");
    expect(parseSignature("Bot <bot@example.com> 1700000123 -0730")).toEqual(committer);
    expect(() => formatSignature({ ...author, name: "a<b" })).toThrow();
    expect(() => formatSignature({ ...author, timezone: "UTC" })).toThrow();
  });
});
