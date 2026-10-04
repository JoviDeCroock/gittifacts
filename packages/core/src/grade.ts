/**
 * `gradeChange`: the host-agnostic grading pipeline. The same code grades a native Change (the
 * ChangeWorkflow calls it with durable stages) and a GitHub PR, so the same change gets the same
 * lane, evidence and tour on either host.
 *
 *   evidence run → [host items] → evidence (assemble + seal) → [host steps] → judge →
 *   [evidence on the host] → classify → [lane on the host] → tour (lane ≥ 1 or shadowed Lane 0) →
 *   reclassify → verdict
 *
 * Stage names, retry classes and stage results are a contract with the durable runner: in-flight
 * native workflows replay against them. Change them only together with a migration note.
 */
import { type ClassifyResult, classify, type TourStatus } from "@app/classifier";
import { diffStatsOf, Tour } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { evidenceNoteDegradation, type LaneVerdict, routeVerdict } from "@app/host";
import { judgeFactsFrom } from "@app/tour";
import {
  assembleEvidence,
  erroredJudgment,
  judgmentItems,
  type SealedEvidence,
} from "./evidence.js";
import { errorMessage, escalateForPolicy } from "./policy.js";
import type {
  Classified,
  EvidenceReport,
  GradeDeps,
  GradeInput,
  GradeOutcome,
  SkipJudge,
  VerdictSummary,
} from "./ports.js";

interface Judged {
  sealed: SealedEvidence | null;
  budgetExceeded: boolean;
  costUsd: number;
  judgments: number;
}

interface TourRun {
  status: "ok" | "failed";
  reason: string | null;
  budgetExceeded: boolean;
}

