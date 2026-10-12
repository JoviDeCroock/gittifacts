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

/** A page of the web app a person opens. */
export type PlatformPage =
  | { planId: string }
  /** A change's walkthrough (`/changes/:id`), or its evidence or rollout page. */
  | { changeId: string; view?: "evidence" | "rollout" | undefined }
  /** The audit log, filtered (`/audit?actor=…`). */
  | {
      audit: {
        subject?: string | undefined;
        actor?: string | undefined;
        action?: string | undefined;
      };
    }
  /** The person's agents (`/agents`): where an owner inspects or revokes them. */
  | { agents: true }
  /** A repo's code: a directory (`/repos/:id/tree/<path>`) or a file (`/repos/:id/blob/<path>`). */
  | { repoId: string; code: { kind: "tree" | "blob"; path: string; ref?: string | undefined } }
  /** A repo's history (`/repos/:id/commits`), one commit, or its commit activity. */
  | { repoId: string; commits: { sha?: string | undefined; ref?: string | undefined } }
  | { repoId: string; activity: { ref?: string | undefined } };

/** `?ref=…` unless the ref is the default (absent). */
const refQuery = (ref: string | undefined) =>
  ref === undefined || ref === "" ? "" : `?ref=${encodeURIComponent(ref)}`;
/** Path segments encoded one by one, so `/` stays a separator. */
const encodePath = (path: string) =>
  path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/**
 * The page a person opens for a plan, a change, the audit log or their agents (the web app's
 * routes): what agents hand a human to approve, review or look at.
 */
export function pageUrl(origin: string, page: PlatformPage): string {
  if ("planId" in page) return join(origin, `/plans/${encodeURIComponent(page.planId)}`);
  if ("changeId" in page) {
    const view = page.view === undefined ? "" : `/${page.view}`;
    return join(origin, `/changes/${encodeURIComponent(page.changeId)}${view}`);
  }
  if ("audit" in page) {
    const q = (["subject", "actor", "action"] as const).flatMap((k) => {
      const v = page.audit[k];
      return v === undefined ? [] : [`${k}=${encodeURIComponent(v)}`];
    });
    return join(origin, q.length === 0 ? "/audit" : `/audit?${q.join("&")}`);
  }
  if ("code" in page) {
    const path = encodePath(page.code.path);
    const repo = `/repos/${encodeURIComponent(page.repoId)}`;
    const at = path === "" ? `${repo}/tree` : `${repo}/${page.code.kind}/${path}`;
    return join(origin, `${at}${refQuery(page.code.ref)}`);
  }
  if ("commits" in page) {
    const sha = page.commits.sha === undefined ? "" : `/${encodeURIComponent(page.commits.sha)}`;
    const q = page.commits.sha === undefined ? refQuery(page.commits.ref) : "";
    return join(origin, `/repos/${encodeURIComponent(page.repoId)}/commits${sha}${q}`);
  }
  if ("activity" in page) {
    return join(
      origin,
      `/repos/${encodeURIComponent(page.repoId)}/activity${refQuery(page.activity.ref)}`,
    );
  }
  return join(origin, "/agents");
}
