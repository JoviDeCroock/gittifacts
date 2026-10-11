/**
 * Mission control: one row per agent working on a repo, live. Each row shows the agent and the
 * person accountable for it, the change it is closest to landing, where that change is (the five
 * stations Push · Grade · Review · Queue · Merge), its lane, its place in the merge queue and how
 * long it has been in this stage. Read-only, like the queue view: agents act through MCP.
 * Polls the existing endpoints (api/mission.ts); a failed refresh keeps the last board on screen.
 */
import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { ApiError, api } from "../api/client.js";
import {
  fetchMission,
  MISSION_MOCK_POLL_MS,
  MISSION_POLL_MS,
  type MissionData,
} from "../api/mission.js";
import { isMockMode } from "../api/mode.js";
import type { QueueOverviewView } from "../api/queue.js";
import { Icon, type IconId } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import {
  EmptyState,
  ErrorState,
  LaneTag,
  LinkButton,
  Loading,
  StatusChip,
} from "../components/ui.js";
import {
  type MissionCounts,
  type MissionRow,
  missionFrom,
  STAGE,
  STATIONS,
  type Stage,
  stageClock,
} from "../lib/mission.js";
import { BATCH_STATE, orderTracks, trackLabel, updatedLabel } from "../lib/queue.js";
import { useTick } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { sessionExpired } from "../state/session.js";
import "../styles/fleet.css"; // the agent trace's keyframes (fleet-trace)
import "../styles/mission.css";

interface BoardState {
  data: MissionData | null;
  error: unknown;
  fetchedAt: number | null;
}

/** Loads the board, then refreshes it (paused while the tab is hidden against the real API). */
function useMission(repoId: string): { state: Signal<BoardState>; retry: () => void } {
  const state = useSignal<BoardState>({ data: null, error: null, fetchedAt: null });
  const nonce = useSignal(0);
  const attempt = nonce.value;
  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: number | undefined;
    const mock = isMockMode();
    const every = mock ? MISSION_MOCK_POLL_MS : MISSION_POLL_MS;
    if (state.peek().data?.repoId !== repoId)
      state.value = { data: null, error: null, fetchedAt: null };
    const schedule = () => {
      window.clearTimeout(timer);
      if (live) timer = window.setTimeout(load, every);
    };
    async function load() {
      if (busy || (!mock && document.hidden)) return schedule();
      busy = true;
      try {
        const data = await fetchMission(repoId);
        if (live) state.value = { data, error: null, fetchedAt: Date.now() };
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) sessionExpired();
        if (live) state.value = { ...state.peek(), error };
      } finally {
        busy = false;
        schedule();
      }
    }
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [repoId, attempt, state]);
  return { state, retry: () => nonce.value++ };
}

