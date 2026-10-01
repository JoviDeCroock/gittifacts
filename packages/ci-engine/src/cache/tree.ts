/**
 * Reading a commit's tree through the Artifacts binding (`readCommit`/`readTree`/`readBlob`).
 * Never checks anything out and never executes repository code.
 */

/** Structural subset of `ArtifactsRepo` used here (the real handle is also `Disposable`). */
export interface RepoReader {
  readCommit(hash: string): Promise<{ treeHash: string } | null>;
  readTree(
    hash: string,
  ): Promise<{ name: string; mode: string; hash: string; type: string }[] | null>;
  readBlob(hash: string): Promise<{ text(): Promise<string>; size: number } | null>;
}

export interface TreeBlob {
  path: string;
  sha: string;
}

export class TreeReadError extends Error {
  override readonly name = "TreeReadError";
}

export const MAX_TREE_BLOBS = 100_000;

async function rootTreeHash(repo: RepoReader, commitSha: string): Promise<string> {
  const commit = await repo.readCommit(commitSha);
  if (commit === null) throw new TreeReadError(`commit ${commitSha} not found`);
  return commit.treeHash;
}

/**
 * Every blob in the commit (`blob`, `exec` and `symlink` entries; submodules are skipped), with
 * up to `concurrency` `readTree` calls in flight.
 */
export async function walkTree(
  repo: RepoReader,
  commitSha: string,
  opts: { maxBlobs?: number; concurrency?: number } = {},
): Promise<TreeBlob[]> {
  const maxBlobs = opts.maxBlobs ?? MAX_TREE_BLOBS;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const blobs: TreeBlob[] = [];
  const queue: { hash: string; prefix: string }[] = [
    { hash: await rootTreeHash(repo, commitSha), prefix: "" },
  ];
  let failure: Error | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null) {
      const next = queue.shift();
      if (next === undefined) return;
      const entries = await repo.readTree(next.hash);
      if (entries === null) {
        failure = new TreeReadError(`tree ${next.hash} at "${next.prefix || "/"}" not found`);
        return;
      }
      for (const e of entries) {
        const path = next.prefix === "" ? e.name : `${next.prefix}/${e.name}`;
        if (e.type === "tree") queue.push({ hash: e.hash, prefix: path });
        else if (e.type === "blob" || e.type === "exec" || e.type === "symlink")
          blobs.push({ path, sha: e.hash });
      }
      if (blobs.length > maxBlobs) {
        failure = new TreeReadError(`commit ${commitSha} has more than ${maxBlobs} files`);
        return;
      }
    }
  };
  // Workers drain the shared queue; one that finds it momentarily empty exits, so loop until both
  // the queue is empty and no worker is still reading.
  while (queue.length > 0 && failure === null) {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }
  if (failure !== null) throw failure;
  blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return blobs;
}

export interface RootListing {
  entries: { name: string; hash: string; type: string }[];
}

/** Root-level entries of a commit. */
export async function listRoot(repo: RepoReader, commitSha: string): Promise<RootListing> {
  const tree = await repo.readTree(await rootTreeHash(repo, commitSha));
  if (tree === null) throw new TreeReadError(`root tree of ${commitSha} not found`);
  return { entries: tree.map((e) => ({ name: e.name, hash: e.hash, type: e.type })) };
}

/** Names inside a root-level directory (empty when absent). */
export async function listDirectory(
  repo: RepoReader,
  root: RootListing,
  name: string,
): Promise<string[]> {
  const dir = root.entries.find((e) => e.name === name && e.type === "tree");
  if (dir === undefined) return [];
  const entries = await repo.readTree(dir.hash);
  return entries === null ? [] : entries.map((e) => e.name);
}

/** Text of a root-level file, capped at `maxBytes` (null when absent, not a file, or too large). */
export async function readRootFile(
  repo: RepoReader,
  root: RootListing,
  name: string,
  maxBytes = 1024 * 1024,
): Promise<string | null> {
  const entry = root.entries.find(
    (e) => e.name === name && (e.type === "blob" || e.type === "exec"),
  );
  if (entry === undefined) return null;
  const blob = await repo.readBlob(entry.hash);
  if (blob === null || blob.size > maxBytes) return null;
  return blob.text();
}
