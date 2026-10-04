/**
 * A rollout's incident, from its audit timeline and linked issues: when the first error came,
 * which signal detected the regression, and how fast each automatic step followed (flag off,
 * rollback, revert). These steps happen seconds apart, so everything here is to the
 * millisecond; the page shows tenths of a second. Pure: events and issues in, facts out.
 */
import type { LinkedIssue, TimelineEvent } from "../api/types.js";
import { actionLabel, isBadAction } from "./audit-actions.js";

export type DetectionSignal = "workers-logs" | "workers-issues" | "health-check" | "person";

export const SIGNAL_LABEL: Record<DetectionSignal, string> = {
  "workers-logs": "the Workers Logs poll",
  "workers-issues": "Workers Issues",
  "health-check": "the rollout's health check",
  person: "a person (switch off)",
};

export interface IncidentStep {
  key: "flag" | "rollback" | "revert";
  label: string;
  at: string;
  /** Milliseconds after the detection. */
  afterMs: number;
  seq: number;
}

export interface Incident {
  detectedAt: string;
  detectedSeq: number;
  /** null: the event does not say which signal saw it. */
  signal: DetectionSignal | null;
  /** The earliest linked issue's first occurrence, when it came before the detection. */
  firstError: { at: string; title: string } | null;
  /** Milliseconds from the first error to the detection. */
  detectedAfterMs: number | null;
  steps: IncidentStep[];
}

/** Events that mean "a regression was found" (or a person pulled the switch). */
const DETECTIONS: Record<string, DetectionSignal | "from-summary"> = {
  "deploy.regression-attributed": "from-summary",
  "rollout.regression": "health-check",
  "rollout.check.failed": "health-check",
  "rollout.killed": "person",
  "change.killed": "person",
};

const STEPS: { key: IncidentStep["key"]; label: string; actions: string[] }[] = [
  { key: "flag", label: "Flag turned off", actions: ["deploy.flag-off", "rollout.flag-off", "flag.disabled"] },
  { key: "rollback", label: "Traffic back on the previous version", actions: ["rollout.rolled-back"] },
  { key: "revert", label: "Revert change opened", actions: ["change.revert-opened", "revert.opened", "rollout.reverted"] },
];

/** How long after the detection an event still belongs to the incident. */
const INCIDENT_WINDOW_MS = 15 * 60_000;

const ms = (iso: string) => Date.parse(iso);

function byTime(a: TimelineEvent, b: TimelineEvent): number {
  return ms(a.at) - ms(b.at) || a.seq - b.seq;
}

/**
 * Which signal a train's attribution names. The server's summary says it ("seen by the Workers
 * Logs poll (telemetry-t2-1)" / "seen by Workers Issues (issue …)"); anything else is unknown.
 */
export function signalOf(e: TimelineEvent): DetectionSignal | null {
  const rule = DETECTIONS[e.action];
  if (rule === undefined) return null;
  if (rule !== "from-summary") return rule;
  const s = e.summary ?? "";
  if (/Workers Logs poll/i.test(s)) return "workers-logs";
  if (/Workers Issues/i.test(s)) return "workers-issues";
  return null;
}

export function findIncident(events: readonly TimelineEvent[], issues: readonly LinkedIssue[]): Incident | null {
  const ordered = [...events].sort(byTime);
  const detection = ordered.find((e) => DETECTIONS[e.action] !== undefined);
  if (detection === undefined) return null;
  const t0 = ms(detection.at);
  const steps: IncidentStep[] = [];
  for (const step of STEPS) {
    const e = ordered.find((x) => step.actions.includes(x.action) && ms(x.at) >= t0 && ms(x.at) - t0 <= INCIDENT_WINDOW_MS);
    if (e) steps.push({ key: step.key, label: step.label, at: e.at, afterMs: ms(e.at) - t0, seq: e.seq });
  }
  // The first occurrence Workers Issues saw, if it came before the detection (and not long before:
  // an older issue group is not this regression's first error).
  const first = [...issues]
    .filter((i) => ms(i.firstSeen) <= t0 && t0 - ms(i.firstSeen) <= INCIDENT_WINDOW_MS)
    .sort((a, b) => ms(a.firstSeen) - ms(b.firstSeen))[0];
  return {
    detectedAt: detection.at,
    detectedSeq: detection.seq,
    signal: signalOf(detection),
    firstError: first ? { at: first.firstSeen, title: first.title } : null,
    detectedAfterMs: first ? t0 - ms(first.firstSeen) : null,
    steps: steps.sort((a, b) => a.afterMs - b.afterMs),
  };
}