function Counts({ c }: { c: MissionCounts }) {
  const items: { label: string; value: number; of?: number }[] = [
    { label: "Agents working", value: c.working, of: c.agents },
    { label: "In review", value: c.inReview },
    { label: "In the queue", value: c.queued },
    { label: "Merged today", value: c.mergedToday },
  ];
  return (
    <dl class="mission__counts" data-testid="mission-counts">
      {items.map((i) => (
        <div class="mission__count" key={i.label}>
          <dt>{i.label}</dt>
          <dd class="tnum">
            {i.value}
            {i.of !== undefined ? <span class="mission__of"> of {i.of}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The queue's tracks in one line each: its batches, their state and size. */
function Tracks({ q, repoId }: { q: QueueOverviewView; repoId: string }) {
  const tracks = orderTracks(q.tracks).filter((t) => t.batches.length > 0);
  if (tracks.length === 0) return null;
  return (
    <section class="mission__tracks" aria-labelledby="mission-tracks" data-testid="mission-tracks">
      <h2 id="mission-tracks" class="mission__h2">
        Merge queue tracks
      </h2>
      <ul class="mission__tracklist">
        {tracks.map((t) => (
          <li key={t.id} class="mission__track-row">
            <a class="mission__trackname" href={`/repos/${encodeURIComponent(repoId)}/queue`}>
              {trackLabel(t.id, t.express)}
            </a>
            <span class="mission__batches">
              {t.batches.map((b) => (
                <StatusChip
                  key={b.id}
                  meta={{
                    ...BATCH_STATE[b.state],
                    label: `${b.id} · ${BATCH_STATE[b.state].label} · ${b.entries.length}`,
                  }}
                />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STAGE_ICON: Record<Stage, IconId> = {
  started: "git-branch",
  "sent-back": "comment",
  grading: "loader",
  failing: "x-circle",
  lane: "route",
  review: "user",
  approved: "check-circle",
  queued: "list-ordered",
  ejected: "x-circle",
  merging: "git-merge",
  merged: "git-merge",
  closed: "archive",
};

function initials(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/** Push · Grade · Review · Queue · Merge: done, the one it is at, and what is left. */
function Stations({ stage }: { stage: Stage }) {
  const at = STAGE[stage].step;
  return (
    <ol class="mission__stations" aria-hidden="true">
      {STATIONS.map((s, i) => (
        <li
          key={s}
          class="mission__station"
          data-at={i < at ? "done" : i === at ? "now" : "todo"}
          title={s}
        />
      ))}
    </ol>
  );
}

function Row({ r, now }: { r: MissionRow; now: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const meta = STAGE[r.stage];
  // The trace runs only while a working row is on screen (an offscreen loop is wasted work).
  useEffect(() => {
    const el = ref.current;
    if (!el || !meta.working || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) =>
      el.toggleAttribute("data-onscreen", !!e?.isIntersecting),
    );
    io.observe(el);
    return () => io.disconnect();
  }, [meta.working]);
  const station = meta.step < STATIONS.length ? STATIONS[meta.step] : "Done";
  return (
    <li
      ref={ref}
      class={`mission__row${meta.working ? " mission__row--working" : ""}`}
      data-testid="mission-row"
      data-stage={r.stage}
      data-agent={r.agent.name}
    >
      <span class="mission__avatar" aria-hidden="true">
        {initials(r.agent.name)}
      </span>
      <span class="mission__who">
        <span class="mission__name">{r.agent.name}</span>
        <span class="mission__owner">
          {r.agent.ownerName ? `agent of ${r.agent.ownerName}` : "agent"}
        </span>
      </span>
      <span class="mission__change">
        <a class="mission__title" href={`/changes/${encodeURIComponent(r.change.id)}`}>
          {r.change.title}
        </a>
        <span class="mission__sub">
          {r.change.id} · {r.change.category}
          {r.more > 0 ? ` · ${r.more} more in flight` : ""}
        </span>
      </span>
      <span class="mission__stage">
        <Stations stage={r.stage} />
        {/* Keyed by stage: a new stage settles in once (DESIGN.md, Motion: explains state). */}
        <span key={r.stage} class={`mission__word mission__word--${meta.tone}`}>
          <Icon name={STAGE_ICON[r.stage]} size={14} />
          {meta.label}
          <span class="sr-only">, at {station}</span>
        </span>
        <span class="mission__detail">{r.detail}</span>
      </span>
      <span class="mission__lane">
        <LaneTag lane={r.lane} shadow={r.calibrating} size="sm" label="name" />
      </span>
      <span class="mission__queue tnum">
        {r.queue?.position != null ? (
          <b>#{r.queue.position}</b>
        ) : (
          <span class="mission__none">–</span>
        )}
        {r.queue?.batchId ? <span class="mission__batch">{r.queue.batchId}</span> : null}
      </span>
      <time
        class="mission__clock tnum"
        dateTime={new Date(r.since).toISOString()}
        title={`In this stage since ${new Date(r.since).toLocaleTimeString()}`}
      >
        {stageClock(r.since, now)}
      </time>
    </li>
  );
}

function Board({
  data,
  repoId,
  fetchedAt,
}: {
  data: MissionData;
  repoId: string;
  fetchedAt: number;
}) {
  const now = useTick(1000).value;
  const { rows, counts } = missionFrom({
    changes: data.changes,
    queue: data.queue,
    owners: data.owners,
    now,
  });
  return (
    <div class="mission" data-testid="mission">
      <div class="mission__top">
        <Counts c={counts} />
        <p class="mission__updated">
          <span class="tnum">{updatedLabel(fetchedAt, now)}</span>
          {isMockMode() ? " · demo data" : " · refreshes every 10 s"}
          {data.queue ? null : " · merge queue unavailable, so no positions"}
        </p>
      </div>
      <section aria-labelledby="mission-agents">
        <h2 id="mission-agents" class="mission__h2">
          Agents
        </h2>
        {rows.length === 0 ? (
          <EmptyState icon="bot" title="No agent is working on this repo">
            <p>
              Agents show up here once they start a change. Tell yours:{" "}
              <code>use {window.location.origin}/start</code>
            </p>
          </EmptyState>
        ) : (
          <>
            <div class="mission__cols" aria-hidden="true">
              <span>Agent</span>
              <span>Change</span>
              <span>Stage</span>
              <span>Lane</span>
              <span>Queue</span>
              <span>In stage</span>
            </div>
            <ul class="mission__list">
              {rows.map((r) => (
                <Row key={r.agent.id} r={r} now={now} />
              ))}
            </ul>
          </>
        )}
      </section>
      {data.queue ? <Tracks q={data.queue} repoId={repoId} /> : null}
    </div>
  );
}

export function MissionView({ repoId }: { repoId: string }) {
  const { state, retry } = useMission(repoId);
  const repo = useResource(() => api.repo(repoId), [repoId]);
  const rs = repo.state.value;
  const name = rs.status === "ok" ? rs.data.repo.name : "Repository";
  const st = state.value;
  return (
    <Page
      title="Mission control"
      wide
      crumbs={[
        { href: "/dashboard", label: "Dashboard" },
        { href: `/repos/${encodeURIComponent(repoId)}`, label: name },
      ]}
      actions={
        <LinkButton
          href={`/repos/${encodeURIComponent(repoId)}/queue`}
          size="sm"
          icon="list-ordered"
        >
          Merge queue
        </LinkButton>
      }
      meta={<span>Every agent on {name}, where its change is, live.</span>}
    >
      {st.data && st.fetchedAt ? (
        <Board data={st.data} repoId={repoId} fetchedAt={st.fetchedAt} />
      ) : st.error ? (
        <ErrorState error={st.error} what="mission control" onRetry={retry} />
      ) : (
        <Loading label="Loading the agents" lines={6} />
      )}
      {st.data && st.error ? (
        <p class="mission__stale" role="status">
          <Icon name="info" size={14} /> The last refresh failed; showing the board from before. It
          retries on its own.
        </p>
      ) : null}
    </Page>
  );
}
