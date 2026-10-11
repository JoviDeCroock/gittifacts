/**
 * Signing a real account in without the secret ever touching a page (docs/testing.md, "Secrets in
 * reports"): better-auth's sign-in endpoint from a private, untraced request context, then only the
 * session cookie goes into the browser context. Nothing types a password into a form, so no page
 * snapshot, trace, screenshot or error context can contain it. (2026-10-04: the E2E password leaked
 * into a smoke report's error-context.md from a filled sign-in form.)
 */
import { type BrowserContext, request as playwrightRequest } from "@playwright/test";

export async function signInWithApi(
  context: BrowserContext,
  origin: string,
  email: string,
  password: string,
): Promise<void> {
  // Its own request context: not the test's traced `request` fixture, disposed right away.
  const api = await playwrightRequest.newContext();
  try {
    const res = await api.post(`${origin}/api/auth/sign-in/email`, {
      data: { email, password },
      headers: { origin },
    });
    // Never echo the response or the request: say only what failed.
    if (!res.ok()) throw new Error(`API sign-in for the E2E account failed: HTTP ${res.status()}`);
    const cookies = (await api.storageState()).cookies.filter((c) =>
      c.name.includes("session_token"),
    );
    if (cookies.length === 0) throw new Error("API sign-in set no session cookie");
    await context.addCookies(cookies);
  } finally {
    await api.dispose();
  }
}
