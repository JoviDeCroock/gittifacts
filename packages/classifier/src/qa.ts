/**
 * QA in a browser (on request): what a `qa-run` item says about the lane. Pure.
 *
 * - No item: QA was not requested. Nothing is raised and nothing is lowered (QA is opt-in).
 * - A failed criterion → `qa.failed` (Lane 2). A criterion QA couldn't test, or a run with no
 *   criteria → `qa.couldnt-test` (Lane 1, unknown: a requested check didn't conclude).
 * - A run that errored → `signal.error.qa` (Lane 1, unknown).
 * - Everything passed → `qa.passed` (Lane 0): listed for transparency, it lowers nothing.
 *
 * `raiseForQa` applies the same rules to a stored classification after an on-request run, without
 * re-running the rest of the classifier: it can only keep or raise the lane.
 */
import type { Lane, LaneReason } from "@app/domain";
import type { QaRun } from "@app/evidence";
import type { ChecklistEntry, ClassifyResult } from "./classify.js";
import { compareStrings, formatList } from "./paths.js";
import { formatReason, REASON_CODES, type ReasonCode, type ReasonParams } from "./reasons.js";

export interface QaReasonInput {
  code: ReasonCode;
  params: ReasonParams;
  evidenceRef: string;
}

const QA_CODES: ReadonlySet<string> = new Set([
  "qa.passed",
  "qa.failed",
  "qa.couldnt-test",
  "signal.error.qa",
]);
const SHADOW = "shadow.lane0-disabled";

function short(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The QA reasons of a bundle's `qa-run` items (none when QA was not requested). */
export function qaReasonInputs(items: readonly QaRun[]): QaReasonInput[] {
  const out: QaReasonInput[] = [];
  for (const q of items) {
    if (q.status === "skipped") continue;
    if (q.status === "error") {
      out.push({
        code: "signal.error.qa",
        params: { detail: q.note ? `: ${short(q.note, 280)}` : "" },
        evidenceRef: q.id,
      });
      continue;
    }
    const failed = q.criteria.filter((c) => c.verdict === "fail");
    const unsure = q.criteria.filter((c) => c.verdict === "couldnt-test");
    const list = (cs: typeof failed) =>
      formatList(
        cs.map((c) => `"${short(c.text)}"`),
        3,
      );
    if (failed.length > 0)
      out.push({
        code: "qa.failed",
        params: { count: failed.length, criteria: list(failed) },
        evidenceRef: q.id,
      });
    if (q.criteria.length === 0) {
      out.push({
        code: "qa.couldnt-test",
        params: { count: 0, criteria: "the run had no criteria to test" },
        evidenceRef: q.id,
      });
    } else if (unsure.length > 0) {
      out.push({
        code: "qa.couldnt-test",
        params: { count: unsure.length, criteria: list(unsure) },
        evidenceRef: q.id,
      });
    }
    if (failed.length === 0 && unsure.length === 0 && q.criteria.length > 0) {
      out.push({ code: "qa.passed", params: { count: q.criteria.length }, evidenceRef: q.id });
    }
  }
  return out;
}

function toReason(r: QaReasonInput): LaneReason {
  return {
    code: r.code,
    lane: REASON_CODES[r.code].lane,
    message: formatReason(r.code, r.params),
    evidenceRef: r.evidenceRef,
  };
}

function compareReasons(a: LaneReason, b: LaneReason): number {
  return b.lane - a.lane || compareStrings(a.code, b.code) || compareStrings(a.message, b.message);
}

/** The `qa` checklist entry for these reasons (added when an older classification has none). */
function qaEntry(reasons: readonly LaneReason[]): ChecklistEntry {
  const raised = reasons.filter((r) => r.lane > 0);
  if (raised.length === 0) {
    const detail = reasons.map((r) => r.message).join(" ");
    return { gate: "qa", passed: true, detail: detail || "QA was not requested (optional)." };
  }
  const fail = raised.some((r) => REASON_CODES[r.code as ReasonCode]?.outcome === "fail");
  return {
    gate: "qa",
    passed: fail ? false : null,
    detail: raised.map((r) => r.message).join(" "),
  };
}

/**
 * `previous` with the QA run's reasons added, floored at `previous`: the lane and computed lane
 * never go down. Earlier QA reasons that raised the lane stay (a later pass doesn't undo a fail on
 * the same head); earlier Lane-0 QA reasons are replaced. A raised computed lane ends shadow mode
 * (its Lane-0 candidate is no longer one).
 */
export function raiseForQa(previous: ClassifyResult, item: QaRun): ClassifyResult {
  const added = qaReasonInputs([item]).map(toReason);
  const kept = previous.reasons.filter((r) => !(QA_CODES.has(r.code) && r.lane === 0));
  const addedMax = Math.max(0, ...added.map((r) => r.lane)) as Lane;
  const computedLane = Math.max(previous.computedLane, addedMax) as Lane;
  const endsShadow = previous.shadow && computedLane > 0;
  const reasons = [...kept.filter((r) => !(endsShadow && r.code === SHADOW)), ...added].sort(
    compareReasons,
  );
  const lane = Math.max(previous.lane, computedLane, ...reasons.map((r) => r.lane)) as Lane;
  const qaReasons = reasons.filter((r) => QA_CODES.has(r.code));
  const entry = qaEntry(qaReasons);
  const hasQa = previous.checklist.some((e) => e.gate === "qa");
  const checklist = hasQa
    ? previous.checklist.map((e) => (e.gate === "qa" ? entry : e))
    : [...previous.checklist, entry];
  return {
    ...previous,
    lane,
    computedLane,
    reasons,
    shadow: endsShadow ? false : previous.shadow,
    checklist,
  };
}

export { qaEntry as qaChecklistEntry };
