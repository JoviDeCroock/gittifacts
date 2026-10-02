/**
 * Who is calling without credentials: the client IP (as Cloudflare saw it) and its network (ASN),
 * used only for abuse limits. The raw IP is never stored: limits and the creation record use a
 * keyed hash (HMAC-SHA-256 under the platform's auth secret), and IPv6 is reduced to its /64,
 * which one subscriber usually controls entirely.
 */
import { hexEncode } from "@app/evidence";
import { type EvalTrafficEnv, verifiedEvalRun } from "./eval-traffic.js";

export interface AnonymousClient {
  /** Keyed hash of the IP (IPv6: of its /64); "unknown" when the edge gave no IP. */
  ipHash: string;
  /** `request.cf.asn`; null when unknown (local dev, tests). */
  asn: number | null;
  /** ISO country, informational. */
  country: string | null;
  /**
   * The eval run this request belongs to, when its `x-gittifacts-eval-sig` verifies
   * (src/limits/eval-traffic.ts): creation limits then key on the run instead of the IP and
   * ASN. Absent/null for everyone else.
   */
  evalRun?: string | null;
}

/** The address limits key on: IPv4 as is, IPv6 reduced to its first four hextets (/64). */
export function limitAddress(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v;
  const [head = "", tail = ""] = v.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = v.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return hexEncode(new Uint8Array(sig)).slice(0, 32);
}

interface CfProps {
  asn?: unknown;
  country?: unknown;
}

export async function anonymousClient(
  request: Request,
  env: { BETTER_AUTH_SECRET?: string } & EvalTrafficEnv,
): Promise<AnonymousClient> {
  const ip = request.headers.get("cf-connecting-ip");
  const cf = (request as Request & { cf?: CfProps }).cf;
  const asnRaw = typeof cf?.asn === "number" ? cf.asn : Number(cf?.asn);
  const secret = env.BETTER_AUTH_SECRET || "gittifacts-dev-ip-salt";
  return {
    ipHash: ip ? await hmacHex(secret, `ip:${limitAddress(ip)}`) : "unknown",
    asn: Number.isInteger(asnRaw) && asnRaw > 0 ? asnRaw : null,
    country: typeof cf?.country === "string" ? cf.country : null,
    evalRun: await verifiedEvalRun(request, env),
  };
}
