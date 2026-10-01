/**
 * Byte/text helpers that run unchanged on Cloudflare Workers, browsers and Node 22.
 * Only `TextEncoder`/`TextDecoder` and `crypto.subtle` are used — no Buffer.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decode: throws on malformed input instead of inserting U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Replace lone UTF-16 surrogates with U+FFFD. Use this on untrusted text (test
 * output, truncated logs) before putting it into a payload: canonical JSON
 * rejects lone surrogates because they are not valid I-JSON.
 */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Truncate to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - ellipsis.length);
  let cut = s.slice(0, keep);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + ellipsis.slice(0, max - cut.length);
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) t[B64URL.charCodeAt(i)] = i;
  return t;
})();

export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

/** base64url without padding (RFC 4648 §5). */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Strict base64url decode: rejects padding, characters outside the URL-safe
 * alphabet, impossible lengths and non-zero trailing bits, so every byte string
 * has exactly one accepted encoding (no signature/key-id malleability).
 */
export function base64urlDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new EncodingError("invalid base64url length");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64URL_LOOKUP[c]! : -1;
    if (v < 0) throw new EncodingError(`invalid base64url character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new EncodingError("non-canonical base64url (trailing bits set)");
  return out;
}

export function isBase64url(s: string): boolean {
  try {
    base64urlDecode(s);
    return true;
  } catch {
    return false;
  }
}

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Length-independent-time comparison (for digests). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// --------------------------------------------------------------------------- WebCrypto

/** Opaque WebCrypto key handle. Structural so it type-checks under Node and Workers types. */
export interface WebCryptoKey {
  readonly type: string;
  readonly algorithm: { readonly name: string };
}

type Ed25519Params = { name: "Ed25519" };
type KeyUsage = "sign" | "verify";

/** The subset of SubtleCrypto this package needs. */
export interface MinimalSubtle {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  generateKey(
    algorithm: Ed25519Params,
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<{ publicKey: WebCryptoKey; privateKey: WebCryptoKey }>;
  importKey(
    format: "pkcs8" | "raw",
    keyData: Uint8Array,
    algorithm: Ed25519Params,
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<WebCryptoKey>;
  exportKey(format: "pkcs8" | "raw", key: WebCryptoKey): Promise<ArrayBuffer>;
  exportKey(format: "jwk", key: WebCryptoKey): Promise<{ x?: string; d?: string; crv?: string }>;
  sign(algorithm: Ed25519Params, key: WebCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: Ed25519Params,
    key: WebCryptoKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

export function subtle(): MinimalSubtle {
  const c = (globalThis as unknown as { crypto?: { subtle?: MinimalSubtle } }).crypto;
  if (!c?.subtle) {
    throw new Error("WebCrypto (globalThis.crypto.subtle) is not available in this runtime");
  }
  return c.subtle;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8Encode(data) : data;
  return new Uint8Array(await subtle().digest("SHA-256", bytes));
}

export async function sha256Base64url(data: Uint8Array | string): Promise<string> {
  return base64urlEncode(await sha256(data));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return hexEncode(await sha256(data));
}
