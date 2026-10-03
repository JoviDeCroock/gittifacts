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