export interface TimelineRow {
  key: string;
  at: string;
  label: string;
  /** The raw audit action (a tooltip); null for the first-error row. */
  action: string | null;
  /** The server's one-liner, when it says more than the label (which signal, which issue). */
  detail: string | null;
  /** Audit seq and subject (link to the audit log); null for the first-error row, from Issues. */
  seq: number | null;
  subject: string | null;
  bad: boolean;
  /** Milliseconds after the detection (incident rows only); the detection row has 0. */
  afterMs: number | null;
  source: "change" | "revert" | "issue";
}

/** Actions whose summary names something the label can't (the signal, an error, a reason). */
const DETAIL_ACTIONS = new Set(["deploy.regression-attributed", "rollout.regression", "deploy.revert-failed", "rollout.skipped", "deploy.revert-skipped"]);

/** What of the revert's own timeline continues this one: it merging and shipping. */
const REVERT_ACTIONS: Record<string, string> = {
  "change.merged": "Revert merged into main",
  "merge.completed": "Revert merged into main",
  "rollout.via-train": "Revert rolling out in a deploy batch",
  "rollout.stage": "Revert rollout stage started",
  "rollout.released": "Revert released",
};

/** The page's timeline, newest first: the change's events, the first error, the revert's landing. */
export function timelineRows(events: readonly TimelineEvent[], revertEvents: readonly TimelineEvent[], incident: Incident | null): TimelineRow[] {
  const t0 = incident ? ms(incident.detectedAt) : null;
  const after = (at: string) => (t0 !== null && ms(at) >= t0 && ms(at) - t0 <= INCIDENT_WINDOW_MS ? ms(at) - t0 : null);
  const rows: TimelineRow[] = events.map((e) => ({
    key: `c${e.seq}`,
    at: e.at,
    label: actionLabel(e.action),
    action: e.action,
    detail: DETAIL_ACTIONS.has(e.action) && e.summary ? e.summary : null,
    seq: e.seq,
    subject: e.subject,
    bad: isBadAction(e.action),
    afterMs: after(e.at),
    source: "change",
  }));
  for (const e of revertEvents) {
    const label = REVERT_ACTIONS[e.action];
    if (label === undefined || (t0 !== null && ms(e.at) < t0)) continue;
    rows.push({ key: `r${e.seq}`, at: e.at, label, action: e.action, detail: null, seq: e.seq, subject: e.subject, bad: false, afterMs: after(e.at), source: "revert" });
  }
  if (incident?.firstError) {
    rows.push({ key: "first-error", at: incident.firstError.at, label: "First error in production", action: null, detail: incident.firstError.title, seq: null, subject: null, bad: true, afterMs: null, source: "issue" });
  }
  return rows.sort((a, b) => ms(b.at) - ms(a.at) || (b.seq ?? -1) - (a.seq ?? -1));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "The Workers Logs poll detected the regression 23.9 s after the first error." */
export function detectionSentence(incident: Incident, span: (ms: number) => string): string {
  if (incident.signal === "person") return "A person switched the change off.";
  const who = incident.signal ? capitalize(SIGNAL_LABEL[incident.signal]) : "Health monitoring";
  const when = incident.detectedAfterMs !== null ? ` ${span(incident.detectedAfterMs)} after the first error` : "";
  return `${who} detected the regression${when}.`;
}

/**
 * The health panel's copy for a stopped rollout with no stored error-rate sample: the rollout WAS
 * judged (the incident says by what), only the rates of that check were not kept.
 */
export function healthGapCopy(incident: Incident, clock: (iso: string) => string): string {
  const at = clock(incident.detectedAt);
  if (incident.signal === "person") return `A person stopped this rollout at ${at}, before an error-rate check was kept.`;
  const by = incident.signal ? `: ${SIGNAL_LABEL[incident.signal]} reported the regression at ${at}` : ` at ${at}`;
  return `Health monitoring stopped this rollout${by}. No error-rate sample was kept with it, so there are no rates to compare. The timeline has each step.`;
}
