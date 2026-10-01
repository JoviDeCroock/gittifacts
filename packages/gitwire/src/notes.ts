/**
 * git notes over the wire. A notes ref points at a commit whose tree maps annotated object ids
 * to note blobs, either flat (`<40 hex>`) or fanned out into 2-hex directories
 * (`ab/cdef…`, possibly several levels). See git Documentation/git-notes.txt and notes.c
 * `load_subtree`. We read every layout, write new notes flat at the root, and rewrite an
 * existing note in place so fanout trees written by git are preserved.
 */
import { assertSha, concat, text, utf8, ZERO_SHA } from "./bytes.js";
import { GitProtocolError, StaleRefError } from "./errors.js";
import { type GitRemote, listRefs } from "./http.js";
import {
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  type GitObject,
  hashObject,
  isTreeMode,
  type ObjectType,
  type Signature,
  type TreeEntry,
} from "./objects.js";
import { buildPack, type PackedObject, parsePack } from "./pack.js";
import { assertRefUpdated, receivePack } from "./receive.js";
import { fetchPack } from "./upload.js";

/**
 * Pluggable object source. The wire implementation fetches a pack; a Worker can instead adapt
 * the Artifacts binding (`readCommit` / `readTree` / `readBlob`) to this interface.
 */
export interface ObjectReader {
  resolveRef(ref: string): Promise<string | undefined>;
  readObject(sha: string): Promise<GitObject | undefined>;
}

/** In-memory ObjectReader, e.g. over the result of parsePack. */
export class MemoryObjectStore implements ObjectReader {
  private readonly objects = new Map<string, GitObject>();
  constructor(
    objects: Iterable<PackedObject> = [],
    readonly refs = new Map<string, string>(),
  ) {
    this.add(objects);
  }
  add(objects: Iterable<PackedObject>): void {
    for (const o of objects) this.objects.set(o.sha, o);
  }
  async resolveRef(ref: string): Promise<string | undefined> {
    return this.refs.get(ref);
  }
  async readObject(sha: string): Promise<GitObject | undefined> {
    return this.objects.get(sha);
  }
}

export const DEFAULT_NOTES_REF = "refs/notes/evidence";

/**
 * ObjectReader over a remote notes ref: one depth-1 fetch of the tip (blobless when the server
 * advertises `filter`, so cost scales with the tree, not with every note ever written), then
 * single objects fetched on demand like a promisor remote. gitprotocol-v2.txt "fetch": "Wants
 * can be anything and are not limited to advertised objects."
 */
async function remoteReader(remote: GitRemote, notesRef: string): Promise<ObjectReader> {
  const refs = await listRefs(remote, { prefixes: [notesRef] });
  const tip = refs.get(notesRef);
  const store = new MemoryObjectStore([], new Map(tip ? [[notesRef, tip]] : []));
  if (tip) {
    const fetchCap = [...refs.capabilities].find((c) => c.startsWith("fetch="));
    const filter = fetchCap?.slice(6).split(" ").includes("filter") ? "blob:none" : undefined;
    store.add(await parsePack(await fetchPack(remote, { wants: [tip], depth: 1, filter })));
  }
  return {
    resolveRef: (ref) => store.resolveRef(ref),
    async readObject(sha) {
      if (!(await store.readObject(sha)))
        store.add(await parsePack(await fetchPack(remote, { wants: [sha] })));
      return store.readObject(sha);
    },
  };
}

async function read(reader: ObjectReader, sha: string, type: ObjectType): Promise<Uint8Array> {
  const obj = await reader.readObject(sha);
  if (obj?.type === type) return obj.data;
  throw new GitProtocolError(`expected ${type} ${sha}, got ${obj?.type ?? "nothing"}`);
}

/** Path of the note for `target` under `tree` (e.g. ["ab", "cdef…"]) and its blob id. */
async function findNote(
  reader: ObjectReader,
  tree: string,
  target: string,
): Promise<{ path: string[]; blob: string } | undefined> {
  const path: string[] = [];
  let rest = target;
  for (;;) {
    const entries = decodeTree(await read(reader, tree, "tree"));
    const note = entries.find((e) => e.name === rest && !isTreeMode(e.mode));
    if (note) return { path: [...path, rest], blob: note.sha };
    const sub = entries.find((e) => isTreeMode(e.mode) && e.name === rest.slice(0, 2));
    if (!sub || rest.length <= 2) return undefined;
    path.push(sub.name);
    rest = rest.slice(2);
    tree = sub.sha;
  }
}

async function noteTree(reader: ObjectReader, notesRef: string): Promise<string | undefined> {
  const tip = await reader.resolveRef(notesRef);
  return tip ? decodeCommit(await read(reader, tip, "commit")).tree : undefined;
}

