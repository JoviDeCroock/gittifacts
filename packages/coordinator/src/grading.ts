/**
 * Native plumbing for `@app/core`'s `gradeChange`: each grading stage is a workflow step (same
 * name, same retry preset), grading reads the diff/evidence/plan from the store inside its
 * stages, and verdicts and tours land on the Change row. `@app/host-artifacts` publishes through
 * the same helpers, so the native adapter and the ChangeWorkflow write the same rows.
 */
import type { ClassifyResult } from "@app/classifier";
import type { GradeData, StageRunner } from "@app/core";
import type { Tour } from "@app/domain";
import type { Store } from "./ports.js";
import { RETRY, type Step } from "./step.js";

/** Grading stages as durable workflow steps (a replay skips finished stages). */
export function durableStages(step: Step): StageRunner {
  return (name, retry, run) => step.do(name, RETRY[retry], run);
}

/** Grading reads straight from the store, so step results stay small. */
export function storeGradeData(
  store: Store,
  input: { changeId: string; headSha: string; planId: string | null },
): GradeData {
  const { changeId, headSha, planId } = input;
  return {
    change: () => store.getChange(changeId),
    plan: async () => (planId === null ? null : store.getPlan(planId)),
    diff: () => store.getDiff(changeId, headSha),
    evidence: () => store.getEvidence(changeId, headSha),
    classification: () => store.getClassification(changeId, headSha),
  };
}

/** The native verdict: the classification of the head, and the lane on the Change row. */
export async function persistClassification(
  store: Store,
  input: { changeId: string; headSha: string; result: ClassifyResult },
): Promise<void> {
  const { changeId, headSha, result } = input;
  await store.putClassification(changeId, headSha, result);
  await store.updateChange(changeId, {
    computedLane: result.computedLane,
    lane: result.lane,
    laneReasons: result.reasons,
  });
}

/** The native tour: stored, and linked from the Change row. */
export async function persistTour(store: Store, changeId: string, tour: Tour): Promise<void> {
  await store.putTour(tour);
  await store.updateChange(changeId, { tourId: tour.id });
}
