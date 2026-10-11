/**
 * Your agents at work, read from the signed audit log: who did what last, and whether it now
 * waits on a person. No new endpoint and no guessing: every row is an audit event you can open,
 * and an agent with nothing in the window simply isn't listed.
 */
import type { AuditPage, AuditSubjectRef, PrincipalRef } from "../api/types.js";
import { actionLabel } from "./audit-actions.js";

/** Waiting on a person, failing, active in the last few minutes, or quiet. */
export type AgentState = "waiting" | "failing" | "working" | "quiet";

export interface AgentActivity {
  agent: PrincipalRef;
  state: AgentState;
  /**
   * The agent's latest event, in words, with a link to what it acted on (null: nothing to open)
   * and what that is called (`object`: the plan or change title and its repo, when the log names it).
   */
  last: {
    action: string;
    label: string;
    subject: string;
    href: string | null;
    at: string;
    object: AuditSubjectRef | null;
  };
  /** Events by this agent in the page that was read. */
  events: number;
}

/** An agent counts as working for this long after its last event. */
export const WORKING_MS = 15 * 60_000;
/** Older than this, it isn't listed at all. */
export const WINDOW_MS = 7 * 24 * 60 * 60_000;

/** After these, the next move is a person's (a review, a plan approval). */
const WAITS_ON_PERSON = new Set([
  "change.review-requested",
  "plan.created",
  "merge-queue.approval-requested",
]);
const FAILING = /ci-failed|tour-failed|build-errored|gave-up/;

/** One agent's (or person's) trail: the audit log filtered to its events. */
export function trailHref(principalId: string): string {
  return `/audit?actor=${encodeURIComponent(principalId)}`;
}

/** `change:abc` → `/changes/abc`; subjects with no screen of their own get no link. */
export function subjectHref(subject: string): string | null {
  const [kind, id] = subject.split(":", 2);
  if (!id) return null;
  const enc = encodeURIComponent(id);
  if (kind === "change") return `/changes/${enc}`;
  if (kind === "plan") return `/plans/${enc}`;
  if (kind === "repo" || kind === "project") return `/repos/${enc}`;
  return null;
}

function stateOf(action: string, at: number, now: number): AgentState {
  if (WAITS_ON_PERSON.has(action)) return "waiting";
  if (FAILING.test(action)) return "failing";
  return now - at <= WORKING_MS ? "working" : "quiet";
}

const ORDER: Record<AgentState, number> = { waiting: 0, failing: 1, working: 2, quiet: 3 };

/** One row per agent with an event in the window: waiting on you first, then failing, working, quiet. */
export function fleetFrom(page: AuditPage, now: number): AgentActivity[] {
  const byAgent = new Map<string, AgentActivity>();
  const events = [...page.events].sort((a, b) => b.seq - a.seq);
  for (const e of events) {
    const who = page.principals?.[e.principalId];
    if (!who || who.kind !== "agent") continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || now - at > WINDOW_MS) continue;
    const seen = byAgent.get(who.id);
    if (seen) {
      seen.events += 1;
      continue;
    }
    byAgent.set(who.id, {
      agent: who,
      state: stateOf(e.action, at, now),
      last: {
        action: e.action,
        label: actionLabel(e.action),
        subject: e.subject,
        href: subjectHref(e.subject),
        at: e.at,
        object: page.subjects?.[e.subject] ?? null,
      },
      events: 1,
    });
  }
  return [...byAgent.values()].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || Date.parse(b.last.at) - Date.parse(a.last.at),
  );
}