/** Reads the note attached to `targetSha`, or null if there is none. */
export async function readNote(
  source: GitRemote | ObjectReader,
  notesRef: string,
  targetSha: string,
): Promise<string | null> {
  assertSha(targetSha, "targetSha");
  const reader = "url" in source ? await remoteReader(source, notesRef) : source;
  const tree = await noteTree(reader, notesRef);
  const found = tree ? await findNote(reader, tree, targetSha) : undefined;
  return found ? text(await read(reader, found.blob, "blob")) : null;
}

/** Writes `tree` with `path` set to `blob`, pushing every new tree onto `created`. */
async function putPath(
  reader: ObjectReader,
  tree: string | undefined,
  path: string[],
  blob: string,
  created: GitObject[],
): Promise<string> {
  const [name, ...rest] = path;
  if (!name) throw new TypeError("empty note path");
  const entries = tree ? decodeTree(await read(reader, tree, "tree")) : [];
  const existing = entries.find((e) => e.name === name);
  const entry: TreeEntry = rest.length
    ? { mode: "40000", name, sha: await putPath(reader, existing?.sha, rest, blob, created) }
    : { mode: "100644", name, sha: blob };
  const obj: GitObject = {
    type: "tree",
    data: encodeTree([...entries.filter((e) => e !== existing), entry]),
  };
  created.push(obj);
  return hashObject(obj);
}

export type SignatureInput = Omit<Signature, "timestamp" | "timezone"> &
  Partial<Pick<Signature, "timestamp" | "timezone">>;

export interface WriteNoteOptions {
  notesRef?: string;
  targetSha: string;
  content: string | Uint8Array;
  author: SignatureInput;
  /** Defaults to the author. */
  committer?: SignatureInput;
  message?: string;
  /** "append" follows `git notes append`: old + "\n" + new (no separator if old is empty). */
  mode?: "replace" | "append";
  /** CAS retries after a lost race (default 3). */
  maxRetries?: number;
}

export interface WriteNoteResult {
  notesCommit: string;
  /** False when the note already had exactly this content (nothing pushed). */
  changed: boolean;
  attempts: number;
}

const sig = (s: SignatureInput, now: number): Signature => ({
  name: s.name,
  email: s.email,
  timestamp: s.timestamp ?? now,
  timezone: s.timezone ?? "+0000",
});

async function writeOnce(remote: GitRemote, opts: WriteNoteOptions, notesRef: string) {
  const reader = await remoteReader(remote, notesRef);
  const tip = await reader.resolveRef(notesRef);
  const tree = await noteTree(reader, notesRef);
  const found = tree ? await findNote(reader, tree, opts.targetSha) : undefined;
  let data = typeof opts.content === "string" ? utf8(opts.content) : opts.content;
  if (opts.mode === "append" && found) {
    const old = await read(reader, found.blob, "blob");
    if (old.length) data = concat([old, utf8("\n"), data]);
  }
  const blob: GitObject = { type: "blob", data };
  const blobSha = await hashObject(blob);
  if (tip && found?.blob === blobSha) return { notesCommit: tip, changed: false };

  const created: GitObject[] = [blob];
  const newTree = await putPath(reader, tree, found?.path ?? [opts.targetSha], blobSha, created);
  const now = Math.floor(Date.now() / 1000);
  const author = sig(opts.author, now);
  const verb = opts.mode === "append" ? "append" : "add";
  const commit: GitObject = {
    type: "commit",
    data: encodeCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      author,
      committer: opts.committer ? sig(opts.committer, now) : author,
      message: opts.message ?? `Notes added by 'git notes ${verb}'\n`,
    }),
  };
  const notesCommit = await hashObject(commit);
  const pack = await buildPack([...created, commit]);
  const update = { ref: notesRef, oldSha: tip ?? ZERO_SHA, newSha: notesCommit };
  assertRefUpdated(await receivePack(remote, [update], pack), notesRef);
  return { notesCommit, changed: true };
}

/**
 * Adds/replaces/appends the note for `targetSha` and pushes a new notes commit whose parent is
 * the current tip, with CAS on the notes ref. A lost race (StaleRefError) re-reads and retries.
 */
export async function writeNote(
  remote: GitRemote,
  opts: WriteNoteOptions,
): Promise<WriteNoteResult> {
  assertSha(opts.targetSha, "targetSha");
  const notesRef = opts.notesRef ?? DEFAULT_NOTES_REF;
  const maxRetries = opts.maxRetries ?? 3;
  for (let attempts = 1; ; attempts++) {
    try {
      return { ...(await writeOnce(remote, opts, notesRef)), attempts };
    } catch (err) {
      if (!(err instanceof StaleRefError) || attempts > maxRetries) throw err;
    }
  }
}
