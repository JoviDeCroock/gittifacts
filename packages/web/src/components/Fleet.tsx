/**
 * The dashboard's agent band: each agent that acted this week, what it did last, and whether it
 * now waits on a person. Agents are squares (people are circles). A working agent shows a trace
 * running along its row's hairline, the one live signal in the app (never a pulsing dot); it only
 * runs while the row is on screen and never under reduced motion.
 */
import { useComputed } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { api } from "../api/client.js";
import { type AgentActivity, type AgentState, fleetFrom } from "../lib/fleet.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/fleet.css";
import { Icon, type IconId } from "./Icon.js";

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

function initials(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function AgentRow({ a, now }: { a: AgentActivity; now: number }) {
  const ref = useRef<HTMLLIElement>(null);
  // The trace runs only while the row is visible (an offscreen loop is wasted work).
  useEffect(() => {
    const el = ref.current;
    if (!el || a.state !== "working" || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => el.toggleAttribute("data-onscreen", !!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [a.state]);
  const s = STATE[a.state];
  // Name the wait: a plan to approve or a change to review (whoever may take it, never its author).
  const word = a.state === "waiting" ? (WAIT_WORD[a.last.action] ?? s.word) : s.word;
  const body = (
    <>
      <span class="fleet__avatar" aria-hidden="true">
        {initials(a.agent.name)}
      </span>
      <span class="fleet__who">
        <span class="fleet__name">{a.agent.name}</span>
        <span class="fleet__owner">{a.agent.ownerName ? `agent of ${a.agent.ownerName}` : "agent"}</span>
      </span>
      <span class="fleet__last">
        <span class="fleet__action">{a.last.label}</span>
        <time class="fleet__when tnum" dateTime={a.last.at}>
          {relative(a.last.at, now)}
        </time>
      </span>
      <span class={`fleet__state fleet__state--${a.state}`}>
        <Icon name={s.icon} size={14} />
        {word}
      </span>
    </>
  );
  return (
    <li ref={ref} class={`fleet__row fleet__row--${a.state}`} data-testid="fleet-agent" data-state={a.state}>
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

export function Fleet() {
  const res = useResource(() => api.audit({ limit: 100 }), []);
  const st = res.state.value;
  const now = minuteClock.value;
  const fleet = useComputed(() => (res.state.value.status === "ok" ? fleetFrom(res.state.value.data, minuteClock.value) : []));
  // Loading and errors stay silent: this band adds to the dashboard and must never block it.
  if (st.status !== "ok" || fleet.value.length === 0) return null;
  const rows = fleet.value;
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const working = rows.filter((r) => r.state === "working").length;
  return (
    <section class="fleet" aria-labelledby="fleet-title" data-testid="fleet">
      <div class="fleet__head">
        <h2 id="fleet-title" class="fleet__title">
          Your agents
        </h2>
        <p class="fleet__sum">
          {waiting > 0 ? <b class="tnum">{waiting} waiting on a person</b> : "None waiting on a person"}
          {working > 0 ? ` · ${working} working now` : ""}
        </p>
        <a class="fleet__manage" href="/agents">
          Manage agents
        </a>
      </div>
      <ul class="fleet__list">
        {rows.map((a) => (
          <AgentRow key={a.agent.id} a={a} now={now} />
        ))}
      </ul>
    </section>
  );
}
