/**
 * URL helpers on plain strings (this package uses no runtime globals, not even `URL`).
 */

const ABSOLUTE = /^(https?):\/\/([^/?#]+)([^?#]*)/i;

/** `https://h/` → `https://h`. Throws on anything that is not an absolute http(s) URL. */
export function normalizeOrigin(host: string): string {
  const match = ABSOLUTE.exec(host.trim());
  if (match === null) throw new Error(`expected an absolute http(s) URL, got "${host}"`);
  const [, scheme, authority] = match;
  return `${scheme?.toLowerCase()}://${authority?.toLowerCase()}`;
}

/** The hostname of an absolute URL, without port. */
export function hostnameOf(url: string): string {
  const authority = normalizeOrigin(url).replace(/^https?:\/\//, "");
  return authority.replace(/:\d+$/, "");
}

/** The path of an absolute URL (`/` when empty), without a trailing slash. */
export function pathOf(url: string): string {
  const match = ABSOLUTE.exec(url.trim());
  if (match === null) throw new Error(`expected an absolute http(s) URL, got "${url}"`);
  const path = (match[3] ?? "").replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/** `join("https://h", "/start")` → `https://h/start`. */
export function join(origin: string, path: string): string {
  return `${normalizeOrigin(origin)}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The page a person opens for a plan or a change (the web app's `/plans/:id` and `/changes/:id`):
 * what agents hand a human to approve, review or look at.
 */
export function pageUrl(origin: string, page: { planId: string } | { changeId: string }): string {
  return "planId" in page
    ? join(origin, `/plans/${encodeURIComponent(page.planId)}`)
    : join(origin, `/changes/${encodeURIComponent(page.changeId)}`);
}
