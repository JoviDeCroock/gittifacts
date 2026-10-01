/**
 * Packfile v2 writer (non-delta) and reader (resolves OFS_DELTA / REF_DELTA against in-pack bases).
 * Format: git Documentation/gitformat-pack.txt "pack-*.pack files have the following format" and
 * "Deltified representation".
 */
import { type Bytes, concat, deflate, sha1, text, toHex, utf8 } from "./bytes.js";
import { GitProtocolError } from "./errors.js";
import { inflateAt } from "./inflate.js";
import { type GitObject, hashObject, type ObjectType } from "./objects.js";

export interface PackedObject extends GitObject {
  sha: string;
}

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

/** Entry header: 3-bit type and the size as a little-endian base-128 varint (4 bits first). */
function entryHeader(type: number, size: number): Bytes {
  const out: number[] = [];
  let byte = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return Uint8Array.from(out);
}

/**
 * Builds a self-contained, undeltified v2 pack. Objects must be distinct (git's index-pack
 * rejects duplicates in strict mode). An empty list yields the 32-byte empty pack.
 */
export async function buildPack(objects: readonly GitObject[]): Promise<Bytes> {
  const entries = await Promise.all(
    objects.map(async (o) =>
      concat([entryHeader(TYPE_CODES[o.type], o.data.length), await deflate(o.data)]),
    ),
  );
  const body = concat([utf8("PACK"), u32(2), u32(objects.length), ...entries]);
  return concat([body, await sha1(body)]);
}

interface RawEntry {
  offset: number;
  type: number;
  data: Bytes;
  baseOffset?: number;
  baseSha?: string;
}

/**
 * Parses a pack into fully resolved objects (pack order). Deltas may only reference objects in
 * the same pack: a thin pack (gitprotocol-capabilities.txt "thin-pack") fails with a clear error.
 */
export async function parsePack(pack: Uint8Array): Promise<PackedObject[]> {
  if (pack.length < 32 || text(pack.subarray(0, 4)) !== "PACK") {
    throw new GitProtocolError("not a packfile");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new GitProtocolError(`unsupported pack v${version}`);
  const count = view.getUint32(8);
  const end = pack.length - 20;
  if (toHex(await sha1(pack.subarray(0, end))) !== toHex(pack.subarray(end))) {
    throw new GitProtocolError("pack checksum mismatch");
  }

  const byte = (p: number): number => {
    if (p >= end) throw new GitProtocolError("truncated pack entry");
    return pack[p]!;
  };
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let c = byte(pos++);
    const type = (c >> 4) & 7;
    let size = c & 15;
    for (let mul = 16; c & 0x80; mul *= 128) {
      c = byte(pos++);
      size += (c & 0x7f) * mul;
    }
    const entry: Partial<RawEntry> = { offset, type };
    if (type === OFS_DELTA) {
      // Negative offset, big-endian base-128 with an implicit +1 per continuation byte.
      c = byte(pos++);
      let rel = c & 0x7f;
      while (c & 0x80) {
        c = byte(pos++);
        rel = (rel + 1) * 128 + (c & 0x7f);
      }
      if (rel <= 0 || rel > offset) throw new GitProtocolError("bad OFS_DELTA offset");
      entry.baseOffset = offset - rel;
    } else if (type === REF_DELTA) {
      if (pos + 20 > end) throw new GitProtocolError("truncated REF_DELTA base");
      entry.baseSha = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (!CODE_TYPES[type]) {
      throw new GitProtocolError(`unknown pack object type ${type}`);
    }
    const { data, end: next } = inflateAt(pack.subarray(0, end), pos, size);
    raw.push({ ...entry, data } as RawEntry);
    pos = next;
  }
  if (pos !== end) throw new GitProtocolError("trailing garbage after pack entries");

  // Resolve with a worklist: each resolved object releases the deltas waiting on it, so
  // chains resolve in O(n) whatever order the bases appear in.
  const byOffset = new Map<number, PackedObject>();
  const waiting = new Map<string, RawEntry[]>();
  const wait = (key: string, e: RawEntry) => {
    const list = waiting.get(key);
    if (list) list.push(e);
    else waiting.set(key, [e]);
  };
  const ready: Array<[RawEntry, ObjectType, Bytes]> = [];
  for (const e of raw) {
    if (e.baseOffset !== undefined) wait(`@${e.baseOffset}`, e);
    else if (e.baseSha !== undefined) wait(e.baseSha, e);
    else ready.push([e, CODE_TYPES[e.type]!, e.data]);
  }
  while (ready.length) {
    const [e, type, data] = ready.pop()!;
    const obj: PackedObject = { type, data, sha: await hashObject({ type, data }) };
    byOffset.set(e.offset, obj);
    for (const key of [`@${e.offset}`, obj.sha]) {
      for (const d of waiting.get(key) ?? []) ready.push([d, type, applyDelta(data, d.data)]);
      waiting.delete(key);
    }
  }
  if (waiting.size) {
    const missing = [...waiting.keys()].filter((k) => !k.startsWith("@"));
    throw new GitProtocolError(
      `unresolved delta bases (thin pack?): ${missing.slice(0, 3).join(", ") || "in-pack offsets"}`,
    );
  }
  return raw.map((e) => byOffset.get(e.offset)!);
}

/** Applies a git delta (gitformat-pack.txt "Deltified representation"). */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Bytes {
  let pos = 0;
  const next = (): number => {
    if (pos >= delta.length) throw new GitProtocolError("truncated delta");
    return delta[pos++]!;
  };
  const varint = (): number => {
    let value = 0;
    let c: number;
    let mul = 1;
    do {
      c = next();
      value += (c & 0x7f) * mul;
      mul *= 128;
    } while (c & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new GitProtocolError("delta base size mismatch");
  const out = new Uint8Array(varint());
  let o = 0;
  while (pos < delta.length) {
    const op = next();
    if (op & 0x80) {
      // Copy from base: bits 0-3 select offset bytes, bits 4-6 select size bytes (LE).
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += next() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size += next() * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > out.length) {
        throw new GitProtocolError("delta copy out of range");
      }
      out.set(base.subarray(off, off + size), o);
      o += size;
    } else if (op) {
      // Insert the next `op` literal bytes.
      if (pos + op > delta.length || o + op > out.length) {
        throw new GitProtocolError("delta insert out of range");
      }
      out.set(delta.subarray(pos, pos + op), o);
      pos += op;
      o += op;
    } else {
      throw new GitProtocolError("delta opcode 0 is reserved");
    }
  }
  if (o !== out.length) throw new GitProtocolError("delta result size mismatch");
  return out;
}
