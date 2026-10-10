/**
 * `Cas`: compare-and-swap the default branch from `expectedOld` to `newSha` (receive-pack
 * old-oid; Artifacts answers a stale old-oid with `ng <ref> stale ref`, verified live). On ok:
 * re-sign each entry's evidence for the tree that landed (with the queue's verdict), write the
 * evidence notes on the entries' commits, record lane raises, write each entry's why note
 * (`refs/notes/why`: plan, author, approvals), audit `change.merged`.
 *
 * Idempotent: a re-run after a crash finds main already at `newSha` (stale, actual = newSha) and
 * treats it as the success it was. Anything after the ref update is best effort (audited), so a
 * landed CAS is always reported as landed.
 */
import type { Change, Evidence } from "@app/domain";
import {
  EVIDENCE_NOTES_REF,
  type EvidenceItem,
  encodeNote,
  quarantineEvidence,
} from "@app/evidence";
import type { CommandOf, CoreEventInput } from "@app/merge-queue";
import { sealEvidence } from "../evidence.js";
import { changeSubject } from "../ids.js";
import { errorMessage } from "../policy.js";
import { SYSTEM_PRINCIPAL_ID } from "../ports.js";
import type { QueueContext } from "./context.js";
import { writeWhyNote } from "./why-note.js";

type Emit = (event: CoreEventInput) => Promise<void>;

export const casKey = (casId: string) => `cas:${casId}`;
export const shaKey = (sha: string) => `sha:${sha}`;

export async function casHandler(
  ctx: QueueContext,
  cmd: CommandOf<"Cas">,
  emit: Emit,
): Promise<void> {
  const { git } = ctx.ports;
  const repo = await ctx.repo();
  const main = repo.artifactsName;
  const ref = `refs/heads/${repo.defaultBranch}`;
  const result = (r: "ok" | "stale" | "rejected", actualSha: string | null, detail: string) =>
    emit({ type: "CasResult", casId: cmd.casId, result: r, actualSha, detail });

  if ((await git.commitParents(main, cmd.newSha)) === null) {
    await result("rejected", null, `${cmd.newSha} is not in ${main} (refs/queue was not written)`);
    return;
  }
  const r = await git.updateRef(main, ref, cmd.expectedOld, cmd.newSha);
  if (!r.ok) {
    const actual = await git.branchHead(main, repo.defaultBranch);
    if (!(r.reason === "stale" && actual === cmd.newSha)) {
      await ctx.audit(ctx.repoSubject(), "merge-queue.cas-refused", {
        casId: cmd.casId,
        reason: r.reason,
        detail: r.detail,
        expectedOld: cmd.expectedOld,
        actual,
      });
      await result(r.reason === "stale" ? "stale" : "rejected", actual, r.detail);
      return;
    }
    // Main already points at newSha: this CAS landed before a crash/retry.
  }
  try {
    await landEvidence(ctx, cmd);
  } catch (e) {
    await ctx.audit(ctx.repoSubject(), "merge-queue.merge-evidence-failed", {
      casId: cmd.casId,
      error: errorMessage(e),
    });
  }
  await result("ok", cmd.newSha, "");
}

/** Bundle built by the run that tested `treeSha` (rollouts deploy it). */
function bundleOf(ctx: QueueContext, runIds: string[]): string | null {
  for (const id of runIds) {
    const run = ctx.deps.store.getRun<{ bundleRef?: string | null }>(`result:${id}`);
    if (run?.bundleRef) return run.bundleRef;
  }
  return null;
}

