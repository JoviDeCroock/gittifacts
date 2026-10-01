/**
 * Byte helpers built only on Web APIs available in both Cloudflare Workers and Node 22:
 * TextEncoder/TextDecoder, crypto.subtle (SHA-1 digest), CompressionStream, Blob/Response.
 */

/** A Uint8Array that owns a plain ArrayBuffer (what Web APIs such as `digest` accept). */
export type Bytes = Uint8Array<ArrayBuffer>;

export const ZERO_SHA = "0".repeat(40);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (s: string): Bytes => encoder.encode(s);
export const text = (b: Uint8Array): string => decoder.decode(b);

/** Returns `b` itself when it already owns an ArrayBuffer, else a copy (e.g. SharedArrayBuffer). */
export function own(b: Uint8Array): Bytes {
  return b.buffer instanceof ArrayBuffer ? (b as Bytes) : new Uint8Array(b);
}

export function concat(parts: readonly Uint8Array[]): Bytes {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const HEX_DIGITS = "0123456789abcdef";

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += HEX_DIGITS.charAt(x >> 4) + HEX_DIGITS.charAt(x & 15);
  return s;
}

export function fromHex(hex: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new TypeError(`invalid hex string: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const isSha = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);

export function assertSha(s: string, what: string): void {
  if (!isSha(s)) throw new TypeError(`${what} must be a 40-char lowercase hex SHA-1, got ${s}`);
}

export async function sha1(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", own(data)));
}

/** zlib-wrapped DEFLATE (RFC 1950) — the "deflate" CompressionStream format is what git uses. */
export async function deflate(data: Uint8Array): Promise<Bytes> {
  const stream = new Blob([own(data)]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function base64(s: string): string {
  let bin = "";
  for (const b of utf8(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}
