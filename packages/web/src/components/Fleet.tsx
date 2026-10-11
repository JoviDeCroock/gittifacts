/**
 * The dashboard's agent band: each agent that acted this week in repositories you can see, what it
 * did last and to what, and whether it now waits on a person. Agents are squares with their mark
 * (people are circles). A working agent shows a trace running along its row's hairline, the one
 * live signal in the app (never a pulsing dot); it only runs while the row is on screen and never
 * under reduced motion.
 *
 * Loading keeps its place (the head and as many row shapes as the band had last time, so nothing
 * below it jumps); errors and an empty week stay silent: the band adds to the dashboard and never
 * blocks it.
 */
import { useEffect, useRef } from "preact/hooks";
import type { AuditPage } from "../api/types.js";
import { type AgentActivity, type AgentState, fleetFrom } from "../lib/fleet.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import type { Resource } from "../state/resource.js";
import "../styles/fleet.css";
import { AgentMark } from "./AgentMark.js";
import { Icon, type IconId } from "./Icon.js";
import { SkeletonHead, SkeletonRows } from "./ui.js";

const STATE: Record<AgentState, { word: string; icon: IconId }> = {
  waiting: { word: "Needs a person", icon: "user" },
  failing: { word: "Failing", icon: "x-circle" },
  working: { word: "Working", icon: "circle-dot" },
  quiet: { word: "Quiet", icon: "minus" },
};

const WAIT_WORD: Record<string, string> = {
  "plan.created": "Plan needs approval",
  "change.review-requested": "Needs review",
  "merge-queue.approval-requested": "Needs fresh approval",
};

/** The state in words, the same on the band and on the Agents page. */
export function stateWord(a: Pick<AgentActivity, "state" | "last">): { word: string; icon: IconId } {
  const s = STATE[a.state];
  // Name the wait: a plan to approve or a change to review (whoever may take it, never its author).
  return { word: a.state === "waiting" ? (WAIT_WORD[a.last.action] ?? s.word) : s.word, icon: s.icon };
}

/** "agent of Dev Patel", "your agent", or just "agent" when the owner isn't named. */
export function ownerLine(agent: AgentActivity["agent"], me: string | null): string {
  if (me && agent.ownerId === me) return "your agent";
  return agent.ownerName ? `agent of ${agent.ownerName}` : "agent";
}

/** The last act with its object: "Plan drafted · Dunning emails for failed card payments · billing-api". */
export function LastAct({ a, now }: { a: AgentActivity; now: number }) {
  const o = a.last.object;
  return (
    <span class="fleet__last">
      <span class="fleet__did">
        <span class="fleet__action">{a.last.label}</span>
        {o ? <span class="fleet__object"> {o.title}</span> : null}
      </span>
      <span class="fleet__where">
        {o?.repoName && o.repoName !== o.title ? <span class="fleet__repo">in {o.repoName} · </span> : null}
        <time class="fleet__when tnum" dateTime={a.last.at}>
          {relative(a.last.at, now)}
        </time>
      </span>
    </span>
  );
}

export function StateWord({ a }: { a: AgentActivity }) {
  const s = stateWord(a);
  return (
    <span class={`fleet__state fleet__state--${a.state}`}>
      <Icon name={s.icon} size={14} />
      {s.word}
    </span>
  );
}

function AgentRow({ a, now, me }: { a: AgentActivity; now: number; me: string | null }) {
  const ref = useRef<HTMLLIElement>(null);
  // The trace runs only while the row is visible (an offscreen loop is wasted work).
  useEffect(() => {
    const el = ref.current;
    if (!el || a.state !== "working" || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => el.toggleAttribute("data-onscreen", !!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [a.state]);
  const body = (
    <>
      <AgentMark name={a.agent.name} id={a.agent.id} size={36} />
      <span class="fleet__who">
        <span class="fleet__name">{a.agent.name}</span>
        <span class="fleet__owner">{ownerLine(a.agent, me)}</span>
      </span>
      <LastAct a={a} now={now} />
      <StateWord a={a} />
    </>
  );
  return (
    <li ref={ref} class={`fleet__row fleet__row--${a.state}`} data-testid="fleet-agent" data-state={a.state} data-agent={a.agent.id}>
      {a.last.href ? (
        <a class="fleet__link" href={a.last.href}>
          {body}
        </a>
      ) : (
        <div class="fleet__link">{body}</div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- what the band looked like last time

const MEMORY = "gf:fleet-shape";

/** How many rows the band showed last time (0 to 3) and whether one waited on a person. */
export function rememberedFleet(): { rows: number; waiting: boolean } {
  try {
    const v = JSON.parse(window.localStorage.getItem(MEMORY) ?? "null") as { rows?: unknown; waiting?: unknown } | null;
    const rows = typeof v?.rows === "number" ? Math.max(0, Math.min(3, Math.round(v.rows))) : 2;
    return { rows, waiting: v?.waiting === true };
  } catch {
    return { rows: 2, waiting: false };
  }
}

function remember(rows: AgentActivity[]): void {
  try {
    window.localStorage.setItem(MEMORY, JSON.stringify({ rows: Math.min(3, rows.length), waiting: rows.some((r) => r.state === "waiting") }));
  } catch {
    /* private mode: the next load guesses two rows */
  }
}

/** The band's rows from the audit page (empty while loading or on error). */
export function fleetRows(state: Resource<AuditPage>, now: number): AgentActivity[] {
  return state.status === "ok" ? fleetFrom(state.data, now) : [];
}

export function Fleet({ state, me }: { state: Resource<AuditPage>; me: string | null }) {
  const now = minuteClock.value;
  const rows = fleetRows(state, now);
  useEffect(() => {
    if (state.status === "ok") remember(rows);
  }, [state, rows.length]);
  if (state.status === "loading") {
    const shape = rememberedFleet();
    if (shape.rows === 0) return null;
    return (
      <section class="fleet fleet--loading" aria-label="Agents at work" aria-busy="true" data-testid="fleet-loading">
        <SkeletonHead />
        <SkeletonRows count={shape.rows} />
      </section>
    );
  }
  // Errors and a quiet week stay silent: the band adds to the dashboard and must never block it.
  if (rows.length === 0) return null;
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const working = rows.filter((r) => r.state === "working").length;
  // The Agents page manages only yours; when the band shows anyone else's, the link says so.
  const allMine = me !== null && rows.every((r) => r.agent.ownerId === me);
  return (
    <section class="fleet" aria-labelledby="fleet-title" data-testid="fleet">
      <div class="fleet__head">
        <h2 id="fleet-title" class="fleet__title">
          Agents at work
        </h2>
        <p class="fleet__sum">
          {waiting > 0 ? <b class="tnum">{waiting} waiting on a person</b> : "None waiting on a person"}
          {working > 0 ? ` · ${working} working now` : ""}
        </p>
        <a class="fleet__manage" href="/agents" data-testid="fleet-manage">
          {allMine ? "Manage agents" : "All agents"}
        </a>
      </div>
      <ul class="fleet__list">
        {rows.map((a) => (
          <AgentRow key={a.agent.id} a={a} now={now} me={me} />
        ))}
      </ul>
    </section>
  );
}
