/**
 * better-auth for humans: email + password, GitHub (when configured), optional passkeys,
 * and the bearer plugin so a session token also works as `Authorization: Bearer`.
 *
 * Agents do NOT use better-auth sessions. They hold platform tokens (`gtf_…`, see
 * ./agent-tokens.ts) bound to an agent Principal. See that module for why we don't use the
 * api-key plugin. The device-authorization plugin runs the RFC 8628 code state machine for the
 * CLI login, but its session-minting endpoints are disabled (see ../oauth/device.ts).
 *
 * Password reset is on only when outbound e-mail is configured (./email.ts); otherwise
 * ./password-reset.ts answers the request endpoint with 503 and a fix.
 */
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema.js";
import {
  agentDeviceGrant,
  agentDeviceRedemption,
  DEVICE_CODE_TTL,
  DEVICE_DISABLED_PATHS,
  DEVICE_POLL_INTERVAL,
} from "../oauth/device.js";
import { mailerFor, resetPasswordEmail } from "./email.js";

export interface AuthBindings {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  /** Optional override of the browser-facing origin (e.g. the Vite dev proxy). */
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Outbound e-mail (./email.ts): an Email Service `send_email` binding and its sender. */
  EMAIL?: unknown;
  EMAIL_FROM?: unknown;
}

export interface AuthRuntime {
  /** Origin used when BETTER_AUTH_URL is not set (the request's own origin). */
  origin: string;
  waitUntil?: (p: Promise<unknown>) => void;
}

export function authBaseUrl(env: Pick<AuthBindings, "BETTER_AUTH_URL">, origin: string): string {
  const configured = env.BETTER_AUTH_URL?.trim();
  return configured ? configured : origin;
}

/**
 * On https, the session cookies are `__Host-` cookies: Secure, Path=/ and no Domain, so a project
 * Worker on a sibling subdomain (`*.<account>.workers.dev`) cannot toss a session cookie of its
 * own onto the platform (security audit M1). better-auth would prefix `__Secure-` (which a sibling
 * may still set with `Domain=`), so its prefixing is off and the names carry `__Host-` themselves;
 * every other cookie it sets stays Secure. On http (local dev, tests) the names stay plain.
 */
export const SESSION_COOKIE_PREFIX_HTTPS = "__Host-";
const hostCookie = (name: string) => ({
  name: `${SESSION_COOKIE_PREFIX_HTTPS}better-auth.${name}`,
});
const HOST_COOKIES = {
  useSecureCookies: false,
  defaultCookieAttributes: { secure: true },
  cookies: {
    session_token: hostCookie("session_token"),
    session_data: hostCookie("session_data"),
    dont_remember: hostCookie("dont_remember"),
    account_data: hostCookie("account_data"),
  },
} as const;

export function createAuth(env: AuthBindings, rt: AuthRuntime) {
  const baseURL = authBaseUrl(env, rt.origin);
  const url = new URL(baseURL);
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : {};
  const waitUntil = rt.waitUntil;
  const mailer = mailerFor(env);
  const reset = mailer
    ? {
        // The e-mailed link lands on /api/auth/reset-password/<token>, which redirects to the
        // web form (/reset-password?token=…) the request named in `redirectTo`.
        sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
          await mailer.send(resetPasswordEmail(user.email, url));
        },
        resetPasswordTokenExpiresIn: 3600,
        revokeSessionsOnPasswordReset: true,
      }
    : {};
  return betterAuth({
    appName: "gittifacts",
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [url.origin],
    // D1 has no interactive transactions; the adapter's default (transaction: false) is right.
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true, ...reset },
    socialProviders: github,
    session: { cookieCache: { enabled: true, maxAge: 300 } },
    // Per-isolate memory rate limiting is meaningless on Workers; use Cloudflare rate limiting rules.
    rateLimit: { enabled: false },
    advanced: {
      ...(waitUntil ? { backgroundTasks: { handler: (p: Promise<unknown>) => waitUntil(p) } } : {}),
      ...(url.protocol === "https:" ? HOST_COOKIES : {}),
    },
    // Device codes must never turn into human sessions; approval goes through our consent API.
    disabledPaths: [...DEVICE_DISABLED_PATHS],
    plugins: [
      bearer(),
      passkey({ rpID: url.hostname, rpName: "gittifacts", origin: url.origin }),
      deviceAuthorization({
        expiresIn: DEVICE_CODE_TTL,
        interval: DEVICE_POLL_INTERVAL,
        verificationUri: "/device",
        grant: agentDeviceGrant,
      }),
      agentDeviceRedemption(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
