/**
 * Admission: the core's `Enqueued` event built from the Change row (the truth), the
 * ChangeWorkflow's admission (head, lane, what the approval covers) and the enqueue options an
 * agent or human gave through `enqueue` (MCP/HTTP). Only the ChangeWorkflow admits a Change, so
 * routing rules (review, unclaimed projects never auto-merge) cannot be bypassed by `enqueue`.
 */
import type { Change, ChangeDiff, Evidence, Repo } from "@app/domain";
import type { CoreEventInput, EvidenceSummary, PriorityClass } from "@app/merge-queue";
import type { EnqueueInput } from "../bindings.js";
import { flagKeyFor } from "../ids.js";
import type { Ports } from "../ports.js";
import type { QueueIntent } from "./context.js";

const MERGED: ReadonlySet<Change["status"]> = new Set(["merged", "rolling-out", "released"]);

export function evidenceSummary(evidence: Evidence | null): EvidenceSummary {
  const items = evidence?.items ?? [];
  const rg = items.find((i) => i.kind === "red-green");
  const cov = items.find((i) => i.kind === "coverage");
  const mut = items.find((i) => i.kind === "mutation");
  return {
    redGreen: rg === undefined || rg.status !== "ok" ? null : rg.verdict === "proven",
    coverage: cov === undefined || cov.status !== "ok" ? null : cov.ratio,
    mutationScore: mut === undefined || mut.status !== "ok" ? null : mut.score,
  };
}

/**
 * A Change is individually switchable (it may share a deploy train, and a regression kills its
 * flag) only if its own code reads its kill-switch flag: an added line names the flag key
 * (`change-<id>`), or the added code calls `isChangeEnabled` (the helper in @app/coordinator/flags
 * and the Workers templates) and quotes the Change id. Otherwise it deploys alone (§4.8).
 */
export function switchableFlag(changeId: string, diff: ChangeDiff | null): string | null {
  if (diff === null) return null;
  const key = flagKeyFor(changeId);
  const quoted = [`"${changeId}"`, `'${changeId}'`, `\`${changeId}\``];
  let helper = false;
  let id = false;
  for (const f of diff.files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.kind !== "add") continue;
        if (l.text.includes(key)) return key;
        helper ||= l.text.includes("isChangeEnabled");
        id ||= quoted.some((q) => l.text.includes(q));
      }
  return helper && id ? key : null;
}

/** Priority from the Change and the options: reverts are reverts; the rest was validated on request. */
export function priorityFor(change: Change, intent: QueueIntent | null): PriorityClass {
  if (change.revertOf !== null) return "revert";
  const p = intent?.options.priority ?? "normal";
  return p === "revert" ? "normal" : p;
}

export async function buildEnqueued(
  ports: Pick<Ports, "store">,
  input: { change: Change; repo: Repo; admission: EnqueueInput; intent: QueueIntent | null },
): Promise<Extract<CoreEventInput, { type: "Enqueued" }>> {
  const { store } = ports;
  const { change, admission, intent } = input;
  const headSha = admission.headSha;
  const [diff, evidence, author] = await Promise.all([
    store.getDiff(change.id, headSha),
    store.getEvidence(change.id, headSha),
    store.getPrincipal(change.authorId),
  ]);
  const lane = admission.lane ?? change.lane ?? 2;
  // A human review approves the lane it saw; a verified revert is auto-merged by policy at its lane.
  const approvedLane = admission.approvedLane ?? (admission.via === "lane-0" ? 0 : lane);
  const dependsOn: string[] = [];
  for (const d of intent?.options.dependsOn ?? []) {
    const dep = await store.getChange(d);
    // Merged dependencies are satisfied; unknown ones are kept (the core holds the entry).
    if (dep === null || !MERGED.has(dep.status)) dependsOn.push(d);
  }
  const lines = diff === null ? 0 : diff.additions + diff.deletions;
  return {
    type: "Enqueued",
    changeId: change.id,
    headSha,
    authorId: change.authorId,
    enqueuedBy: intent?.requestedBy ?? {
      principalId: change.authorId,
      // Anything that is not a human or the platform counts as an agent (fair share per agent).
      kind: author?.kind === "human" || author?.kind === "system" ? author.kind : "agent",
      sessionId: null,
    },
    priority: priorityFor(change, intent),
    incidentByHuman: intent?.options.incidentByHuman === true,
    lane,
    approvedLane,
    dependsOn,
    landMode: intent?.options.landMode ?? "incremental",
    plangroup: intent?.options.plangroup ?? null,
    landTogether: intent?.options.landTogether ?? false,
    groupSize: intent?.options.groupSize ?? null,
    revertOf: change.revertOf,
    automaticRevert: change.revertOf !== null && intent?.options.automaticRevert === true,
    flagKey: switchableFlag(change.id, diff),
    affected: null,
    size: { lines, files: diff?.files.length ?? 0 },
    evidence: evidenceSummary(evidence),
  };
}
