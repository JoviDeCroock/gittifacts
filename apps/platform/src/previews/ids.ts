/**
 * Preview hostnames on the preview zone (DECISIONS.md: previews run in our containers behind a
 * preview gateway on *.preview.resynapse.dev):
 *
 *   p-<changeId>.<zone>          the change's latest head (known before the preview exists)
 *   p-<changeId>-<sha8>.<zone>   one head, pinned (what evidence and screenshots point at)
 *
 * Change ids are [0-9a-z] (20 chars), `bs-<repoId>` for bootstraps and `rv-…` for reverts, so the
 * labels are DNS-safe. A label that would exceed 63 characters is not served.
 */

export const DEFAULT_PREVIEW_ZONE = "preview.resynapse.dev";
const LABEL = /^p-([a-z0-9][a-z0-9-]{0,59})$/;
const PINNED = /^(.+)-([0-9a-f]{8})$/;

export function previewZone(env: { PREVIEW_ZONE?: string }): string {
  return (env.PREVIEW_ZONE ?? DEFAULT_PREVIEW_ZONE).toLowerCase();
}

/** The latest-head preview id of a change, or its pinned id when `headSha` is given. */
export function previewIdFor(changeId: string, headSha?: string): string {
  const id = headSha === undefined ? `p-${changeId}` : `p-${changeId}-${headSha.slice(0, 8)}`;
  return id.toLowerCase();
}

export function previewUrlFor(zone: string, changeId: string, headSha?: string): string | null {
  const id = previewIdFor(changeId, headSha);
  return id.length <= 63 && LABEL.test(id) ? `https://${id}.${zone}` : null;
}

export type PreviewTarget =
  | { kind: "pinned"; previewId: string; changeId: string; sha8: string }
  | { kind: "latest"; previewId: string; changeId: string };

/**
 * `p-<changeId>[-<sha8>]` from a request hostname on `zone`, or null for any other host. A label
 * ending in eight hex characters is read as pinned; the gateway falls back to "latest" when no
 * pinned preview of that name exists.
 */
export function parsePreviewHost(hostname: string, zone: string): PreviewTarget | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const suffix = `.${zone}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  const m = LABEL.exec(label);
  if (m === null || label.length > 63 || label.includes(".")) return null;
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

export function isPreviewHost(hostname: string, zone: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, "").endsWith(`.${zone}`);
}
