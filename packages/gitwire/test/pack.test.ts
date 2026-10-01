import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import {
  applyDelta,
  buildPack,
  encodeCommit,
  encodeTree,
  GitProtocolError,
  hashObject,
  parsePack,
} from "../src/index.js";
import { commitFiles, git, gitBytes, initRepo, lorem, tempDir } from "./support/git.js";

let root: string;
let cleanup: () => void;
let work: string;
let base: string;
let tip: string;

beforeAll(() => {
  ({ path: root, cleanup } = tempDir());
  work = initRepo(join(root, "work"));
  // Similar large blobs across commits so pack-objects produces deltas.
  base = commitFiles(
    work,
    {
      "big.txt": lorem(1, 400),
      "src/a.ts": lorem(2, 50),
      "bin.dat": new Uint8Array(70000).map((_, i) => (i * 31) % 251),
    },
    "base",
  );
  commitFiles(
    work,
    { "big.txt": `${lorem(1, 400)}appended\n`, "src/a.ts": lorem(2, 51) },
    "second",
  );
  tip = commitFiles(
    work,
    { "big.txt": `header\n${lorem(1, 400)}appended\n`, "src/b.ts": lorem(3, 30) },
    "third",
  );
});
afterAll(() => cleanup());

/** All objects reachable from `tip` according to git. */
function gitObjects(repo: string, revs: string): Map<string, { type: string; data: Buffer }> {
  const shas = git(repo, ["rev-list", "--objects", ...revs.split(" ")])
    .split("\n")
    .map((l) => l.split(" ")[0]!);
  return new Map(
    shas.map((sha) => [
      sha,
      {
        type: git(repo, ["cat-file", "-t", sha]),
        data: gitBytes(repo, ["cat-file", git(repo, ["cat-file", "-t", sha]), sha]),
      },
    ]),
  );
}

function packWithGit(args: string[], revs: string, env?: Record<string, string>): Buffer {
  return gitBytes(work, ["pack-objects", "--stdout", "--revs", ...args], {
    input: `${revs.split(" ").join("\n")}\n`,
    ...(env ? { env } : {}),
  });
}

/** Counts deltified entries via verify-pack (delta lines carry depth + base columns). */
function countDeltas(pack: Buffer): number {
  const { path, cleanup: done } = tempDir();
  try {
    git(path, ["init", "-q", "--bare"]);
    const packPath = join(path, "p.pack");
    writeFileSync(packPath, pack);
    git(path, ["index-pack", packPath]);
    const out = git(path, ["verify-pack", "-v", join(path, "p.idx")]);
    return out.split("\n").filter((l) => /^[0-9a-f]{40} \w+ +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(l))
      .length;
  } finally {
    done();
  }
}

describe("parsePack", () => {
  it.each([
    ["OFS_DELTA (--delta-base-offset)", ["--delta-base-offset"]],
    ["REF_DELTA", []],
    [
      "stored blocks (pack.compression=0)",
      ["--delta-base-offset"],
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "pack.compression", GIT_CONFIG_VALUE_0: "0" },
    ],
  ] as Array<[string, string[], Record<string, string>?]>)(
    "resolves a git pack-objects pack with %s",
    async (_, args, env) => {
      const pack = packWithGit(args, tip, env);
      expect(countDeltas(pack)).toBeGreaterThan(0);
      const objects = await parsePack(pack);
      const expected = gitObjects(work, tip);
      expect(objects.length).toBe(expected.size);
      for (const o of objects) {
        const e = expected.get(o.sha);
        expect(e, o.sha).toBeDefined();
        expect(o.type).toBe(e!.type);
        expect(Buffer.from(o.data).equals(e!.data)).toBe(true);
      }
    },
  );

  it("rejects thin packs, corrupt checksums and garbage", async () => {
    const thin = packWithGit(["--thin", "--delta-base-offset"], `${tip} ^${base}`);
    await expect(parsePack(thin)).rejects.toThrow(/unresolved delta bases/);
    const pack = packWithGit([], tip);
    const corrupt = Buffer.from(pack);
    corrupt[100] = corrupt[100]! ^ 0xff;
    await expect(parsePack(corrupt)).rejects.toThrow(/checksum/);
    await expect(parsePack(utf8("not a pack at all, definitely not"))).rejects.toThrow(
      GitProtocolError,
    );
  });
});

describe("buildPack", () => {
  it("produces the canonical empty pack", async () => {
    const empty = await buildPack([]);
    expect(empty.length).toBe(32);
    expect(Buffer.from(empty.subarray(0, 12)).toString("hex")).toBe("5041434b0000000200000000");
    expect(await parsePack(empty)).toEqual([]);
  });

  it("is accepted by git index-pack --strict and verify-pack", async () => {
    const blobs = [utf8("hello\n"), utf8(lorem(9, 2000)), new Uint8Array(0)];
    const blobShas = await Promise.all(blobs.map((data) => hashObject({ type: "blob", data })));
    const tree = encodeTree(blobShas.map((sha, i) => ({ mode: "100644", name: `f${i}`, sha })));
    const treeSha = await hashObject({ type: "tree", data: tree });
    const sig = { name: "T", email: "t@x", timestamp: 1700000000, timezone: "+0000" };
    const commit = encodeCommit({
      tree: treeSha,
      parents: [],
      author: sig,
      committer: sig,
      message: "m\n",
    });
    const commitSha = await hashObject({ type: "commit", data: commit });
    const pack = await buildPack([
      ...blobs.map((data) => ({ type: "blob" as const, data })),
      { type: "tree", data: tree },
      { type: "commit", data: commit },
    ]);

    const { path, cleanup: done } = tempDir();
    try {
      git(path, ["init", "-q", "--bare"]);
      git(path, ["index-pack", "--strict", "--stdin"], { input: pack });
      git(path, ["update-ref", "refs/heads/main", commitSha]);
      git(path, ["fsck", "--full", "--strict"]);
      expect(git(path, ["cat-file", "-p", `${commitSha}:f1`])).toBe(lorem(9, 2000).trim());
      expect(git(path, ["rev-parse", `${commitSha}^{tree}`])).toBe(treeSha);
    } finally {
      done();
    }
    // And our own reader round-trips it.
    expect((await parsePack(pack)).map((o) => o.sha)).toEqual([...blobShas, treeSha, commitSha]);
  });
});

describe("applyDelta", () => {
  it("applies copy and insert instructions", () => {
    const base = utf8("hello world");
    // src=11, dst=11; copy off 0 size 6 ("hello "), insert "there"
    const delta = new Uint8Array([11, 11, 0x80 | 0x10, 6, 5, ...utf8("there")]);
    expect(Buffer.from(applyDelta(base, delta)).toString()).toBe("hello there");
  });

  it("validates sizes and opcodes", () => {
    expect(() => applyDelta(utf8("abc"), new Uint8Array([4, 1, 1, 0x41]))).toThrow(/base size/);
    expect(() => applyDelta(utf8("abc"), new Uint8Array([3, 1, 0]))).toThrow(/reserved/);
    expect(() => applyDelta(utf8("abc"), new Uint8Array([3, 5, 0x91, 0, 5]))).toThrow(
      /out of range/,
    );
  });
});
