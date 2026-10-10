/**
 * `refs/notes/why` on each landed commit (format: @app/evidence `why.ts`). The evidence note says
 * what a Change does; this one says why it exists and who answers for it, readable from any clone:
 * the approved Plan, the author (for an agent, also its accountable human), the lane and its
 * reasons, the approvals that stood, the agent trace and the evidence it landed with, signed by
 * the platform. Best effort like the evidence note: a failure is audited and never undoes a landing.
 */
import type { Change, Principal } from "@app/domain";
import {
  type EvidenceItem,
  encodeWhyNote,
  WHY_NOTE_FORMAT,
  WHY_NOTES_REF,
  WHY_SIGNATURE_PURPOSE,
  type WhyPrincipal,
  type WhyRecord,
} from "@app/evidence";
import { changeSubject } from "../ids.js";
import { errorMessage } from "../policy.js";
import type { QueueContext } from "./context.js";

export interface WhyLanding {
  /** The landed Change (re-read before writing: the queue may have raised its lane). */
  change: Change;
  /** The head that was reviewed and queued. */
  headSha: string;
  /** The commit on main the notes go on. */
  target: string;
  evidenceId: string | null;
  items: readonly EvidenceItem[];
  at: string;
}

function who(p: Principal | null, id: string): WhyPrincipal {
  return p === null
    ? { id, kind: "unknown", name: "unknown" }
    : { id: p.id, kind: p.kind, name: p.name };
}

/** Everything the signature covers, from the store's records for the landed Change. */
export async function whyRecord(ctx: QueueContext, l: WhyLanding): Promise<WhyRecord> {
  const { store } = ctx.ports;
  const principals = new Map<string, Principal | null>();
  const principal = async (id: string) => {
    if (!principals.has(id)) principals.set(id, await store.getPrincipal(id));
    return who(principals.get(id) ?? null, id);
  };
  const { change } = l;
  const author = await principal(change.authorId);
  const ownerId = principals.get(change.authorId)?.ownerId ?? null;
  const plan = change.planId === null ? null : await store.getPlan(change.planId);
  const reviews = (await store.listReviews?.(change.id)) ?? [];
  const approvals = [];
  for (const r of reviews)
    if (r.decision === "approve" && (r.withdrawn ?? null) === null)
      approvals.push({
        reviewer: await principal(r.reviewerId),
        headSha: r.headSha,
        at: r.createdAt,
        source: r.source ?? "platform",
      });
  const trace = l.items.find((i) => i.kind === "agent-trace" && i.status === "ok");
  return {
    format: WHY_NOTE_FORMAT,
    changeId: change.id,
    title: change.title,
    category: change.claim.category,
    headSha: l.headSha,
    landedSha: l.target,
    author,
    accountable: ownerId === null ? null : await principal(ownerId),
    plan:
      plan === null
        ? null
        : {
            id: plan.id,
            title: plan.title,
            intent: plan.intent,
            acceptanceCriteria: plan.acceptanceCriteria,
            outOfScope: plan.outOfScope,
            approvedBy: plan.approvedBy === null ? null : await principal(plan.approvedBy),
            approvedAt: plan.approvedAt,
            approvalSignature: plan.approvalSignature,
          },
    lane: change.lane,
    laneReasons: change.laneReasons.map((r) => ({
      code: r.code,
      lane: r.lane,
      message: r.message,
    })),
    approvals,
    agentTrace:
      trace?.kind === "agent-trace"
        ? {
            provider: trace.provider,
            traceId: trace.traceId,
            ...(trace.url === undefined ? {} : { url: trace.url }),
          }
        : null,
    evidenceId: l.evidenceId,
    landedAt: l.at,
  };
}

/** Sign and write the why note on the landed commit; a failure is audited, never thrown. */
export async function writeWhyNote(ctx: QueueContext, l: WhyLanding): Promise<void> {
  try {
    const change = (await ctx.ports.store.getChange(l.change.id)) ?? l.change;
    const record = await whyRecord(ctx, { ...l, change });
    const { signer } = ctx.ports;
    const signature = await signer.signDocument(record);
    const note = encodeWhyNote({
      ...record,
      attestation: { keyId: signer.keyId, purpose: WHY_SIGNATURE_PURPOSE, signature },
    });
    const repo = await ctx.repo();
    await ctx.ports.git.writeNote(repo.artifactsName, l.target, note, {
      notesRef: WHY_NOTES_REF,
      mode: "replace",
    });
  } catch (e) {
    await ctx.audit(changeSubject(l.change.id), "merge-queue.why-note-failed", {
      sha: l.target,
      error: errorMessage(e).slice(0, 2000),
    });
  }
}
