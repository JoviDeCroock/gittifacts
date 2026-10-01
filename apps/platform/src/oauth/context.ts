import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { authBaseUrl } from "../auth/better-auth.js";
import { type OAuthUrls, oauthUrls } from "./urls.js";

/** The browser-facing origin (BETTER_AUTH_URL when set, else the request's own origin). */
export function originOf(c: Context<AppEnv>): string {
  return new URL(authBaseUrl(c.env, new URL(c.req.url).origin)).origin;
}

export function urlsFor(c: Context<AppEnv>): OAuthUrls {
  return oauthUrls(originOf(c));
}
