/**
 * Evidence vocabulary: one label per kind, a short honest summary per item, and a tone.
 * A skipped or errored item is "not measured", which never reads as good.
 */
import type { LaneReason } from "@app/domain";
import type { EvidenceItem, EvidenceKind } from "@app/evidence";
import { pct } from "./lanes.js";
import type { Tone } from "./vocab.js";

export const KIND_LABEL: Record<EvidenceKind, string> = {
  "red-green": "Red → green proof",
  "test-run": "Test run",
  coverage: "Changed-line coverage",
  mutation: "Mutation testing",
  "public-api": "Public API diff",
  dependencies: "Dependency diff",
  "sensitive-paths": "Sensitive paths",
  preview: "Preview deploy",
  screenshots: "Screenshots",
  "agent-trace": "Agent trace",
  transform: "Reproducible transform",
  "llm-judgment": "Model judgment",
  "conflict-resolution": "Conflict resolution",
  quarantine: "Quarantined tests",
  "qa-run": "QA in a browser",
};

export interface ItemSummary {
  label: string;
  value: string;
  tone: Tone;
}

const QUESTION_LABEL = {
  "scope-drift": "Scope drift",
  "plan-conformance": "Plan conformance",
  "hidden-behavior-change": "Hidden behavior change",
} as const;

/** Index label: a change can carry several model judgments, so each is named by its question. */
function shortLabel(item: EvidenceItem): string {
  return item.kind === "llm-judgment" ? QUESTION_LABEL[item.question] : KIND_LABEL[item.kind];
}

export function summarize(item: EvidenceItem): ItemSummary {
  if (item.status === "error")
    return { label: shortLabel(item), value: "Failed to measure", tone: "danger" };
  if (item.status === "skipped")
    return { label: shortLabel(item), value: "Not measured", tone: "warn" };
  switch (item.kind) {
    case "red-green":
      return {
        label: "Red → green",
        value:
          item.verdict === "proven"
            ? "Proven"
            : item.verdict === "no-tests"
              ? "No tests"
              : "Not proven",
        tone: item.verdict === "proven" ? "ok" : "warn",
      };
    case "test-run": {
      const pre = splitFailures(item).pre.length;
      const counted = item.failed - pre;
      return {
        label: item.step.charAt(0).toUpperCase() + item.step.slice(1),
        value:
          counted > 0
            ? `${counted} failing${pre > 0 ? ` (+${pre} pre-existing)` : ""}`
            : pre > 0
              ? `${pre} pre-existing`
              : `${item.passed} passed`,
        tone: counted > 0 ? "danger" : pre > 0 ? "warn" : "ok",
      };
    }
    case "coverage":
      return { label: "Coverage", value: pct(item.ratio), tone: item.ratio >= 0.8 ? "ok" : "warn" };
    case "mutation":
      if (item.killed + item.survived + item.timedOut === 0 && item.noCoverage > 0)
        return { label: "Mutation", value: "No tests cover it", tone: "warn" };
      return { label: "Mutation", value: pct(item.score), tone: item.survived > 0 ? "warn" : "ok" };
    case "public-api":
      return {
        label: "Public API",
        value:
          item.classification === "none"
            ? "Unchanged"
            : item.classification === "additive"
              ? "Additive"
              : "Breaking",
        tone:
          item.classification === "breaking"
            ? "danger"
            : item.classification === "additive"
              ? "warn"
              : "ok",
      };
    case "dependencies": {
      const n = item.added.length + item.removed.length + item.changed.length;
      if (item.newInstallScripts.length > 0)
        return {
          label: "Dependencies",
          value: `${item.newInstallScripts.length} install script`,
          tone: "danger",
        };
      return {
        label: "Dependencies",
        value: n === 0 ? "Unchanged" : `${n} changed`,
        tone: n === 0 ? "ok" : "warn",
      };
    }
    case "sensitive-paths":
      return {
        label: "Sensitive paths",
        value: item.hits.length === 0 ? "None touched" : `${item.hits.length} touched`,
        tone: item.hits.length === 0 ? "ok" : "danger",
      };
    case "preview":
      return {
        label: "Preview",
        value: item.url ? "Deployed" : "No URL",
        tone: item.url ? "ok" : "warn",
      };
    case "screenshots":
      return {
        label: "Screenshots",
        value: item.shots.length === 1 ? "1 route" : `${item.shots.length} routes`,
        tone: "neutral",
      };
    case "agent-trace":
      return { label: "Agent trace", value: item.provider, tone: "neutral" };
    case "transform":
      return {
        label: "Transform",
        value: item.verified ? "Reproduced" : `${item.mismatchedFiles.length} mismatched`,
        tone: item.verified ? "ok" : "danger",
      };
    case "llm-judgment":
      return {
        label: QUESTION_LABEL[item.question],
        value:
          item.outcome === "no-concern"
            ? "No concern"
            : item.outcome === "concern"
              ? "Concern"
              : "Unsure",
        tone: item.outcome === "no-concern" ? "ok" : item.outcome === "concern" ? "danger" : "warn",
      };
    case "conflict-resolution":
      return {
        label: "Conflict resolution",
        value:
          item.semanticConflictWith !== null
            ? "Semantic conflict"
            : item.touchesOutsideConflictHunks
              ? "Edits outside conflicts"
              : "Within conflicts",
        tone:
          item.touchesOutsideConflictHunks || item.semanticConflictWith !== null
            ? "warn"
            : "neutral",
      };
    case "quarantine":
      return {
        label: "Quarantined tests",
        value:
          item.inAffectedSet.length > 0
            ? `${item.inAffectedSet.length} in affected set`
            : `${item.tests.length} quarantined`,
        tone: item.inAffectedSet.length > 0 ? "warn" : "neutral",
      };
    case "qa-run": {
      const fail = item.criteria.filter((c) => c.verdict === "fail").length;
      const unsure = item.criteria.filter((c) => c.verdict === "couldnt-test").length;
      const pass = item.criteria.length - fail - unsure;
      return {
        label: "QA",
        value:
          fail > 0 ? `${fail} failed` : unsure > 0 ? `${unsure} couldn't test` : `${pass} passed`,
        tone: fail > 0 ? "danger" : unsure > 0 ? "warn" : "ok",
      };
    }
  }
}

