/**
 * A Change the merge queue's resolver rewrote: what lands is the resolved head, not the head the
 * author pushed (and an earlier approval covered). The re-approval screen leads with this: the
 * resolution diff (the merge with conflict markers → the resolved files), the upstream Changes it
 * was made against, and whether a person must approve it again.
 *
 * Sources: the change's audit trail (`merge-queue.resolution` names the resolved head,
 * `merge-queue.approval-requested` the re-approval) and the evidence sealed for the resolved head
 * (its `conflict-resolution` item holds the mechanical facts and the diff).
 */
import type { Change, Lane } from "@app/domain";
import type { ConflictResolution } from "@app/evidence";
import type { Services } from "../app-env.js";

export interface ResolutionView {
  /** The resolved head: what lands on main. */
  headSha: string;
  /** The head the author pushed (what an earlier approval covered). */
  originalHeadSha: string | null;
  /** The head the resolver started from (null on audits written before it was recorded). */
  resolvedFrom: string | null;
  ontoSha: string | null;
  /** When the resolver finished (ISO). */
  at: string;
  attempt: number;
  kind: "textual" | "semantic";
  /** The sealed conflict-resolution item for `headSha` (null: evidence not found). */
  item: ConflictResolution | null;
  upstream: { changeId: string; title: string | null; sha: string | null }[];
  /** A tour written for the resolved head (it leads with the resolution stop). */
  tourId: string | null;
  /** The resolution invalidated the approval: a person must approve what lands. */
  approvalRequested: boolean;
  /** The lane of that re-approval and why (reason codes). */
  lane: Lane | null;
  reasons: string[];
}

type Payload = Record<string, unknown>;
const obj = (v: unknown): Payload =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : {};
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The latest successful resolution of `change`, or null when the queue never resolved it. */
export async function resolutionOf(svc: Services, change: Change): Promise<ResolutionView | null> {
  const events = await svc.store.auditTimeline(svc.auditLog, `change:${change.id}`);
  const relevant = events.filter(
    (e) => e.action === "merge-queue.resolution" || e.action === "merge-queue.approval-requested",
  );
  if (relevant.length === 0) return null;
  const payloads = await svc.store.auditPayloads(
    svc.auditLog,
    relevant.map((e) => e.seq),
  );
  let found: { at: string; p: Payload; index: number } | null = null;
  relevant.forEach((e, index) => {
    const p = obj(payloads.get(e.seq));
    if (
      e.action === "merge-queue.resolution" &&
      p.status === "resolved" &&
      typeof p.newHead === "string"
    )
      found = { at: e.at, p, index };
  });
  if (found === null) return null;
  const { at, p, index } = found as { at: string; p: Payload; index: number };
  const headSha = p.newHead as string;
  const resolvedFrom = typeof p.headSha === "string" ? p.headSha : null;
  // Pushed again since: that resolution describes an older head (the queue dequeued it).
  if (resolvedFrom !== null && change.headSha !== null && resolvedFrom !== change.headSha)
    return null;
  const approval = relevant
    .slice(index + 1)
    .filter((e) => e.action === "merge-queue.approval-requested")
    .map((e) => obj(payloads.get(e.seq)))
    .at(-1);

  const evidence = await svc.store.getEvidence(change.id, headSha);
  const item =
    (evidence?.items.find((i) => i.kind === "conflict-resolution") as
      | ConflictResolution
      | undefined) ?? null;
  const upstreamIds = [
    ...new Set([...(item?.upstreamChanges.map((u) => u.changeId) ?? []), ...strs(p.upstream)]),
  ].slice(0, 20);
  const upstream = await Promise.all(
    upstreamIds.map(async (id) => {
      const u = await svc.store.getChange(id);
      return {
        changeId: id,
        title: u?.title ?? null,
        sha: item?.upstreamChanges.find((x) => x.changeId === id)?.sha ?? u?.mergedSha ?? null,
      };
    }),
  );
  const tour = await svc.store.getTour(change.id, headSha);
  const lane = approval?.lane;
  return {
    headSha,
    originalHeadSha: change.headSha,
    resolvedFrom,
    ontoSha: item?.ontoSha ?? (typeof p.ontoSha === "string" ? p.ontoSha : null),
    at,
    attempt: typeof p.attempt === "number" ? p.attempt : 1,
    kind: p.kind === "semantic" ? "semantic" : "textual",
    item,
    upstream,
    tourId: tour?.id ?? null,
    approvalRequested: approval !== undefined,
    lane: lane === 0 || lane === 1 || lane === 2 ? lane : null,
    reasons: strs(approval?.reasons),
  };
}
