import { describe, expect, it } from "vitest";
import { compileGlobs, globToRegExp } from "../../src/cache/glob.js";
import {
  type CacheKeyInput,
  cacheKeyMaterial,
  computeCacheKey,
  matchBlobs,
} from "../../src/cache/key.js";
import {
  CACHE_MAX_AGE_MS,
  type CachePointer,
  cachePointerKey,
  lookupCache,
  readCachePointer,
  writeCachePointer,
} from "../../src/cache/pointer.js";
import { listDirectory, listRoot, readRootFile, walkTree } from "../../src/cache/tree.js";
import { listKeys } from "../../src/storage.js";
import { fakeRepo, MemoryStore, SHA_A, SHA_B } from "./helpers.js";

describe("glob", () => {
  const cases: [string, string, boolean][] = [
    ["package.json", "package.json", true],
    ["package.json", "a/package.json", false],
    ["**/package.json", "package.json", true],
    ["**/package.json", "a/b/package.json", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/**", "src/a/b.ts", true],
    ["src/", "src/a/b.ts", true],
    ["src/**/*.ts", "src/x.ts", true],
    ["*.{ts,tsx}", "a.tsx", true],
    ["*.{ts,tsx}", "a.js", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file/.txt", false],
    ["[ab].txt", "a.txt", true],
    ["[!ab].txt", "a.txt", false],
    ["./pnpm-lock.yaml", "pnpm-lock.yaml", true],
    ["a.b", "axb", false],
  ];
  it.each(cases)("%s ~ %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
  it("combines patterns", () => {
    const m = compileGlobs(["package.json", "pnpm-lock.yaml"]);
    expect(m("pnpm-lock.yaml")).toBe(true);
    expect(m("x/package.json")).toBe(false);
  });
});

describe("tree walking", () => {
  const repo = fakeRepo({
    [SHA_A]: {
      "package.json": "{}",
      "pnpm-lock.yaml": "lock",
      ".platform": { "ci.ts": "export default", transforms: { "x.ts": "t" } },
      packages: {
        a: { "package.json": "{a}", src: { "i.ts": "1" } },
        b: { "package.json": "{b}" },
      },
    },
  });

  it("walks every blob with bounded concurrency and sorts by path", async () => {
    const blobs = await walkTree(repo, SHA_A, { concurrency: 3 });
    expect(blobs.map((b) => b.path)).toEqual([
      ".platform/ci.ts",
      ".platform/transforms/x.ts",
      "package.json",
      "packages/a/package.json",
      "packages/a/src/i.ts",
      "packages/b/package.json",
      "pnpm-lock.yaml",
    ]);
  });

  it("fails on unknown commits and oversized trees", async () => {
    await expect(walkTree(repo, SHA_B)).rejects.toThrow(/not found/);
    await expect(walkTree(repo, SHA_A, { maxBlobs: 2 })).rejects.toThrow(/more than 2 files/);
  });

  it("lists the root, a directory, and reads a root file", async () => {
    const root = await listRoot(repo, SHA_A);
    expect(root.entries.map((e) => e.name).sort()).toEqual([
      ".platform",
      "package.json",
      "packages",
      "pnpm-lock.yaml",
    ]);
    expect(await listDirectory(repo, root, ".platform")).toEqual(["ci.ts", "transforms"]);
    expect(await listDirectory(repo, root, "nope")).toEqual([]);
    expect(await readRootFile(repo, root, "package.json")).toBe("{}");
    expect(await readRootFile(repo, root, "packages")).toBeNull();
    expect(await readRootFile(repo, root, "pnpm-lock.yaml", 2)).toBeNull();
  });
});

describe("cache keys", () => {
  const blobs = [
    { path: "package.json", sha: "1".repeat(40) },
    { path: "pnpm-lock.yaml", sha: "2".repeat(40) },
    { path: "src/index.ts", sha: "3".repeat(40) },
  ];
  const base: CacheKeyInput = {
    scope: "repo:r1:main",
    namespace: "v1",
    step: { name: "install", command: "pnpm install --frozen-lockfile", env: { B: "2", A: "1" } },
    inputs: ["package.json", "pnpm-lock.yaml"],
    blobs,
  };

  it("is deterministic and independent of env/input/blob ordering", async () => {
    const k1 = await computeCacheKey(base);
    const k2 = await computeCacheKey({
      ...base,
      step: { ...base.step, env: { A: "1", B: "2" } },
      inputs: ["pnpm-lock.yaml", "package.json", "package.json"],
      blobs: [...blobs].reverse(),
    });
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k2).toBe(k1);
  });

  it("changes when any keyed input changes", async () => {
    const k = await computeCacheKey(base);
    const variants: CacheKeyInput[] = [
      { ...base, scope: "repo:r1:change:c1" },
      { ...base, namespace: "v2" },
      { ...base, step: { ...base.step, name: "deps" } },
      { ...base, step: { ...base.step, command: "pnpm install" } },
      { ...base, step: { ...base.step, cwd: "app" } },
      { ...base, step: { ...base.step, env: { A: "1" } } },
      { ...base, blobs: [{ path: "package.json", sha: "9".repeat(40) }, ...blobs.slice(1)] },
      { ...base, inputs: [...base.inputs, "src/**"] },
    ];
    const keys = await Promise.all(variants.map(computeCacheKey));
    for (const v of keys) expect(v).not.toBe(k);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ignores files outside the inputs and returns null when nothing matches", async () => {
    const k = await computeCacheKey(base);
    expect(
      await computeCacheKey({
        ...base,
        blobs: [...blobs, { path: "README.md", sha: "4".repeat(40) }],
      }),
    ).toBe(k);
    expect(await computeCacheKey({ ...base, inputs: ["nope/**"] })).toBeNull();
    expect(matchBlobs(blobs, ["src/**"]).map((b) => b.path)).toEqual(["src/index.ts"]);
    expect(cacheKeyMaterial(base, matchBlobs(blobs, base.inputs))).toContain(
      '"env":[["A","1"],["B","2"]]',
    );
  });
});

describe("cache pointers", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const pointer = (key: string, createdAt: string): CachePointer => ({
    v: 1,
    key,
    snapshotId: "snap-1",
    step: "install",
    scope: "repo:r1:main",
    producedBySha: SHA_A,
    runId: "run-1",
    createdAt,
  });
  const k1 = "a".repeat(64);
  const k2 = "b".repeat(64);

  it("round-trips and treats > 25 days as a miss", async () => {
    const store = new MemoryStore();
    await writeCachePointer(store, pointer(k1, new Date(now - 24 * 86_400_000).toISOString()));
    await writeCachePointer(store, pointer(k2, new Date(now - CACHE_MAX_AGE_MS - 1).toISOString()));
    expect((await readCachePointer(store, k1, now))?.snapshotId).toBe("snap-1");
    expect(await readCachePointer(store, k2, now)).toBeNull();
    expect(store.data.has(cachePointerKey(k1))).toBe(true);
  });

  it("ignores invalid or mismatched pointers and looks up keys in order", async () => {
    const store = new MemoryStore();
    await store.put(cachePointerKey(k1), "not json");
    await store.put(cachePointerKey(k2), JSON.stringify(pointer(k1, new Date(now).toISOString())));
    expect(await lookupCache(store, [k1, k2], now)).toBeNull();
    await writeCachePointer(store, {
      ...pointer(k2, new Date(now).toISOString()),
      snapshotId: "snap-2",
    });
    expect((await lookupCache(store, [k1, k2], now))?.snapshotId).toBe("snap-2");
  });

  it("lists keys across pages", async () => {
    const store = new MemoryStore();
    for (const k of ["p/1", "p/2", "p/3", "q/1"]) await store.put(k, "x");
    expect(await listKeys(store, "p/")).toEqual(["p/1", "p/2", "p/3"]);
  });
});
