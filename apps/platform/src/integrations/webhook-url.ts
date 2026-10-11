/**
 * Where an integration webhook may point. The platform POSTs signed events to the URL and stores
 * the first 2 KB of the answer in the delivery log, so a URL aimed at the platform itself, its
 * previews, a loopback/internal name or an IP literal would turn webhooks into a request forger
 * with a read-back. Checked at registration (400) and again at every delivery (cancelled), so a
 * row written before this check, or an env change, cannot slip through.
 */
import { previewZone } from "../previews/ids.js";

export interface WebhookUrlEnv {
  BETTER_AUTH_URL?: string;
  PREVIEW_HOST_SUFFIX?: string;
  PREVIEW_ZONE?: string;
}

/** Names that only ever resolve inside a network (RFC 6761/6762/8375, ICANN .internal). */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".arpa"];

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Why `url` may not receive webhooks, or null when it may. */
export function webhookUrlRefusal(url: string, env: WebhookUrlEnv): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "must be an https:// URL";
  if (u.username || u.password) return "must not carry credentials";
  // WHATWG URL normalises every IPv4 spelling (decimal, hex, octal) to a dotted quad.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return "must use a DNS name, not an IP address";
  }
  if (host === "localhost" || !host.includes(".")) {
    return "must be a public DNS name (not localhost or a single-label host)";
  }
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "must be a public DNS name (not an internal or reserved domain)";
  }
  const platform = hostOf(env.BETTER_AUTH_URL);
  if (platform && (host === platform || host.endsWith(`.${platform}`))) {
    return "must not point at this platform";
  }
  // Sibling Workers on the platform's workers.dev account subdomain (tenant apps).
  if (platform?.endsWith(".workers.dev")) {
    const account = platform.split(".").slice(1).join(".");
    if (account.split(".").length >= 3 && (host === account || host.endsWith(`.${account}`))) {
      return "must not point at a Worker on this platform's account";
    }
  }
  const suffix = previewZone(env);
  const zone = suffix.slice(1);
  if (host.endsWith(suffix) || host === zone || host.endsWith(`.${zone}`)) {
    return "must not point at a platform preview";
  }
  return null;
}
