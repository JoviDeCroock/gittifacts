/**
 * Commit diff without a git binary: walk two trees (`readTree`), compare entry hashes, read the
 * changed blobs (`readBlob`) and line-diff them. Exact renames are detected by blob hash.
 * Used by `ArtifactsGitHost.diff` and the in-memory fake GitHost.
 */
import type { ChangeDiff, ChangeDiffFile, FileDiffStat } from "@app/domain";
import { diffText } from "./line-diff.js";

export type EntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";

export interface TreeEntryLike {
  name: string;
  mode: string;
  hash: string;
  type: EntryType;
}

export interface BlobLike {
  size: number;
  bytes(): Promise<Uint8Array>;
}

export interface TreeReader {
  readTree(hash: string): Promise<TreeEntryLike[] | null>;
  readBlob(hash: string): Promise<BlobLike | null>;
}

export interface DiffOptions {
  /** Blobs above this are not line-diffed (counted, hunks omitted, `truncated`). Default 1 MiB. */
  maxFileBytes?: number;
  /** Blobs above this are not even read; their line count is estimated. Default 16 MiB. */
  maxReadBytes?: number;
  context?: number;
}

interface RawChange {
  path: string;
  previousPath: string | null;
  status: FileDiffStat["status"];
  oldHash: string | null;
  newHash: string | null;
  oldType: EntryType | null;
  newType: EntryType | null;
}

const isFileLike = (t: EntryType | null) => t === "blob" || t === "exec" || t === "symlink";

async function walk(
  reader: TreeReader,
  base: string | null,
  head: string | null,
  prefix: string,
  out: RawChange[],
): Promise<void> {
  if (base === head) return;
  const [a, b] = await Promise.all([
    base === null ? [] : reader.readTree(base),
    head === null ? [] : reader.readTree(head),
  ]);
  if (a === null || b === null) throw new Error(`tree ${a === null ? base : head} not found`);
  const left = new Map(a.map((e) => [e.name, e] as const));
  const right = new Map(b.map((e) => [e.name, e] as const));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const subtrees: Promise<void>[] = [];
  for (const name of names) {
    const l = left.get(name) ?? null;
    const r = right.get(name) ?? null;
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (l !== null && r !== null && l.hash === r.hash && l.mode === r.mode) continue;
    const lTree = l?.type === "tree";
    const rTree = r?.type === "tree";
    if (lTree || rTree) {
      subtrees.push(
        walk(reader, lTree ? (l?.hash ?? null) : null, rTree ? (r?.hash ?? null) : null, path, out),
      );
      // A file replaced by a directory (or vice versa): the file side changes too.
      if (l !== null && !lTree) out.push(change(path, l, null));
      if (r !== null && !rTree) out.push(change(path, null, r));
      continue;
    }
    out.push(change(path, l, r));
  }
  await Promise.all(subtrees);
}

function change(path: string, l: TreeEntryLike | null, r: TreeEntryLike | null): RawChange {
  let status: FileDiffStat["status"] = "modified";
  if (l === null) status = "added";
  else if (r === null) status = "deleted";
  else if (
    (l.type === "symlink") !== (r.type === "symlink") ||
    (l.type === "gitlink") !== (r.type === "gitlink")
  ) {
    status = "type-changed";
  }
  return {
    path,
    previousPath: null,
    status,
    oldHash: l?.hash ?? null,
    newHash: r?.hash ?? null,
    oldType: l?.type ?? null,
    newType: r?.type ?? null,
  };
}

/** Pair deletions with additions of the identical blob as renames. */
function detectRenames(changes: RawChange[]): RawChange[] {
  const added = new Map<string, RawChange[]>();
  for (const c of changes) {
    if (c.status === "added" && c.newHash !== null && isFileLike(c.newType)) {
      const list = added.get(c.newHash) ?? [];
      list.push(c);
      added.set(c.newHash, list);
    }
  }
  const consumed = new Set<RawChange>();
  const out: RawChange[] = [];
  for (const c of changes) {
    if (c.status === "deleted" && c.oldHash !== null && isFileLike(c.oldType)) {
      const target = added.get(c.oldHash)?.find((x) => !consumed.has(x));
      if (target !== undefined) {
        consumed.add(target);
        consumed.add(c);
        out.push({
          ...target,
          status: "renamed",
          previousPath: c.path,
          oldHash: c.oldHash,
          oldType: c.oldType,
        });
      }
    }
  }
  for (const c of changes) if (!consumed.has(c)) out.push(c);
  return out;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 10) n++;
  return bytes[bytes.length - 1] === 10 ? n : n + 1;
}

