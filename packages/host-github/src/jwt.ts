/**
 * GitHub App JWTs (RS256) with WebCrypto, from the PEM GitHub hands out in the manifest
 * conversion. GitHub's keys are PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto only imports PKCS#8,
 * so PKCS#1 is wrapped in a PKCS#8 PrivateKeyInfo first.
 *
 * Claims (docs/research/github-app.md §5): `iat` = now − 60 s (clock drift), `exp` ≤ 10 min,
 * `iss` = the App's client ID.
 */

const enc = new TextEncoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlJson = (v: unknown) => b64urlBytes(enc.encode(JSON.stringify(v)));

function pemBody(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(
    pem,
  );
  if (m === null) throw new Error("not a PEM private key");
  const bin = atob((m[2] ?? "").replace(/\s+/g, ""));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1: m[1] !== undefined };
}

function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const head = Uint8Array.of(tag, ...derLength(len));
  const out = new Uint8Array(head.length + len);
  out.set(head);
  let o = head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PKCS#1 RSAPrivateKey → PKCS#8 PrivateKeyInfo (version 0, rsaEncryption, NULL params). */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaOid = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01);
  const algorithm = der(0x30, rsaOid, Uint8Array.of(0x05, 0x00));
  return der(0x30, version, algorithm, der(0x04, pkcs1));
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
  const { der: body, pkcs1 } = pemBody(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs1 ? pkcs1ToPkcs8(body) : body,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signAppJwt(input: {
  key: CryptoKey;
  /** The App's client ID (GitHub also accepts the numeric App id). */
  issuer: string;
  now: Date;
  /** Lifetime in seconds after `iat` (≤ 600 + 60 drift). */
  ttlSec?: number;
}): Promise<{ jwt: string; expiresAt: number }> {
  const iat = Math.floor(input.now.getTime() / 1000) - 60;
  const exp = iat + Math.min(input.ttlSec ?? 540, 600);
  const signingInput = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({ iat, exp, iss: input.issuer })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", input.key, enc.encode(signingInput));
  return { jwt: `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`, expiresAt: exp * 1000 };
}