export async function gradeChange<R extends EvidenceReport>(
  input: GradeInput,
  deps: GradeDeps<R>,
): Promise<GradeOutcome<R>> {
  const { change, capabilities } = input;
  const resolved = input.policy;
  const policy = resolved.policy;
  const { stage, data, log, hooks } = deps;
  const { id: changeId, headSha, baseSha } = change;

  // ------------------------------------------------------------ evidence run (CI + sandbox)
  const ci = await deps.evidence.run({ change, policy });
  const workerItems: EvidenceItem[] =
    hooks?.workerItems === undefined ? [] : await hooks.workerItems(ci);

  // ------------------------------------------------------------ evidence (assemble + seal)
  let sealed: SealedEvidence = await stage("evidence", "quick", async () => {
    const diff = await data.diff();
    const { items, dropped } = assembleEvidence({
      ciItems: ci.items,
      diff,
      policy,
      agentTraceId: change.agentTraceId,
      workerItems,
    });
    const out = await deps.sealer.seal(items);
    await log("change.evidence-signed", { ...out, dropped });
    return out;
  });

  // ------------------------------------------------------------ host steps after sealing
  let pureRevertVerified = false;
  let skipJudge: SkipJudge | null = null;
  if (hooks?.afterEvidence !== undefined) {
    const after = await hooks.afterEvidence({ ci, sealed });
    if (after.stop === true) return { status: "stopped", ci, evidence: sealed };
    sealed = after.sealed;
    pureRevertVerified = after.pureRevertVerified;
    skipJudge = after.skipJudge;
  }

  // ------------------------------------------------------------ judge (raise-only, within budget)
  const limitUsd = policy.ai.budgetUsdPerChange;
  let budgetExceeded = false;
  const reseal = async (extra: EvidenceItem[]): Promise<SealedEvidence> => {
    const current = await data.evidence();
    if (current === null) throw new Error("evidence disappeared");
    const keep = current.items.filter((i) => i.kind !== "llm-judgment");
    return deps.sealer.seal([...keep, ...extra]);
  };
  if (skipJudge !== null) {
    const skipped = skipJudge;
    await stage("judge-skipped", "quick", async () => {
      await log("change.judge-skipped", { reason: skipped.reason, ...skipped.detail });
      return true;
    });
  } else {
    try {
      const judged = await stage("judge", "model", async (): Promise<Judged> => {
        const spentUsd = await deps.budget.spent();
        if (spentUsd >= limitUsd) {
          return { sealed: null, budgetExceeded: true, costUsd: 0, judgments: 0 };
        }
        const [plan, diff, evidence] = await Promise.all([
          data.plan(),
          data.diff(),
          data.evidence(),
        ]);
        if (diff === null) throw new Error("diff missing");
        const out = await deps.reviewer.judge({
          plan,
          diff,
          // Only what the signed evidence proves (a verified transform, the public-API diff).
          facts: judgeFactsFrom(evidence?.items ?? []),
          budget: { changeId, limitUsd, spentUsd },
          model: policy.ai.reviewerModel,
        });
        const total = await deps.budget.record(out.costUsd);
        const items = judgmentItems(out.items);
        const resealed = items.length > 0 ? await reseal(items) : null;
        await log("change.judged", {
          judgments: items.length,
          costUsd: out.costUsd,
          totalUsd: total,
        });
        return {
          sealed: resealed,
          budgetExceeded: out.budgetExceeded || total > limitUsd,
          costUsd: out.costUsd,
          judgments: items.length,
        };
      });
      if (judged.sealed !== null) sealed = judged.sealed;
      budgetExceeded = judged.budgetExceeded;
    } catch (e) {
      const reason = errorMessage(e);
      sealed = await stage("judge-failed", "quick", async () => {
        const out = await reseal([erroredJudgment(`judge failed: ${reason}`)]);
        await log("change.judge-failed", { error: reason });
        return out;
      });
    }
  }

  // ------------------------------------------------------------ evidence on the host (git notes)
  const publishEvidence = hooks?.publishEvidence;
  if (capabilities.supportsNotes && publishEvidence !== undefined) {
    try {
      await stage("evidence-note", "remote", async () => {
        await publishEvidence();
        return true;
      });
    } catch (e) {
      const reason = errorMessage(e);
      await stage("evidence-note-failed", "quick", async () => {
        await log("change.evidence-note-failed", { error: reason });
        return true;
      });
    }
  }

  // ------------------------------------------------------------ classify (pure) → verdict
  const routeOf = (cls: Pick<Classified, "lane" | "blocked" | "requiresHumanApproval">) => {
    const route = routeVerdict({ ...cls, autoMergeAllowed: input.autoMergeAllowed }, capabilities);
    const note = evidenceNoteDegradation(capabilities);
    return {
      action: route.action,
      degradations: note === null ? route.degradations : [...route.degradations, note],
    };
  };
  const classifyStage = (
    name: string,
    tourStatus: TourStatus,
    overBudget: boolean,
    current: SealedEvidence,
    preliminary: (r: ClassifyResult) => boolean,
  ) =>
    stage(name, "quick", async (): Promise<Classified> => {
      const [evidence, diff, plan] = await Promise.all([data.evidence(), data.diff(), data.plan()]);
      const raw: ClassifyResult = classify(
        evidence === null ? null : { items: evidence.items },
        policy,
        plan,
        diff === null ? null : diffStatsOf(diff),
        { category: change.category },
        {
          ciStatus: ci.ciStatus,
          evidenceVerified: current.verified,
          budgetExceeded: overBudget,
          tourStatus,
          pureRevertVerified,
        },
      );
      const result = escalateForPolicy(raw, resolved);
      const verdict: LaneVerdict = {
        ...result,
        headSha,
        ...routeOf(result),
        tourStatus,
        preliminary: preliminary(result),
        evidence: { id: current.evidenceId, verified: current.verified },
      };
      await deps.sink.verdict(verdict, result);
      await log("change.classified", {
        headSha,
        lane: result.lane,
        computedLane: result.computedLane,
        shadow: result.shadow,
        blocked: result.blocked,
        requiresHumanApproval: result.requiresHumanApproval,
        tourStatus,
        budgetExceeded: overBudget,
        pureRevertVerified,
        policy: resolved.source,
        reasons: result.reasons.filter((r) => r.lane > 0).map((r) => r.code),
      });
      return {
        lane: result.lane,
        computedLane: result.computedLane,
        shadow: result.shadow,
        blocked: result.blocked,
        requiresHumanApproval: result.requiresHumanApproval,
        revertAutoMerge: result.reasons.some((r) => r.code === "revert.auto-merge"),
      };
    });
  const needsTour = (c: Pick<Classified, "blocked" | "lane" | "shadow">) =>
    input.skipTour !== true && !c.blocked && (c.lane >= 1 || c.shadow);
  let cls = await classifyStage("classify", "not-generated", budgetExceeded, sealed, needsTour);
  if (needsTour(cls) && hooks?.laneKnown !== undefined) await hooks.laneKnown(cls);

  // ------------------------------------------------------------ tour (lane ≥ 1, and shadowed lane 0)
  let tour: TourRun | null = null;
  let tourStatus: TourStatus = "not-generated";
  if (needsTour(cls)) {
    try {
      tour = await stage("tour", "model", async (): Promise<TourRun> => {
        const spentUsd = await deps.budget.spent();
        if (spentUsd >= limitUsd)
          return { status: "failed", reason: "AI budget exhausted", budgetExceeded: true };
        const [row, plan, diff, evidence, classification] = await Promise.all([
          data.change(),
          data.plan(),
          data.diff(),
          data.evidence(),
          data.classification(),
        ]);
        if (row === null || diff === null || evidence === null || classification === null) {
          throw new Error("tour inputs missing");
        }
        // The reviewer agent never sees the author's own summary: only id/title/shas.
        const out = await deps.reviewer.tour({
          change: { id: row.id, title: row.title, headSha, baseSha },
          plan,
          diff,
          evidence,
          classification,
          budget: { changeId, limitUsd, spentUsd },
          model: policy.ai.reviewerModel,
        });
        const total = await deps.budget.record(out.costUsd);
        const overBudget = out.budgetExceeded || total > limitUsd;
        if (out.status === "failed") {
          await log("change.tour-failed", { reason: out.reason, costUsd: out.costUsd });
          return { status: "failed", reason: out.reason, budgetExceeded: overBudget };
        }
        const valid = Tour.safeParse(out.tour);
        if (!valid.success || valid.data.changeId !== changeId || valid.data.headSha !== headSha) {
          await log("change.tour-failed", {
            reason: "tour failed schema validation or is for another head",
          });
          return { status: "failed", reason: "invalid tour", budgetExceeded: overBudget };
        }
        await deps.sink.tour(valid.data);
        await log("change.tour-generated", {
          tourId: valid.data.id,
          stops: valid.data.stops.length,
          costUsd: out.costUsd,
        });
        return { status: "ok", reason: null, budgetExceeded: overBudget };
      });
    } catch (e) {
      tour = { status: "failed", reason: errorMessage(e), budgetExceeded: false };
    }
    budgetExceeded = budgetExceeded || tour.budgetExceeded;
    tourStatus = tour.status;
    // Tour failure → reclassify (Lane 2); success is recorded too so the reasons say "generated".
    cls = await classifyStage("reclassify", tour.status, budgetExceeded, sealed, () => false);
  }

  const verdict: VerdictSummary = {
    headSha,
    lane: cls.lane,
    computedLane: cls.computedLane,
    shadow: cls.shadow,
    blocked: cls.blocked,
    requiresHumanApproval: cls.requiresHumanApproval,
    ...routeOf(cls),
    tourStatus,
    preliminary: false,
    evidence: { id: sealed.evidenceId, verified: sealed.verified },
  };
  return {
    status: "graded",
    ci,
    evidence: sealed,
    classification: cls,
    tour: tour === null ? null : { status: tour.status, reason: tour.reason },
    verdict,
    budgetExceeded,
    pureRevertVerified,
  };
}