export function itemTitle(item: EvidenceItem): string {
  if (item.kind === "llm-judgment")
    return `${KIND_LABEL[item.kind]}: ${QUESTION_LABEL[item.question].toLowerCase()}`;
  if (item.kind === "test-run") return `${KIND_LABEL[item.kind]}: ${item.step}`;
  return KIND_LABEL[item.kind];
}

export function findItem(items: EvidenceItem[], id: string): EvidenceItem | undefined {
  return items.find((i) => i.id === id);
}

/** Anchor id for an evidence item; ids may contain ":" and "/". */
export function itemAnchor(id: string): string {
  return `ev-${id.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/**
 * What a skipped or failed measurement did to the lane, read from the classifier's own reasons
 * (anchored to the item by evidenceRef). Before the change is classified it can only say "can".
 */
export function unmeasuredEffect(itemId: string, reasons: readonly LaneReason[]): string {
  if (reasons.length === 0) return "Unknown counts as risk, so it can raise the lane.";
  const own = reasons.filter((r) => r.evidenceRef === itemId);
  const top = own.reduce((max, r) => Math.max(max, r.lane), 0);
  if (top > 0) return `Unknown counts as risk: this forces at least Lane ${top}.`;
  if (own.some((r) => r.code.startsWith("signal.skip-accepted.")))
    return "The repository's policy accepts this skip, so it does not raise the lane.";
  return "It did not raise this change's lane.";
}

/**
 * The command that checks an attestation outside the platform (`@app/evidence`'s standalone
 * `verify-attestation`), as one pasteable line: the commit is the evidence's head, the keys are
 * this platform's published Ed25519 keys.
 */
export function verifyCommand(headSha: string, origin: string): string {
  return `verify-attestation --repo . --commit ${headSha.slice(0, 12)} --keys-url ${origin.replace(/\/+$/, "")}/.well-known/gittifacts-keys.json`;
}

type TestRunItem = Extract<EvidenceItem, { kind: "test-run" }>;

/**
 * A test run's listed failures, new ones apart from pre-existing ones (fail identically on the
 * base commit). Without a usable baseline nothing is pre-existing.
 */
export function splitFailures(item: TestRunItem): {
  fresh: TestRunItem["failures"];
  pre: TestRunItem["failures"];
} {
  const names = new Set(item.baseline?.status === "ok" ? (item.preExisting ?? []) : []);
  return {
    fresh: item.failures.filter((f) => !names.has(f.name)),
    pre: item.failures.filter((f) => names.has(f.name)),
  };
}

/** Tool output without colour codes (notes and failure messages are read by people). */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
  return text.replace(
    /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g,
    "",
  );
}
