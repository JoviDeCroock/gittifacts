/**
 * Minimal zlib (RFC 1950) / DEFLATE (RFC 1951) decoder, structured after zlib's contrib/puff.
 *
 * Why not DecompressionStream: pack entries are zlib streams laid end to end with no length
 * prefix (gitformat-pack.txt "pack-*.pack files have the following format"), so the parser must
 * know exactly how many compressed bytes each entry consumed. DecompressionStream cannot report
 * that and rejects trailing bytes, so we decode ourselves. Output size is known from the pack
 * entry header, which lets us allocate once and bound every write.
 */
import type { Bytes } from "./bytes.js";
import { GitProtocolError } from "./errors.js";

interface Huffman {
  count: Uint16Array; // number of codes of each length 0..15
  symbol: Uint16Array; // symbols ordered by code
}

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const fail = (msg: string): never => {
  throw new GitProtocolError(`inflate: ${msg}`);
};

function huffman(lengths: Uint8Array): Huffman {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(lengths.length);
  for (const len of lengths) count[len]!++;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = left * 2 - count[len]!;
    if (left < 0) fail("over-subscribed huffman code");
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + count[len]!;
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s]!;
    if (len !== 0) symbol[offs[len]!++] = s;
  }
  return { count, symbol };
}

let fixed: { lit: Huffman; dist: Huffman } | undefined;
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixed) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
    fixed = { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) };
  }
  return fixed;
}

class Inflater {
  private bitBuf = 0;
  private bitCnt = 0;
  readonly out: Bytes;
  outPos = 0;

  constructor(
    private readonly src: Uint8Array,
    public pos: number,
    size: number,
  ) {
    this.out = new Uint8Array(size);
  }

  byte(): number {
    if (this.pos >= this.src.length) fail("truncated input");
    return this.src[this.pos++]!;
  }

  /** Reads `need` (<= 13) bits LSB-first, fetching input bytes only on demand. */
  bits(need: number): number {
    let val = this.bitBuf;
    while (this.bitCnt < need) {
      val |= this.byte() << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCnt -= need;
    return val & ((1 << need) - 1);
  }

  /** Drops the partial byte so `pos` is the next unread byte (stored blocks, stream end). */
  align(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return fail("invalid huffman code");
  }

  stored(): void {
    this.align();
    const len = this.byte() | (this.byte() << 8);
    const nlen = this.byte() | (this.byte() << 8);
    if (len !== (~nlen & 0xffff)) fail("stored block length mismatch");
    if (this.pos + len > this.src.length) fail("truncated stored block");
    if (this.outPos + len > this.out.length) fail("output larger than declared size");
    this.out.set(this.src.subarray(this.pos, this.pos + len), this.outPos);
    this.pos += len;
    this.outPos += len;
  }

  codes(lit: Huffman, dist: Huffman): void {
    const out = this.out;
    for (;;) {
      let sym = this.decode(lit);
      if (sym < 256) {
        if (this.outPos >= out.length) fail("output larger than declared size");
        out[this.outPos++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) fail("invalid length symbol");
        const len = LEN_BASE[sym]! + this.bits(LEN_EXTRA[sym]!);
        const dsym = this.decode(dist);
        if (dsym >= 30) fail("invalid distance symbol");
        const d = DIST_BASE[dsym]! + this.bits(DIST_EXTRA[dsym]!);
        if (d > this.outPos) fail("distance too far back");
        if (this.outPos + len > out.length) fail("output larger than declared size");
        for (let i = 0; i < len; i++, this.outPos++) out[this.outPos] = out[this.outPos - d]!;
      }
    }
  }

  dynamic(): void {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) fail("bad dynamic block counts");
    const clLengths = new Uint8Array(19);
    for (let i = 0; i < ncode; i++) clLengths[CODE_LENGTH_ORDER[i]!] = this.bits(3);
    const cl = huffman(clLengths);
    const lengths = new Uint8Array(nlen + ndist);
    for (let i = 0; i < lengths.length; ) {
      const sym = this.decode(cl);
      if (sym < 16) {
        lengths[i++] = sym;
        continue;
      }
      let value = 0;
      let repeat: number;
      if (sym === 16) {
        if (i === 0) fail("repeat with no previous length");
        value = lengths[i - 1]!;
        repeat = 3 + this.bits(2);
      } else if (sym === 17) repeat = 3 + this.bits(3);
      else repeat = 11 + this.bits(7);
      if (i + repeat > lengths.length) fail("too many code lengths");
      lengths.fill(value, i, i + repeat);
      i += repeat;
    }
    if (lengths[256] === 0) fail("no end-of-block code");
    this.codes(huffman(lengths.subarray(0, nlen)), huffman(lengths.subarray(nlen)));
  }
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + 5552, data.length); // largest n with no uint32 overflow before mod
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (b * 65536 + a) >>> 0;
}

/**
 * Inflates the zlib stream starting at `src[pos]`, which must decompress to exactly `size`
 * bytes. Returns the data and the offset just past the stream (after its Adler-32 trailer).
 */
export function inflateAt(src: Uint8Array, pos: number, size: number): { data: Bytes; end: number } {
  const cmf = src[pos];
  const flg = src[pos + 1];
  if (cmf === undefined || flg === undefined) return fail("truncated zlib header");
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) {
    fail("bad zlib header");
  }
  const inf = new Inflater(src, pos + 2, size);
  let last = 0;
  while (!last) {
    last = inf.bits(1);
    const type = inf.bits(2);
    if (type === 0) inf.stored();
    else if (type === 1) inf.codes(fixedTables().lit, fixedTables().dist);
    else if (type === 2) inf.dynamic();
    else fail("invalid block type 3");
  }
  if (inf.outPos !== size) fail(`size mismatch: got ${inf.outPos}, expected ${size}`);
  inf.align();
  const sum = ((inf.byte() << 24) | (inf.byte() << 16) | (inf.byte() << 8) | inf.byte()) >>> 0;
  if (sum !== adler32(inf.out)) fail("adler-32 mismatch");
  return { data: inf.out, end: inf.pos };
}
