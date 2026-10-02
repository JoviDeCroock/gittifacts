/**
 * Preview hostnames (DECISIONS.md: previews run in our containers behind a preview gateway).
 * A hostname is `<label><suffix>`; the suffix is `-pv.resynapse.dev` by default so every preview is
 * a FIRST-level subdomain that the zone's Universal SSL certificate covers (a second-level
 * wildcard such as *.preview.resynapse.dev has no certificate without Advanced Certificate Manager):
 *
 *   p-<changeId><suffix>          the change's latest head (known before the preview exists)
 *   p-<changeId>-<sha8><suffix>   one head, pinned (what evidence and screenshots point at)
 *
 * Change ids are [0-9a-z] (20 chars), `bs-<repoId>` for bootstraps and `rv-…` for reverts, so the
 * labels are DNS-safe. A label that would exceed 63 characters is not served.
 */

/** Hostname suffix of every preview (starts with "-" or "."). */
export const DEFAULT_PREVIEW_HOST_SUFFIX = "-pv.resynapse.dev";
const LABEL = /^p-([a-z0-9][a-z0-9-]{0,59})$/;
const PINNED = /^(.+)-([0-9a-f]{8})$/;

/**
 * The preview hostname suffix: `PREVIEW_HOST_SUFFIX` (e.g. "-pv.resynapse.dev"), else
 * `"." + PREVIEW_ZONE` for a dedicated zone, else the default.
 */
export function previewZone(env: { PREVIEW_ZONE?: string; PREVIEW_HOST_SUFFIX?: string }): string {
  const suffix =
    env.PREVIEW_HOST_SUFFIX ??
    (env.PREVIEW_ZONE !== undefined ? `.${env.PREVIEW_ZONE}` : DEFAULT_PREVIEW_HOST_SUFFIX);
  return suffix.toLowerCase();
}

/** The latest-head preview id of a change, or its pinned id when `headSha` is given. */
export function previewIdFor(changeId: string, headSha?: string): string {
  const id = headSha === undefined ? `p-${changeId}` : `p-${changeId}-${headSha.slice(0, 8)}`;
  return id.toLowerCase();
}

export function previewUrlFor(suffix: string, changeId: string, headSha?: string): string | null {
  const id = previewIdFor(changeId, headSha);
  return labelLength(id, suffix) <= 63 && LABEL.test(id) ? `https://${id}${suffix}` : null;
}

/** Length of the first DNS label once the suffix is appended (a "-…" suffix extends it). */
function labelLength(id: string, suffix: string): number {
  return suffix.startsWith(".") ? id.length : id.length + (suffix.split(".")[0] ?? "").length;
}

export type PreviewTarget =
  | { kind: "pinned"; previewId: string; changeId: string; sha8: string }
  | { kind: "latest"; previewId: string; changeId: string };

/**
 * `p-<changeId>[-<sha8>]` from a request hostname on `zone`, or null for any other host. A label
 * ending in eight hex characters is read as pinned; the gateway falls back to "latest" when no
 * pinned preview of that name exists.
 */
export function parsePreviewHost(hostname: string, suffix: string): PreviewTarget | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  const m = LABEL.exec(label);
  if (m === null || labelLength(label, suffix) > 63 || label.includes(".")) return null;
  const rest = m[1] as string;
  const pinned = PINNED.exec(rest);
  if (pinned !== null) {
    return {
      kind: "pinned",
      previewId: label,
      changeId: pinned[1] as string,
      sha8: pinned[2] as string,
    };
  }
  return { kind: "latest", previewId: label, changeId: rest };
}

export function isPreviewHost(hostname: string, suffix: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, "").endsWith(suffix);
}
