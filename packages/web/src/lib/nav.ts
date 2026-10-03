/**
 * Where the app lives and where people land. `/` is the marketing page (the Worker serves it to
 * everyone); the signed-in home is `/dashboard`. Pure, so the redirect rules are unit-tested.
 */

/** The signed-in home: the sidebar logo, breadcrumbs, empty states and "go home" redirects. */
export const APP_HOME = "/dashboard";

/** The marketing page. In-app links to it bypass the SPA router (`target="_top"`). */
export const MARKETING_HOME = "/";

export const HOME_CRUMB = { href: APP_HOME, label: "Dashboard" } as const;

/**
 * Paths the Worker answers itself (not SPA routes): a `next` pointing at one needs a full
 * navigation. `/oauth/consent` and `/device` are SPA screens; `/oauth/authorize` is not.
 */
const SERVER_PATH =
  /^\/(?:$|[?#]|github\/|api\/|mcp(?:$|[/?])|docs(?:$|[/?#.])|start(?:$|[/?#.])|llms(?:-full)?\.txt|openapi\.json|cli(?:$|[/?])|\.well-known\/|oauth\/(?:authorize|token|register|revoke)|git\/|webhooks\/)/;

export function isServerPath(path: string): boolean {
  return SERVER_PATH.test(path);
}

/**
 * A `next` parameter as a same-origin path, or null. Rejects other origins (`//host`, `/\host`,
 * schemes), sign-in itself (a loop) and `/` (the marketing page is not where sign-in should end).
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  const path = raw.split(/[?#]/)[0] ?? "";
  if (path === "/" || path === "/signin" || path === "/signin/") return null;
  return raw;
}

/** Where sign-in or sign-up sends a person: `next` when it is safe, else the dashboard. */
export function postAuthTarget(next: string | null | undefined): string {
  return safeNext(next) ?? APP_HOME;
}

/** The sign-in URL that returns to `pathAndQuery` afterwards (just `/signin` for home). */
export function signInHref(pathAndQuery: string): string {
  const next = safeNext(pathAndQuery);
  return next === null || next === APP_HOME
    ? "/signin"
    : `/signin?next=${encodeURIComponent(next)}`;
}

/**
 * GitHub sign-in's callback: where better-auth sends the browser after GitHub. From `/signin`
 * that is `next` (or the dashboard); from any other screen (sign-in shown in place), that screen.
 */
export function githubCallbackUrl(pathname: string, search: string): string {
  if (pathname === "/signin" || pathname === "/signin/") {
    return postAuthTarget(new URLSearchParams(search).get("next"));
  }
  return postAuthTarget(`${pathname}${search}`);
}
