/**
 * Key material for GitHub mode.
 *
 * - `GITHUB_APP_KEK` (Worker secret): 32 random bytes, base64 or base64url. Two subkeys are derived
 *   from it with HKDF-SHA-256 so one secret never serves two purposes:
 *     - "gittifacts/github-app/seal/v1" → AES-256-GCM for App credentials (client secret, webhook
 *       secret, PEM). Each ciphertext is bound to its App id and field through the AAD, so a
 *       ciphertext copied into another row or column fails to open.
 *     - "gittifacts/github-app/state/v1" → HMAC-SHA-256 over `state` nonces.
 * - Webhooks: `X-Hub-Signature-256: sha256=<hex HMAC-SHA-256(webhook secret, raw body)>`, compared
 *   in constant time (docs/research/github-app.md §4).
 */
import { base64urlDecode, base64urlEncode } from "@app/evidence";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class MissingKek extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingKek";
  }
}

/** Decode the KEK secret (standard or url-safe base64, padding optional) and check its size. */
export function kekBytes(raw: string | undefined): Uint8Array {
  const s = raw?.trim();
  if (!s) throw new MissingKek("GITHUB_APP_KEK is not set: GitHub App credentials cannot be sealed");
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  } catch {
    throw new MissingKek("GITHUB_APP_KEK is not base64");
  }
  if (bytes.length !== 32) throw new MissingKek("GITHUB_APP_KEK must be 32 bytes (base64)");
  return bytes;
}

export interface GithubKeys {
  seal: CryptoKey;
  state: CryptoKey;
}

const keyCache = new Map<string, Promise<GithubKeys>>();

/** The two subkeys of a KEK (cached per isolate). */
export function githubKeys(kek: string | undefined): Promise<GithubKeys> {
  const bytes = kekBytes(kek);
  const id = base64urlEncode(bytes);
  let p = keyCache.get(id);
  if (!p) {
    p = derive(bytes);
    keyCache.set(id, p);
    p.catch(() => keyCache.delete(id));
  }
  return p;
}

async function derive(bytes: Uint8Array): Promise<GithubKeys> {
  const ikm = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: enc.encode("gittifacts"),
    info: enc.encode(info),
  });
  const seal = await crypto.subtle.deriveKey(
    hkdf("gittifacts/github-app/seal/v1"),
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const state = await crypto.subtle.deriveKey(
    hkdf("gittifacts/github-app/state/v1"),
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
  return { seal, state };
}

/** The credential fields we seal; part of the AAD. */
export type SealedField = "client_secret" | "webhook_secret" | "pem";

const aad = (appId: number, field: SealedField) =>
  enc.encode(`gittifacts/github-app/v1|${appId}|${field}`);

export async function sealCredential(
  keys: GithubKeys,
  appId: number,
  field: SealedField,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(appId, field) },
    keys.seal,
    enc.encode(plaintext),
  );
  return `v1.${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ct))}`;
}

/** Throws on a wrong key, a tampered ciphertext, or one sealed for another App or field. */
export async function openCredential(
  keys: GithubKeys,
  appId: number,
  field: SealedField,
  sealed: string,
): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unknown sealed credential format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(iv), additionalData: aad(appId, field) },
    keys.seal,
    base64urlDecode(ct),
  );
  return dec.decode(pt);
}

/** `<nonce>.<mac>`: the nonce is the D1 row id, the MAC proves we issued it. */
export async function signState(keys: GithubKeys, nonce: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", keys.state, enc.encode(`state|${nonce}`));
  return `${nonce}.${base64urlEncode(new Uint8Array(mac))}`;
}

/** The nonce of a state we issued, or null (malformed or forged). Constant-time (subtle.verify). */
export async function verifiedStateNonce(keys: GithubKeys, state: string): Promise<string | null> {
  const m = /^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (!m) return null;
  const [, nonce, mac] = m as unknown as [string, string, string];
  let sig: Uint8Array;
  try {
    sig = base64urlDecode(mac);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", keys.state, sig, enc.encode(`state|${nonce}`));
  return ok ? nonce : null;
}

export function randomNonce(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64urlEncode(b);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two byte strings (length leaks, content doesn't). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** `sha256=<hex>` of the raw body. */
export async function githubSignature(secret: string, rawBody: ArrayBuffer | Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, rawBody))}`;
}

/** Verify `X-Hub-Signature-256` over the raw body, in constant time. */
export async function verifyGithubSignature(
  secret: string,
  rawBody: ArrayBuffer | Uint8Array,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = await githubSignature(secret, rawBody);
  return timingSafeEqualBytes(enc.encode(expected), enc.encode(header.trim()));
}
