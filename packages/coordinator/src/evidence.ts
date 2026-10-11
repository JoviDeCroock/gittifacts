/**
 * Evidence sealing (sign → verify → store) for the ChangeWorkflow and the merge queue, and the
 * preview item. The pure assembly (`assembleEvidence` and friends) moved to `@app/core` and is
 * re-exported here so existing imports keep working.
 */
import { type SealedEvidence, uniqueIds } from "@app/core";
import type { Evidence } from "@app/domain";
import type { EvidenceItem, PreviewDeploy } from "@app/evidence";
import { evidenceIdFor } from "./ids.js";
import type { Ports, PreviewOutcome } from "./ports.js";

export {
  type AssembledEvidence,
  assembleEvidence,
  erroredJudgment,
  judgmentItems,
  type SealedEvidence,
  touchedPaths,
  uniqueIds,
} from "@app/core";

/** The `preview` evidence item for a preview outcome (`null`: previews are not configured). */
export function previewItem(outcome: PreviewOutcome): PreviewDeploy {
  if (outcome.status === "ready") {
    return { id: "preview", kind: "preview", status: "ok", url: outcome.url };
  }
  return {
    id: "preview",
    kind: "preview",
    status: outcome.status,
    note: outcome.reason.slice(0, 4000),
    ...(outcome.url === null ? {} : { url: outcome.url }),
  };
}

/**
 * A re-grade of the same head (a re-run, a Plan or label edit, an approval withdrawn by QA) makes a
 * new bundle; QA ran on that head only on request, so its `qa-run` item is carried over from the
 * head's previous bundle, but only when that bundle's signature still verifies (else it is dropped
 * and the caller logs why).
 */
export async function carryQaRun(
  ports: Pick<Ports, "signer" | "store">,
  input: { changeId: string; headSha: string; items: EvidenceItem[] },
): Promise<{ items: EvidenceItem[]; carried: number; dropped: string | null }> {
  if (input.items.some((i) => i.kind === "qa-run"))
    return { items: input.items, carried: 0, dropped: null };
  const prior = await ports.store.getEvidence(input.changeId, input.headSha);
  const qa = prior?.items.filter((i) => i.kind === "qa-run") ?? [];
  if (prior === null || qa.length === 0) return { items: input.items, carried: 0, dropped: null };
  const check = await ports.signer.verifyEvidence(prior);
  if (!check.ok)
    return {
      items: input.items,
      carried: 0,
      dropped: check.reason ?? "the previous bundle did not verify",
    };
  return { items: [...input.items, ...qa], carried: qa.length, dropped: null };
}

/** Sign {changeId, headSha, items}, verify the attestation, store it, link it on the change. */
export async function sealEvidence(
  ports: Pick<Ports, "signer" | "store" | "clock">,
  input: {
    changeId: string;
    headSha: string;
    baseSha: string;
    items: EvidenceItem[];
    notesWritten?: boolean;
  },
): Promise<SealedEvidence> {
  const signed = await ports.signer.signEvidence({
    changeId: input.changeId,
    headSha: input.headSha,
    items: uniqueIds(input.items),
  });
  const check = await ports.signer.verifyEvidence(signed);
  const evidence: Evidence = {
    ...signed,
    id: evidenceIdFor(input.changeId, input.headSha),
    baseSha: input.baseSha,
    createdAt: ports.clock.now().toISOString(),
    notesWritten: input.notesWritten ?? false,
  };
  await ports.store.putEvidence(evidence);
  await ports.store.updateChange(input.changeId, { evidenceId: evidence.id });
  return { evidenceId: evidence.id, verified: check.ok, itemCount: signed.items.length };
}
