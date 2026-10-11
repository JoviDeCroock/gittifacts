/**
 * Plain words and pure helpers for external integrations. No DOM, no clocks.
 *
 * Every screen renders the server's `ScopeExplained` strings (`scopes` on installs and
 * installations, `scopesExplained` on an integration). This catalog mirrors that wording and is
 * only a fallback: the register form (nothing on the server yet) and scopes an integration
 * doesn't hold yet.
 */
import type {
  DeliveryStatus,
  DeliverySummary,
  IntegrationScope,
  RepoRef,
  RepoSelection,
  ScopeExplained,
  WebhookEvent,
} from "../api/integrations.js";
import type { StatusMeta } from "./vocab.js";

export const SCOPE_CATALOG: readonly ScopeExplained[] = [
  {
    scope: "repo:read",
    title: "Read repository metadata",
    description: "See the repository's name, branches, commits, Changes and their status.",
  },
  {
    scope: "contents:read",
    title: "Clone the code",
    description: "Clone and fetch the repository and its Change heads over git, read-only.",
  },
  {
    scope: "webhooks",
    title: "Receive events",
    description:
      "Get notified when the default branch or a Change is pushed, and when Changes are created, updated, merged or reverted.",
  },
  {
    scope: "deployments:write",
    title: "Report deployments",
    description:
      "Post deployment status and preview URLs. A successful preview is attached to its Change as signed evidence.",
  },
  {
    scope: "checks:write",
    title: "Report checks",
    description:
      "Attach external check results to Changes. They can only raise a Change's risk lane, never lower it.",
  },
];

/** What a deploy platform needs: everything but checks. */
export const DEPLOY_SCOPES: readonly IntegrationScope[] = [
  "repo:read",
  "contents:read",
  "webhooks",
  "deployments:write",
];

export function scopeText(scope: IntegrationScope): ScopeExplained {
  return SCOPE_CATALOG.find((s) => s.scope === scope) ?? { scope, title: scope, description: "" };
}

/** Catalog order, so lists read the same everywhere. */
export function sortScopes(scopes: readonly IntegrationScope[]): IntegrationScope[] {
  const order = SCOPE_CATALOG.map((s) => s.scope);
  return [...scopes].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export const EVENT_CATALOG: readonly { event: WebhookEvent; hint: string }[] = [
  { event: "push", hint: "The default branch or a Change fork was pushed (ref, before, after)." },
  { event: "change.created", hint: "A Change was opened." },
  { event: "change.updated", hint: "A Change got new commits or a new status." },
  { event: "change.merged", hint: "The merge queue landed a Change on the default branch." },
  { event: "change.reverted", hint: "A merged Change was reverted." },
  { event: "installation.created", hint: "Someone installed the integration." },
  { event: "installation.deleted", hint: "Someone uninstalled it. No more events follow." },
];

/** Every subscribable event except ping, which is always delivered on request. */
export const ALL_EVENTS: readonly WebhookEvent[] = EVENT_CATALOG.map((e) => e.event);

const STATUS: Record<DeliveryStatus, StatusMeta> = {
  delivered: { label: "Delivered", tone: "ok", icon: "check-circle" },
  failed: { label: "Failed", tone: "danger", icon: "x-circle" },
  pending: { label: "Pending", tone: "neutral", icon: "clock" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "ban" },
};

/** A pending delivery that already failed once is "Retrying", so it never reads as fine. */
export function deliveryStatus(d: Pick<DeliverySummary, "status" | "attempts">): StatusMeta {
  if (d.status === "pending" && d.attempts > 0) {
    return { label: "Retrying", tone: "warn", icon: "clock" };
  }
  return STATUS[d.status];
}

export const DELIVERY_FILTERS: readonly { id: "all" | DeliveryStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "pending", label: "Pending" },
  { id: "delivered", label: "Delivered" },
];

/** "All repositories", "billing-api", "billing-api and edge-router", "billing-api, edge-router and 2 more". */
export function repoLine(
  selection: RepoSelection,
  repos: readonly Pick<RepoRef, "name">[],
): string {
  if (selection === "all") return "All repositories";
  const names = repos.map((r) => r.name);
  if (names.length === 0) return "No repositories";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export function hostOf(url: string, fallback = "the app"): string {
  try {
    return new URL(url).host || fallback;
  } catch {
    return fallback;
  }
}

/** Pretty-prints a raw JSON body; returns it untouched when it isn't JSON. */
export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Non-empty trimmed lines, duplicates dropped (redirect URIs are matched exactly). */
export function lines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    ),
  ];
}

/** https anywhere; http only for localhost (local development callbacks). */
export function urlProblem(value: string, what: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `${what} isn't a full URL. Start it with https://.`;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return null;
  return `${what} must use https:// (http:// only for localhost).`;
}

/** First problem with a redirect URI list, or null. Fragments are refused, like the server. */
export function redirectUrisProblem(uris: readonly string[]): string | null {
  if (uris.length === 0) return "Add at least one redirect URI.";
  for (const uri of uris) {
    const p = urlProblem(uri, uri);
    if (p) return p;
    if (uri.includes("#")) return `${uri} has a #fragment. Redirect URIs can't.`;
  }
  return null;
}
