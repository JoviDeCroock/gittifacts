/**
 * Ed25519 key handling over WebCrypto (Workers + Node 22).
 *
 * Wire formats:
 * - private key: base64url(PKCS#8 DER) — 48 bytes for Ed25519
 * - public key:  base64url(raw 32-byte public key)
 * - key id:      base64url(first 16 bytes of SHA-256(raw public key)) — 22 chars
 */
import { z } from "zod";
import {
  base64urlDecode,
  base64urlEncode,
  type EncodingError,
  sha256,
  subtle,
  type WebCryptoKey,
} from "./encoding.js";

export const ED25519 = { name: "Ed25519" } as const;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export class KeyError extends Error {
  override readonly name = "KeyError";
}

export interface SigningKeyPair {
  /** base64url PKCS#8. Keep secret (e.g. `wrangler secret put`). */
  privateKey: string;
  /** base64url raw 32-byte Ed25519 public key. Publish this. */
  publicKey: string;
  keyId: string;
}

/** An imported, non-extractable key. Opaque; pass back into this package. */
export type KeyHandle = WebCryptoKey;

/** base64url(first 16 bytes of SHA-256(raw public key)). Accepts raw bytes or base64url. */
export async function keyIdFor(publicKeyRaw: Uint8Array | string): Promise<string> {
  const raw = typeof publicKeyRaw === "string" ? decodePublicKey(publicKeyRaw) : publicKeyRaw;
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new KeyError(
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return base64urlEncode((await sha256(raw)).slice(0, 16));
}

function decodePublicKey(publicKey: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = base64urlDecode(publicKey.trim());
  } catch (e) {
    throw new KeyError(`public key is not base64url: ${(e as EncodingError).message}`);
  }
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new KeyError(
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

export async function generateSigningKey(): Promise<SigningKeyPair> {
  const pair = await subtle().generateKey(ED25519, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return {
    privateKey: base64urlEncode(pkcs8),
    publicKey: base64urlEncode(raw),
    keyId: await keyIdFor(raw),
  };
}

export async function importPrivateKey(privateKey: string): Promise<KeyHandle> {
  let der: Uint8Array;
  try {
    der = base64urlDecode(privateKey.trim());
  } catch (e) {
    throw new KeyError(`private key is not base64url PKCS#8: ${(e as EncodingError).message}`);
  }
  try {
    return await subtle().importKey("pkcs8", der, ED25519, false, ["sign"]);
  } catch (e) {
    throw new KeyError(`not an Ed25519 PKCS#8 private key: ${(e as Error).message}`);
  }
}

export async function importPublicKey(publicKey: string): Promise<KeyHandle> {
  const raw = decodePublicKey(publicKey);
  try {
    return await subtle().importKey("raw", raw, ED25519, false, ["verify"]);
  } catch (e) {
    throw new KeyError(`not an Ed25519 public key: ${(e as Error).message}`);
  }
}

/** Derive the base64url raw public key from a base64url PKCS#8 private key. */
export async function publicKeyFromPrivateKey(privateKey: string): Promise<string> {
  let der: Uint8Array;
  try {
    der = base64urlDecode(privateKey.trim());
  } catch (e) {
    throw new KeyError(`private key is not base64url PKCS#8: ${(e as EncodingError).message}`);
  }
  let key: WebCryptoKey;
  try {
    key = await subtle().importKey("pkcs8", der, ED25519, true, ["sign"]);
  } catch (e) {
    throw new KeyError(`not an Ed25519 PKCS#8 private key: ${(e as Error).message}`);
  }
  const jwk = await subtle().exportKey("jwk", key);
  if (typeof jwk.x !== "string") throw new KeyError("runtime did not export the public half");
  // JWK `x` is base64url(raw public key); re-encode to normalize.
  return base64urlEncode(decodePublicKey(jwk.x));
}

// --------------------------------------------------------------------------- key sets

export const KeySetEntry = z.object({
  /** Optional; when present it must equal keyIdFor(publicKey) or the entry is ignored. */
  keyId: z.string().optional(),
  publicKey: z.string().min(1),
  /** Signatures whose `signedAt` is after this instant are rejected as `expired-key`. */
  notAfter: z.string().datetime({ offset: true }).optional(),
  /** Free-form label, e.g. "ci-2026-q4". */
  name: z.string().optional(),
});
export type KeySetEntry = z.infer<typeof KeySetEntry>;

/** Trusted verification keys. Several entries allow rotation without breaking old notes. */
export type KeySet = readonly KeySetEntry[];

const KeySetFile = z.union([z.array(KeySetEntry), z.object({ keys: z.array(KeySetEntry) })]);

/** Accepts `[{publicKey, ...}]` or `{ "keys": [...] }` (JWKS-like). Throws on invalid input. */
export function parseKeySet(json: unknown): KeySet {
  const parsed = KeySetFile.safeParse(json);
  if (!parsed.success) {
    throw new KeyError(
      `invalid key set: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.keys;
}

export interface ResolvedKey {
  keyId: string;
  publicKey: string;
  notAfter?: string;
  name?: string;
}

/**
 * Compute key ids for every entry. Entries with an undecodable public key or a
 * stated keyId that does not match the key are dropped (and reported), never trusted.
 */
export async function resolveKeySet(
  keys: KeySet | string,
): Promise<{ keys: ResolvedKey[]; rejected: { entry: KeySetEntry; reason: string }[] }> {
  const entries: KeySet = typeof keys === "string" ? [{ publicKey: keys }] : keys;
  const out: ResolvedKey[] = [];
  const rejected: { entry: KeySetEntry; reason: string }[] = [];
  for (const entry of entries) {
    let keyId: string;
    try {
      keyId = await keyIdFor(entry.publicKey);
    } catch (e) {
      rejected.push({ entry, reason: (e as Error).message });
      continue;
    }
    if (entry.keyId !== undefined && entry.keyId !== keyId) {
      rejected.push({
        entry,
        reason: `stated keyId ${entry.keyId} does not match public key (${keyId})`,
      });
      continue;
    }
    const r: ResolvedKey = { keyId, publicKey: entry.publicKey.trim() };
    if (entry.notAfter !== undefined) r.notAfter = entry.notAfter;
    if (entry.name !== undefined) r.name = entry.name;
    out.push(r);
  }
  return { keys: out, rejected };
}
