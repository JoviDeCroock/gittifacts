import type { RepoReader } from "../../src/cache/tree.js";
import type { ObjectStore } from "../../src/storage.js";

/** In-memory ObjectStore with R2-like list semantics. */
export class MemoryStore implements ObjectStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    const v = this.data.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
    return null;
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    const all = [...this.data.keys()].filter((k) => k.startsWith(options.prefix)).sort();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options.limit ?? 2;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
    };
  }
}

type FakeTree = { [name: string]: string | FakeTree };

/**
 * A fake Artifacts repo built from nested objects: strings are file contents, objects are
 * directories. Hashes are deterministic per content/path.
 */
export function fakeRepo(commits: Record<string, FakeTree>): RepoReader & { treeReads: number } {
  const trees = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  const blobs = new Map<string, string>();
  const commitTrees = new Map<string, string>();
  const hex = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return (h >>> 0).toString(16).padStart(8, "0").repeat(5);
  };
  const build = (tree: FakeTree, path: string): string => {
    const entries = Object.entries(tree).map(([name, v]) => {
      if (typeof v === "string") {
        const hash = hex(`blob:${v}`);
        blobs.set(hash, v);
        return { name, mode: "100644", hash, type: "blob" };
      }
      return { name, mode: "40000", hash: build(v, `${path}/${name}`), type: "tree" };
    });
    const hash = hex(`tree:${path}:${JSON.stringify(entries)}`);
    trees.set(hash, entries);
    return hash;
  };
  for (const [sha, tree] of Object.entries(commits)) commitTrees.set(sha, build(tree, sha));
  const repo = {
    treeReads: 0,
    async readCommit(hash: string) {
      const treeHash = commitTrees.get(hash);
      return treeHash === undefined ? null : { treeHash };
    },
    async readTree(hash: string) {
      repo.treeReads++;
      await new Promise((r) => setTimeout(r, 1));
      return trees.get(hash) ?? null;
    },
    async readBlob(hash: string) {
      const v = blobs.get(hash);
      return v === undefined ? null : { text: async () => v, size: v.length };
    },
  };
  return repo;
}

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
