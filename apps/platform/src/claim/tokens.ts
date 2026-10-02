/**
 * Claim tokens (`gtc_…`, in the claimUrl a human opens). Derived, not random-and-forgotten:
 * HMAC-SHA-256 under the platform's auth secret over the project's claim row, so the platform
 * can repeat the link to the project's own agent (e.g. in a quota error) without storing it.
 * Only the SHA-256 of the token is stored; lookups go by that hash. A claim token is single-use:
 * once a human claims the project, it only ever answers "already claimed".
 */
import { base64urlEncode, sha256Hex } from "@app/evidence";

export const CLAIM_TOKEN_PREFIX = "gtc_";
const CLAIM_TOKEN_SHAPE = /^gtc_[A-Za-z0-9_-]{43}$/;

export function isClaimTokenShape(token: string): boolean {
  return CLAIM_TOKEN_SHAPE.test(token);
}

export interface ClaimSeed {
  repoId: string;
  agentPrincipalId: string;
  createdAt: string;
}

export async function deriveClaimToken(
  env: { BETTER_AUTH_SECRET?: string },
  seed: ClaimSeed,
): Promise<string> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to derive claim tokens");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `gittifacts/claim\n${seed.repoId}\n${seed.agentPrincipalId}\n${seed.createdAt}`,
    ),
  );
  return `${CLAIM_TOKEN_PREFIX}${base64urlEncode(new Uint8Array(mac))}`;
}

export function hashClaimToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function claimUrlFor(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/claim/${token}`;
}
