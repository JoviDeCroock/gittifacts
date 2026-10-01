/**
 * Compact signed session tokens: `<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`.
 * Uses Web Crypto only, so it runs unchanged in Node, Workers and browsers.
 */

export interface TokenClaims {
  /** Subject: the principal the token was issued to. */
  readonly sub: string;
  /** Expiry, in whole seconds since the Unix epoch. */
  readonly exp: number;
}

const MIN_SECRET_LENGTH = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Signs `claims` with an HMAC-SHA256 key derived from `secret`. */
export async function signToken(claims: TokenClaims, secret: string): Promise<string> {
  if (claims.sub.length === 0) {
    throw new RangeError("signToken: sub must not be empty");
  }
  if (!Number.isSafeInteger(claims.exp)) {
    throw new RangeError("signToken: exp must be an integer number of seconds");
  }
  const payload = toBase64Url(encoder.encode(JSON.stringify({ sub: claims.sub, exp: claims.exp })));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Returns the token's claims when the signature is valid and the token has not
 * expired at `now` (seconds since the epoch). Returns null for anything else.
 */
export async function verifyToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<TokenClaims | null> {
  const [payload, signature, ...rest] = token.split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) {
    return null;
  }
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === null) {
    return null;
  }
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload));
  if (!valid) {
    return null;
  }
  const claims = parseClaims(payload);
  if (claims === null) {
    return null;
  }
  if (claims.exp < now) {
    return null;
  }
  return claims;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new RangeError(`token secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function parseClaims(payload: string): TokenClaims | null {
  const bytes = fromBase64Url(payload);
  if (bytes === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { sub, exp } = value as Record<string, unknown>;
  if (typeof sub !== "string" || sub.length === 0 || typeof exp !== "number") {
    return null;
  }
  if (!Number.isSafeInteger(exp)) {
    return null;
  }
  return { sub, exp };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
