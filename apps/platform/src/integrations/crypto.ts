/**
 * Integration credentials and webhook signing.
 *
 * - client ids `gtic_…` (public), client secrets `gtis_…`, access tokens `gti_…`, refresh tokens
 *   `gtir_…`, generated webhook secrets `whsec_…`: 32 random bytes, base64url. Secrets and tokens
 *   are stored as SHA-256 hex only.
 * - Webhook secrets are needed in plaintext to sign, so they are stored AES-256-GCM encrypted
 *   under HKDF-SHA-256(BETTER_AUTH_SECRET, "gittifacts/webhook-secret/v1").
 * - `X-Gittifacts-Signature-256: sha256=<hex HMAC-SHA-256(secret, raw body)>`.
 */
import { base64urlDecode, base64urlEncode } from "@app/evidence";

export const CLIENT_ID_PREFIX = "gtic_";
export const CLIENT_SECRET_PREFIX = "gtis_";
export const ACCESS_TOKEN_PREFIX = "gti_";
export const REFRESH_TOKEN_PREFIX = "gtir_";
export const WEBHOOK_SECRET_PREFIX = "whsec_";

const ACCESS_SHAPE = /^gti_[A-Za-z0-9_-]{43}$/;
const REFRESH_SHAPE = /^gtir_[A-Za-z0-9_-]{43}$/;
const SECRET_SHAPE = /^gtis_[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_SHAPE = /^gtic_[a-z0-9]{24}$/;

export function randomSecret(prefix: string, bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}${base64urlEncode(b)}`;
}

export function newClientId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `${CLIENT_ID_PREFIX}${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export const isIntegrationClientId = (s: string | null | undefined): boolean =>
  typeof s === "string" && CLIENT_ID_SHAPE.test(s);
export const isIntegrationAccessToken = (s: string): boolean => ACCESS_SHAPE.test(s);
export const isIntegrationRefreshToken = (s: string): boolean => REFRESH_SHAPE.test(s);
export const isClientSecretShape = (s: string): boolean => SECRET_SHAPE.test(s);
/** Anything that looks like it was meant to be an integration access token (for routing). */
export const looksLikeIntegrationToken = (s: string): boolean => s.startsWith(ACCESS_TOKEN_PREFIX);

/** Constant-time string comparison (same length required). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256=<hex>` over the raw body. */
export async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${hex(mac)}`;
}

export async function verifyWebhook(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  return timingSafeEqual(await signWebhook(secret, body), header);
}

async function secretKey(masterSecret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("gittifacts"),
      info: new TextEncoder().encode("gittifacts/webhook-secret/v1"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(masterSecret: string, plaintext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await secretKey(masterSecret),
    new TextEncoder().encode(plaintext),
  );
  return `v1.${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ct))}`;
}

export async function decryptSecret(masterSecret: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unknown webhook secret format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(iv) },
    await secretKey(masterSecret),
    base64urlDecode(ct),
  );
  return new TextDecoder().decode(pt);
}

/** The master secret webhook secrets are sealed under (BETTER_AUTH_SECRET, required). */
export function masterSecretOf(env: { BETTER_AUTH_SECRET?: string }): string {
  const s = env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("BETTER_AUTH_SECRET is not set; webhook secrets cannot be sealed");
  return s;
}