async function landEvidence(ctx: QueueContext, cmd: CommandOf<"Cas">): Promise<void> {
  const { store, signer } = ctx.ports;
  const state = ctx.deps.state();
  const batch = state.cas?.casId === cmd.casId ? state.batches[state.cas.batchId] : undefined;
  const commitOf = new Map((batch?.commits ?? []).map((c) => [c.changeId, c.commitSha]));
  const runIds = [
    ...cmd.evidence.verdict.runIds,
    ...cmd.evidence.carried.flatMap((c) => c.verdict.runIds),
  ];
  const bundleRef = bundleOf(ctx, runIds);
  ctx.deps.store.putRun(casKey(cmd.casId), { newSha: cmd.newSha, bundleRef });
  ctx.deps.store.putRun(shaKey(cmd.newSha), { bundleRef });
  const at = ctx.ports.clock.now().toISOString();
  for (const entry of cmd.entries) {
    const change = await store.getChange(entry.changeId);
    if (change === null) continue;
    const original =
      (await store.getEvidence(change.id, entry.headSha)) ??
      (change.headSha === null ? null : await store.getEvidence(change.id, change.headSha));
    const items: EvidenceItem[] = [...(original?.items ?? [])].filter(
      (i) => i.kind !== "quarantine",
    );
    if (cmd.evidence.quarantined.length > 0) {
      const affected = state.entries[entry.changeId]?.affected ?? null;
      items.push(
        quarantineEvidence({
          quarantined: cmd.evidence.quarantined.map((t) => ({
            id: t,
            file: t,
            name: t,
            flakeRate: 0,
            quarantinedAt: at,
          })),
          affected: affected === null || !affected.complete ? null : affected,
        }),
      );
    }
    // Evidence describes what lands: signed for the merged commit, with the queue's verdict.
    const sealed = await sealEvidence(ctx.ports, {
      changeId: change.id,
      headSha: cmd.newSha,
      baseSha: cmd.expectedOld,
      items,
    });
    const verdict = {
      purpose: "merge-queue-verdict",
      changeId: change.id,
      headSha: entry.headSha,
      mergedSha: cmd.newSha,
      treeSha: cmd.treeSha,
      evidenceId: sealed.evidenceId,
      verdict: cmd.evidence.verdict,
      carried: cmd.evidence.carried,
      quarantined: cmd.evidence.quarantined,
      lane: entry.lane,
    };
    const signature = await signer.signDocument(verdict);
    await ctx.ports.audit.append({
      principalId: SYSTEM_PRINCIPAL_ID,
      action: "merge-queue.merge-evidence",
      subject: changeSubject(change.id),
      payload: { ...verdict, verified: sealed.verified, signature, keyId: signer.keyId, bundleRef },
    });
    const evidence = await store.getEvidence(change.id, cmd.newSha);
    const target = commitOf.get(change.id) ?? cmd.newSha;
    if (evidence !== null) await writeMergedNote(ctx, evidence, target);
    await recordLaneRaise(ctx, change, cmd);
    // After the lane raise, so the note shows the lane it landed on.
    await writeWhyNote(ctx, {
      change,
      headSha: entry.headSha,
      target,
      evidenceId: sealed.evidenceId,
      items,
      at,
    });
  }
}

/**
 * The evidence for what landed, as a git note on main (`refs/notes/evidence` on `target`, the
 * entry's commit). The stored row records that it was written (`notesWritten`): sealing for the
 * merged sha starts it at false, and on the fast path (the head IS the merged commit) that row is
 * the one the Change's evidence page shows, so a note left unrecorded read "Not written" there.
 * A failed write is audited, never swallowed; the landing itself stands either way.
 */
async function writeMergedNote(ctx: QueueContext, evidence: Evidence, target: string) {
  const repo = await ctx.repo();
  try {
    await ctx.ports.git.writeNote(repo.artifactsName, target, encodeNote(evidence), {
      notesRef: EVIDENCE_NOTES_REF,
      mode: "replace",
    });
  } catch (e) {
    await ctx.audit(changeSubject(evidence.changeId), "merge-queue.evidence-note-failed", {
      sha: target,
      evidenceId: evidence.id,
      error: errorMessage(e).slice(0, 2000),
    });
    return;
  }
  await ctx.ports.store.putEvidence({ ...evidence, notesWritten: true });
}

/** The queue raised the lane (resolution, quarantine): record it on the Change (lanes only rise). */
async function recordLaneRaise(
  ctx: QueueContext,
  change: Change,
  cmd: CommandOf<"Cas">,
): Promise<void> {
  const raise = cmd.evidence.laneRaises.find((l) => l.changeId === change.id);
  if (raise === undefined) return;
  const known = new Set(change.laneReasons.map((r) => r.code));
  const lane = Math.max(change.lane ?? 0, raise.lane) as 0 | 1 | 2;
  await ctx.ports.store.updateChange(change.id, {
    lane,
    laneReasons: [...change.laneReasons, ...raise.reasons.filter((r) => !known.has(r.code))],
  });
}
