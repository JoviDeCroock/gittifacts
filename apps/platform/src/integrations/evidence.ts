/**
 * Successful preview deployments become signed `preview` evidence on their Change.
 *
 * - The item is `{ id: "preview:<integrationId>", kind: "preview", status: "ok", url, source:
 *   { kind: "integration", id, name, deploymentId, logUrl } }`; the bundle is re-signed by the
 *   platform key (same evidence id, base and creation time).
 * - Informational only: nothing is re-classified, so a preview can never lower (or raise) a lane.
 *   Only `success` becomes evidence; failed deployments stay in the deployments log.
 * - When the bundle for that head is not sealed yet, the deployment waits as `pending`; the Store
 *   wrapper (./runtime.ts) adds every successful integration preview when the coordinator seals
 *   the bundle, and on any later re-seal of the same head.
 */
import type { Signer } from "@app/coordinator";
import type { Evidence } from "@app/domain";
import type { EvidenceItem, PreviewDeploy } from "@app/evidence";
import { and, eq, inArray } from "drizzle-orm";
import { deployments, integrations } from "../db/schema.js";
import type { D1Store } from "../store/d1-store.js";

export type DeploymentRow = typeof deployments.$inferSelect;

export interface EvidenceDeps {
  store: Pick<D1Store, "db" | "getEvidence" | "putEvidence">;
  signer: Pick<Signer, "signEvidence">;
}

export function previewItemId(integrationId: string): string {
  return `preview:${integrationId}`;
}

export function integrationPreviewItem(d: DeploymentRow, integrationName: string): PreviewDeploy {
  return {
    id: previewItemId(d.integrationId),
    kind: "preview",
    status: "ok",
    ...(d.url ? { url: d.url } : {}),
    note: `Preview deployed by ${integrationName}${d.description ? `: ${d.description}` : ""}`.slice(
      0,
      4000,
    ),
    source: {
      kind: "integration",
      id: d.integrationId,
      name: integrationName.slice(0, 200),
      deploymentId: d.id,
      ...(d.logUrl ? { logUrl: d.logUrl } : {}),
    },
  };
}

/** `items` with each preview replaced (same id) or appended. */
function merged(
  items: readonly EvidenceItem[],
  previews: readonly PreviewDeploy[],
): EvidenceItem[] {
  const ids = new Set(previews.map((p) => p.id));
  return [...items.filter((i) => !ids.has(i.id)), ...previews];
}

async function resign(deps: EvidenceDeps, ev: Evidence, items: EvidenceItem[]): Promise<Evidence> {
  const signed = await deps.signer.signEvidence({
    changeId: ev.changeId,
    headSha: ev.headSha,
    items,
  });
  return {
    ...signed,
    id: ev.id,
    baseSha: ev.baseSha,
    createdAt: ev.createdAt,
    notesWritten: ev.notesWritten,
  };
}

async function namesOf(deps: EvidenceDeps, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.store.db
    .select({ id: integrations.id, name: integrations.name })
    .from(integrations)
    .where(inArray(integrations.id, ids))
    .all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function markAttached(deps: EvidenceDeps, rows: readonly DeploymentRow[]): Promise<void> {
  for (const d of rows) {
    await deps.store.db
      .update(deployments)
      .set({ evidenceStatus: "attached", evidenceItemId: previewItemId(d.integrationId) })
      .where(eq(deployments.id, d.id));
  }
}

/**
 * Attach a successful preview deployment now if its head's bundle exists, else leave it pending.
 */
export async function attachPreview(
  deps: EvidenceDeps,
  d: DeploymentRow,
): Promise<"attached" | "pending" | "not-applicable"> {
  if (d.environment !== "preview" || d.state !== "success" || d.changeId === null)
    return "not-applicable";
  const ev = await deps.store.getEvidence(d.changeId, d.sha);
  if (ev === null) {
    await deps.store.db
      .update(deployments)
      .set({ evidenceStatus: "pending" })
      .where(eq(deployments.id, d.id));
    return "pending";
  }
  const name = (await namesOf(deps, [d.integrationId])).get(d.integrationId) ?? d.integrationId;
  const next = await resign(deps, ev, merged(ev.items, [integrationPreviewItem(d, name)]));
  await deps.store.putEvidence(next);
  await markAttached(deps, [d]);
  return "attached";
}

/** Called as the coordinator stores a bundle: add every successful integration preview of that head. */
export async function attachPendingPreviews(deps: EvidenceDeps, ev: Evidence): Promise<Evidence> {
  const rows = await deps.store.db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.changeId, ev.changeId),
        eq(deployments.sha, ev.headSha),
        eq(deployments.environment, "preview"),
        eq(deployments.state, "success"),
      ),
    )
    .all();
  if (rows.length === 0) return ev;
  // Latest success per integration wins.
  const latest = new Map<string, DeploymentRow>();
  for (const r of rows) {
    const prev = latest.get(r.integrationId);
    if (!prev || prev.updatedAt <= r.updatedAt) latest.set(r.integrationId, r);
  }
  const names = await namesOf(deps, [...latest.keys()]);
  const previews = [...latest.values()].map((d) =>
    integrationPreviewItem(d, names.get(d.integrationId) ?? d.integrationId),
  );
  const out = await resign(deps, ev, merged(ev.items, previews));
  await markAttached(deps, [...latest.values()]);
  return out;
}