const decoder = new TextDecoder();

interface Side {
  bytes: Uint8Array | null;
  /** Estimated line count when the blob was too big to read. */
  estimatedLines: number | null;
  size: number;
}

async function readSide(
  reader: TreeReader,
  hash: string | null,
  type: EntryType | null,
  maxRead: number,
): Promise<Side> {
  if (hash === null || type === "gitlink") return { bytes: null, estimatedLines: null, size: 0 };
  const blob = await reader.readBlob(hash);
  if (blob === null) throw new Error(`blob ${hash} not found`);
  if (blob.size > maxRead)
    return { bytes: null, estimatedLines: Math.ceil(blob.size / 32), size: blob.size };
  return { bytes: await blob.bytes(), estimatedLines: null, size: blob.size };
}

async function fileDiff(
  reader: TreeReader,
  c: RawChange,
  opts: Required<DiffOptions>,
): Promise<ChangeDiffFile> {
  const base: Omit<ChangeDiffFile, "additions" | "deletions" | "binary" | "hunks" | "truncated"> = {
    path: c.path,
    previousPath: c.previousPath,
    status: c.status,
    transformVerified: false,
  };
  if (c.oldType === "gitlink" || c.newType === "gitlink") {
    return { ...base, additions: 0, deletions: 0, binary: true, hunks: [], truncated: false };
  }
  if (c.status === "renamed" && c.oldHash === c.newHash) {
    return { ...base, additions: 0, deletions: 0, binary: false, hunks: [], truncated: false };
  }
  const [old, neu] = await Promise.all([
    readSide(reader, c.oldHash, c.oldType, opts.maxReadBytes),
    readSide(reader, c.newHash, c.newType, opts.maxReadBytes),
  ]);
  if ((old.bytes !== null && isBinary(old.bytes)) || (neu.bytes !== null && isBinary(neu.bytes))) {
    return { ...base, additions: 0, deletions: 0, binary: true, hunks: [], truncated: false };
  }
  const tooBig = old.size > opts.maxFileBytes || neu.size > opts.maxFileBytes;
  if (tooBig || old.estimatedLines !== null || neu.estimatedLines !== null) {
    // Not diffed: count every line on both sides (over-reports, never under-reports).
    const deletions = old.estimatedLines ?? (old.bytes === null ? 0 : countLines(old.bytes));
    const additions = neu.estimatedLines ?? (neu.bytes === null ? 0 : countLines(neu.bytes));
    return { ...base, additions, deletions, binary: false, hunks: [], truncated: true };
  }
  const d = diffText(
    old.bytes === null ? "" : decoder.decode(old.bytes),
    neu.bytes === null ? "" : decoder.decode(neu.bytes),
    {
      context: opts.context,
    },
  );
  return {
    ...base,
    additions: d.additions,
    deletions: d.deletions,
    binary: false,
    hunks: d.hunks,
    truncated: false,
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export function buildChangeDiff(
  baseSha: string,
  headSha: string,
  files: ChangeDiffFile[],
): ChangeDiff {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    baseSha,
    headSha,
    files: sorted,
    additions: sorted.reduce((n, f) => n + f.additions, 0),
    deletions: sorted.reduce((n, f) => n + f.deletions, 0),
  };
}

/** Diff two root trees. */
export async function diffTrees(
  reader: TreeReader,
  input: { baseSha: string; headSha: string; baseTree: string; headTree: string },
  options: DiffOptions = {},
): Promise<ChangeDiff> {
  const opts: Required<DiffOptions> = {
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    maxReadBytes: options.maxReadBytes ?? 16 * 1024 * 1024,
    context: options.context ?? 3,
  };
  const raw: RawChange[] = [];
  await walk(reader, input.baseTree, input.headTree, "", raw);
  const changes = detectRenames(raw);
  const files = await mapLimit(changes, 8, (c) => fileDiff(reader, c, opts));
  return buildChangeDiff(input.baseSha, input.headSha, files);
}
