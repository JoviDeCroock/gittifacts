/**
 * better-auth for humans: email + password, GitHub (when configured), optional passkeys,
 * and the bearer plugin so a session token also works as `Authorization: Bearer`.
 *
 * Agents do NOT use better-auth sessions. They hold platform tokens (`gtf_…`, see
 * ./agent-tokens.ts) bound to an agent Principal. See that module for why we don't use the
 * api-key plugin. The device-authorization plugin runs the RFC 8628 code state machine for the
 * CLI login, but its session-minting endpoints are disabled (see ../oauth/device.ts).
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

export interface AuthBindings {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  /** Optional override of the browser-facing origin (e.g. the Vite dev proxy). */
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
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

export function createAuth(env: AuthBindings, rt: AuthRuntime) {
  const baseURL = authBaseUrl(env, rt.origin);
  const url = new URL(baseURL);
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
      : {};
  const waitUntil = rt.waitUntil;
  return betterAuth({
    appName: "gittifacts",
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [url.origin],
    // D1 has no interactive transactions; the adapter's default (transaction: false) is right.
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true },
    socialProviders: github,
    session: { cookieCache: { enabled: true, maxAge: 300 } },
    // Per-isolate memory rate limiting is meaningless on Workers; use Cloudflare rate limiting rules.
    rateLimit: { enabled: false },
    advanced: waitUntil ? { backgroundTasks: { handler: (p) => waitUntil(p) } } : {},
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
