/**
 * Rate limits on credential-less `create_project`: per IP (/64), per network (ASN) and
 * platform-wide, each with an hourly burst and a daily cap (token buckets in `AbuseLimiter`
 * Durable Objects). All three are taken, or none: a refusal refunds the keys that said yes.
 * A limiter that can't be reached refuses (fail closed): an unclaimed project is never created
 * without passing every limit.
 *
 * Signed eval traffic (src/limits/eval-traffic.ts) is keyed by its run instead of its IP and
 * ASN, which are Cloudflare's shared Worker egress: `eval:<runId>` (a small per-run budget) +
 * the global buckets, which still cap everything.
 */
import { fixFor } from "@app/conventions";
import { ApiError } from "../errors.js";
import type { AnonymousClient } from "./client.js";
import type { UnclaimedLimits } from "./config.js";
import type { AbuseLimiter, BucketSpec, TakeResult } from "./limiter-do.js";

export interface LimiterEnv {
  ABUSE_LIMITER: DurableObjectNamespace<AbuseLimiter>;
}

type Scope = "ip" | "asn" | "eval-run" | "global";

interface Keyed {
  key: string;
  scope: Scope;
  buckets: BucketSpec[];
}

function globalKey(c: UnclaimedLimits["creation"]): Keyed {
  return {
    key: "global",
    scope: "global",
    buckets: [
      { name: "hour", ...c.globalHour },
      { name: "day", ...c.globalDay },
    ],
  };
}

export function creationKeys(client: AnonymousClient, l: UnclaimedLimits): Keyed[] {
  const c = l.creation;
  if (client.evalRun) {
    const run: Keyed = {
      key: `eval:${client.evalRun}`,
      scope: "eval-run",
      buckets: [{ name: "run", ...c.evalRun }],
    };
    return [run, globalKey(c)];
  }
  const keys: Keyed[] = [
    {
      key: `ip:${client.ipHash}`,
      scope: "ip",
      buckets: [
        { name: "hour", ...c.ipHour },
        { name: "day", ...c.ipDay },
      ],
    },
  ];
  // No ASN (local dev, tests, some edge paths): the IP and global limits still apply.
  if (client.asn !== null) {
    keys.push({
      key: `asn:${client.asn}`,
      scope: "asn",
      buckets: [
        { name: "hour", ...c.asnHour },
        { name: "day", ...c.asnDay },
      ],
    });
  }
  keys.push(globalKey(c));
  return keys;
}

export class RateLimited extends ApiError {
  constructor(
    readonly scope: Scope | "token",
    readonly retryAfterSec: number,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(
      429,
      "rate-limited",
      message,
      { scope, retryAfterSec, ...details },
      fixFor("rate-limited", { retryAfterSec }),
    );
  }
}

const SCOPE_WORDS = {
  ip: "from your address",
  asn: "from your network",
  "eval-run": "by this eval run",
  global: "on the platform right now",
} as const;

/** Take one creation from every key, or throw `rate-limited` (429) naming the scope. */
export async function takeCreation(
  env: LimiterEnv,
  client: AnonymousClient,
  limits: UnclaimedLimits,
  atMs: number,
): Promise<void> {
  const keys = creationKeys(client, limits);
  const taken: Keyed[] = [];
  let refused: { k: Keyed; r: Extract<TakeResult, { ok: false }> } | null = null;
  try {
    for (const k of keys) {
      const r = await env.ABUSE_LIMITER.getByName(k.key).take({ buckets: k.buckets, atMs });
      if (!r.ok) {
        refused = { k, r };
        break;
      }
      taken.push(k);
    }
  } catch (e) {
    await refundAll(env, taken, atMs);
    console.error("abuse limiter unreachable; refusing unclaimed creation", e);
    throw new RateLimited("global", 30, "unclaimed creation is rate limited right now");
  }
  if (refused === null) return;
  await refundAll(env, taken, atMs);
  const { k, r } = refused;
  const per = k.scope === "eval-run" ? "run" : r.periodSec >= 86_400 ? "day" : "hour";
  // Workers Logs, not the audit log: an attack must not be able to flood the audit chain.
  console.warn(
    JSON.stringify({
      event: "unclaimed-creation-rate-limited",
      scope: k.scope,
      window: r.window,
      asn: client.asn,
      ipHash: client.ipHash.slice(0, 12),
      ...(client.evalRun ? { evalRun: client.evalRun } : {}),
    }),
  );
  throw new RateLimited(
    k.scope,
    r.retryAfterSec,
    `too many unclaimed projects created ${SCOPE_WORDS[k.scope]} (${r.capacity} per ${per})`,
    { window: r.window, limit: r.capacity, periodSec: r.periodSec },
  );
}

async function refundAll(env: LimiterEnv, keys: Keyed[], atMs: number): Promise<void> {
  await Promise.all(
    keys.map((k) =>
      env.ABUSE_LIMITER.getByName(k.key)
        .refund({ buckets: k.buckets, atMs })
        .catch(() => undefined),
    ),
  );
}
