/**
 * Rate limits on the auth endpoints (security audit M2), in front of better-auth (whose own
 * per-isolate limiter is off: src/auth/better-auth.ts) and the OAuth protocol routes.
 *
 * Workers Rate Limiting bindings (wrangler.jsonc `ratelimits`), keyed by `CF-Connecting-IP` and,
 * for sign-in and password reset, also by the normalized e-mail so guessing one account's password
 * from many addresses is limited too. Over a limit: 429 in the platform's error envelope with
 * `Retry-After` (the bindings count per 60 s window).
 *
 * A missing binding fails closed (500), like the unclaimed-token limit (src/limits/request-limit.ts):
 * an unknown signal may only raise risk.
 */
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { ApiError, toErrorResponse } from "../errors.js";
import { OAUTH_PATHS } from "../oauth/urls.js";

type LimiterName = "AUTH_LIMITER" | "AUTH_EMAIL_LIMITER" | "OAUTH_LIMITER";

/** wrangler.jsonc `ratelimits`: per IP, per e-mail, and OAuth/device per IP. */
export type AuthLimitBindings = Partial<Record<LimiterName, RateLimit>>;

export const AUTH_RETRY_AFTER_SEC = 60;

interface Rule {
  bucket: string;
  methods: readonly string[];
  path: RegExp;
  limiter: LimiterName;
  /** Also count per normalized `email` from the JSON body (AUTH_EMAIL_LIMITER). */
  byEmail?: boolean;
}

const exact = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

export const AUTH_LIMIT_RULES: readonly Rule[] = [
  {
    bucket: "sign-in",
    methods: ["POST"],
    path: /^\/api\/auth\/sign-in\//,
    limiter: "AUTH_LIMITER",
    byEmail: true,
  },
  {
    bucket: "sign-up",
    methods: ["POST"],
    path: /^\/api\/auth\/sign-up\//,
    limiter: "AUTH_LIMITER",
  },
  {
    bucket: "password-reset",
    methods: ["POST"],
    path: /^\/api\/auth\/(?:forget-password|request-password-reset|reset-password)(?:\/|$)/,
    limiter: "AUTH_LIMITER",
    byEmail: true,
  },
  {
    bucket: "passkey-sign-in",
    methods: ["POST"],
    path: /^\/api\/auth\/passkey\/verify-authentication$/,
    limiter: "AUTH_LIMITER",
  },
  { bucket: "device", methods: ["POST"], path: /^\/api\/auth\/device\//, limiter: "OAUTH_LIMITER" },
  {
    bucket: "authorize",
    methods: ["GET", "POST"],
    path: exact(OAUTH_PATHS.authorize),
    limiter: "OAUTH_LIMITER",
  },
  { bucket: "token", methods: ["POST"], path: exact(OAUTH_PATHS.token), limiter: "OAUTH_LIMITER" },
];

const EmailBody = z.object({ email: z.string().max(320) }).partial();

/** The e-mail a sign-in/reset body names, trimmed and lower-cased; null when there is none. */
async function bodyEmail(req: Request): Promise<string | null> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return null;
  try {
    const parsed = EmailBody.safeParse(await req.clone().json());
    const email = parsed.success ? parsed.data.email?.trim().toLowerCase() : undefined;
    return email ? email : null;
  } catch {
    return null;
  }
}

function limiterOf(env: unknown, name: LimiterName): RateLimit {
  const limiter = (env as AuthLimitBindings)[name];
  if (limiter === undefined) throw new Error(`${name} is not bound (wrangler.jsonc ratelimits)`);
  return limiter;
}

function tooMany(c: Context<AppEnv>, bucket: string, by: "address" | "e-mail"): Response {
  const err = new ApiError(
    429,
    "rate-limited",
    `too many ${bucket} requests from this ${by}`,
    { bucket, by, retryAfterSec: AUTH_RETRY_AFTER_SEC },
    {
      explanation: `Wait ${AUTH_RETRY_AFTER_SEC} seconds (the Retry-After header) and try again. Agents should not sign in as a person: use an agent token (\`Authorization: Bearer gtf_…\`) or the device login (\`gittifacts login\`).`,
    },
  );
  const r = toErrorResponse(err);
  return c.json(r.body, r.status, { "retry-after": String(AUTH_RETRY_AFTER_SEC) });
}

export const authRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const rule = AUTH_LIMIT_RULES.find((r) => r.methods.includes(c.req.method) && r.path.test(path));
  if (rule === undefined) return next();
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const byIp = await limiterOf(c.env, rule.limiter).limit({ key: `${rule.bucket}:ip:${ip}` });
  if (!byIp.success) return tooMany(c, rule.bucket, "address");
  if (rule.byEmail) {
    const email = await bodyEmail(c.req.raw);
    if (email !== null) {
      const byEmail = await limiterOf(c.env, "AUTH_EMAIL_LIMITER").limit({
        key: `${rule.bucket}:email:${email}`,
      });
      if (!byEmail.success) return tooMany(c, rule.bucket, "e-mail");
    }
  }
  return next();
};
