/**
 * Signed QA thumbnails for GitHub (docs/research/agentic-qa.md §5). GitHub renders comment images
 * through Camo, which must fetch them from a public URL, and an App can't upload attachments. So
 * only thumbnails (≤ 400 px) get a URL, HMAC-signed under a key derived from BETTER_AUTH_SECRET
 * ("gittifacts/qa-image/v1"), valid QA_IMAGE_TTL_MS; then 410. Full-size steps and the replay
 * stay behind sign-in on gittifacts.
 */
import { base64urlDecode, base64urlEncode } from "@app/evidence";

export const QA_IMAGE_TTL_MS = 72 * 3_600_000;
const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  let k = keys.get(secret);
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
          info: enc.encode("gittifacts/qa-image/v1"),
        },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    keys.set(secret, k);
  }
  return k;
}

const NAME = /^[A-Za-z0-9._-]{1,120}$/;
const RUN = /^[A-Za-z0-9._-]{1,100}$/;
const message = (runId: string, name: string, exp: number) =>
  enc.encode(`${runId}\n${name}\n${exp}`);

/** `/qa-img/<runId>/<name>?exp=<ms>&sig=<b64url>` on `origin`. Thumbnails only. */
export async function signedQaImageUrl(
  secret: string | undefined,
  origin: string,
  runId: string,
  name: string,
  now: number,
  ttlMs = QA_IMAGE_TTL_MS,
): Promise<string> {
  if (!RUN.test(runId) || !NAME.test(name)) throw new Error("bad QA image name");
  const exp = now + ttlMs;
  const sig = await crypto.subtle.sign("HMAC", await key(secret), message(runId, name, exp));
  return `${origin.replace(/\/+$/, "")}/qa-img/${runId}/${name}?exp=${exp}&sig=${base64urlEncode(new Uint8Array(sig))}`;
}

export type QaImageCheck = "ok" | "expired" | "invalid";

export async function verifyQaImage(
  secret: string | undefined,
  runId: string,
  name: string,
  exp: string | undefined,
  sig: string | undefined,
  now: number,
): Promise<QaImageCheck> {
  if (!RUN.test(runId) || !NAME.test(name) || exp === undefined || sig === undefined)
    return "invalid";
  if (!/^\d{10,16}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return "invalid";
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      base64urlDecode(sig),
      message(runId, name, Number(exp)),
    );
  } catch {
    return "invalid";
  }
  if (!ok) return "invalid";
  return Number(exp) < now ? "expired" : "ok";
}
