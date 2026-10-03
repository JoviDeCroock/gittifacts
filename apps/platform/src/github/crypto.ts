/**
 * GitHub mode's cryptography:
 * - Webhooks: `X-Hub-Signature-256: sha256=<hex HMAC-SHA-256(webhook secret, raw body)>`, compared
 *   in constant time (docs/research/github-app.md §4).
 * - The install verification's OAuth `state`: a signed, 10-minute token naming the signed-in
 *   human and the installation, bound to the browser by a nonce cookie (single use: the cookie is
 *   cleared at the callback, and GitHub's code works once). The key is HKDF(BETTER_AUTH_SECRET,
 *   "gittifacts/github-oauth-state/v1"); nothing is stored.
 */
import { base64urlDecode, base64urlEncode } from "@app/evidence";

const enc = new TextEncoder();
const dec = new TextDecoder();

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

/** Verify `X-Hub-Signature-256` over the raw body against any of `secrets`, in constant time. */
export async function verifyGithubSignature(
  secrets: string | readonly string[],
  rawBody: ArrayBuffer | Uint8Array,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  let ok = false;
  for (const s of typeof secrets === "string" ? [secrets] : secrets) {
    if (s === "") continue;
    // Every candidate is checked (no early exit), so timing doesn't say which matched.
    if (
      timingSafeEqualBytes(enc.encode(await githubSignature(s, rawBody)), enc.encode(header.trim()))
    )
      ok = true;
  }
  return ok;
}

export function randomNonce(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64urlEncode(b);
}

const stateKeys = new Map<string, Promise<CryptoKey>>();

function stateKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  let k = stateKeys.get(secret);
  if (k === undefined) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("gittifacts"),
          info: enc.encode("gittifacts/github-oauth-state/v1"),
        },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    stateKeys.set(secret, k);
  }
  return k;
}

export interface InstallState {
  /** The platform human who started it. */
  principalId: string;
  installationId: number;
  /** Matches the browser's nonce cookie. */
  nonce: string;
  /** Expiry (ms since epoch). */
  exp: number;
}

export async function signInstallState(
  secret: string | undefined,
  s: InstallState,
): Promise<string> {
  const body = base64urlEncode(enc.encode(JSON.stringify(s)));
  const mac = await crypto.subtle.sign("HMAC", await stateKey(secret), enc.encode(body));
  return `${body}.${base64urlEncode(new Uint8Array(mac))}`;
}

/** The state if we signed it and it hasn't expired; null otherwise (constant-time MAC check). */
export async function verifyInstallState(
  secret: string | undefined,
  state: string,
  now: number,
): Promise<InstallState | null> {
  const m = /^([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (m === null) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await stateKey(secret),
      base64urlDecode(m[2] as string),
      enc.encode(m[1] as string),
    );
    if (!ok) return null;
    const s = JSON.parse(dec.decode(base64urlDecode(m[1] as string))) as InstallState;
    if (
      typeof s.principalId !== "string" ||
      !Number.isInteger(s.installationId) ||
      typeof s.nonce !== "string" ||
      typeof s.exp !== "number"
    )
      return null;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}
