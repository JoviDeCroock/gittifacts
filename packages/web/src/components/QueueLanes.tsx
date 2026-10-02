/**
 * Merge queue swimlanes: one lane per track (its batches in test order), the landing lane, and the
 * deploy trains strip. Lanes scroll sideways inside themselves; the page never does.
 */
import type { LandingBatch, QueueOverviewView, QueueTrack, TrackBatch } from "../api/queue.js";
import {
  BATCH_KIND,
  BATCH_STATE,
  entryIndex,
  orderTracks,
  TRAIN_STATE,
  trackLabel,
} from "../lib/queue.js";
import { countdown, countdownWords } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { useTick } from "../state/clock.js";
import { Icon } from "./Icon.js";
import { EmptyState, LaneTag, StatusChip } from "./ui.js";

type Find = ReturnType<typeof entryIndex>;

function Members({ ids, find }: { ids: string[]; find: Find }) {
  if (ids.length === 0) return <p class="q-batch__none">No changes</p>;
  return (
    <ul class="q-batch__members">
      {ids.map((id) => {
        const { title, entry } = find(id);
        return (
          <li key={id}>
            {entry ? <LaneTag lane={entry.lane} size="sm" /> : null}
            <a href={`/changes/${id}`} title={title}>
              {title}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** What a batch is tested on: main, the chain batch before it, or (for a probe) the batch it bisects. */
function basis(batches: TrackBatch[], index: number): string {
  const b = batches[index];
  if (!b) return "";
  const prevChain = batches.slice(0, index).filter((x) => x.kind === "chain");
  const last = prevChain[prevChain.length - 1];
  if (b.kind === "probe") return last ? `bisects ${last.id}` : "bisect";
  if (b.kind === "landing") return "revalidating";
  return last ? `on top of ${last.id}` : "on main";
}

function BatchCard({ batch, note, find }: { batch: TrackBatch; note: string; find: Find }) {
  return (
    <li class={`q-batch q-batch--${batch.kind}`}>
      <div class="q-batch__top">
        <span class="q-batch__id">{batch.id}</span>
        <StatusChip meta={BATCH_STATE[batch.state]} />
      </div>
      <p class="q-batch__kind">
        {BATCH_KIND[batch.kind]} · {note}
      </p>
      <Members ids={batch.entries} find={find} />
    </li>
  );
}

function TrackLane({ track, find }: { track: QueueTrack; find: Find }) {
  const label = trackLabel(track.id, track.express);
  const changes = new Set(track.batches.flatMap((b) => b.entries)).size;
  return (
    <li class={`q-lane ${track.express ? "q-lane--express" : ""}`}>
      <div class="q-lane__head">
        <h3 class="q-lane__title">{label}</h3>
        {track.express ? (
          <p class="q-express">
            <Icon name="arrow-up-right" size={14} />
            Reverts and incident fixes first
          </p>
        ) : null}
        <p class="q-lane__meta tnum">
          {plural(track.batches.length, "batch", "batches")} · {plural(changes, "change")}
        </p>
      </div>
      {track.batches.length === 0 ? (
        <p class="q-lane__empty">Idle: nothing to test on this track.</p>
      ) : (
        <ol class="q-rail scroll-x" aria-label={`${label} batches, in test order`}>
          {track.batches.map((b, i) => (
            <BatchCard key={b.id} batch={b} note={basis(track.batches, i)} find={find} />
          ))}
        </ol>
      )}
    </li>
  );
}

function landingNote(l: LandingBatch): string {
  if (l.targets === "all") return "full run on the newest main";
  return `rechecks ${plural(l.targets.length, "impacted target")}`;
}

function LandingLane({ landing, find }: { landing: LandingBatch[]; find: Find }) {
  return (
    <li class="q-lane q-lane--landing">
      <div class="q-lane__head">
        <h3 class="q-lane__title">Landing</h3>
        <p class="q-lane__meta">
          Revalidates on the newest main, then lands with one compare-and-swap.
        </p>
      </div>
      <ol class="q-rail scroll-x" aria-label="Landing pipeline, oldest first">
        {landing.map((l) => (
          <li key={l.id} class="q-batch q-batch--landing">
            <div class="q-batch__top">
              <span class="q-batch__id">{l.id}</span>
              <StatusChip meta={BATCH_STATE[l.state]} />
            </div>
            <p class="q-batch__kind">Landing · {landingNote(l)}</p>
            <Members ids={l.members} find={find} />
            {Array.isArray(l.targets) && l.targets.length > 0 ? (
              <ul class="q-batch__targets" aria-label="Impacted test targets">
                {l.targets.map((t) => (
                  <li key={t}>
                    <code>{t}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </li>
  );
}

export function QueueLanes({ q }: { q: QueueOverviewView }) {
  const find = entryIndex(q.entries);
  const tracks = orderTracks(q.tracks);
  return (
    <section class="q-section" aria-labelledby="q-tracks">
      <div class="q-section__head">
        <h2 id="q-tracks" class="q-section__title">
          Tracks <span class="q-count tnum">{tracks.length}</span>
        </h2>
        <p class="q-section__lede">
          Changes that touch different code speculate in parallel, one track each. Within a track,
          each batch is tested on top of the one before it.
        </p>
      </div>
      {tracks.length === 0 && q.landing.length === 0 ? (
        <EmptyState icon="list-ordered" title="Nothing is being tested">
          <p>
            Approved changes enter the queue through the API or MCP (<code>enqueue</code>). Each
            conflict-free group gets its own track and speculates against main.
          </p>
        </EmptyState>
      ) : (
        <ol class="q-lanes">
          {tracks.map((t) => (
            <TrackLane key={t.id} track={t} find={find} />
          ))}
          {q.landing.length > 0 ? <LandingLane landing={q.landing} find={find} /> : null}
        </ol>
      )}
    </section>
  );
}

function WatchCountdown({ until }: { until: number }) {
  const now = useTick(1000).value;
  const iso = new Date(until).toISOString();
  return (
    <span>
      watch ends in{" "}
      <span class="tnum" aria-hidden="true">
        {countdown(iso, now)}
      </span>
      <span class="sr-only">{countdownWords(iso, now)}</span>
    </span>
  );
}

export function DeployTrains({ q }: { q: QueueOverviewView }) {
  const find = entryIndex(q.entries);
  return (
    <section class="q-section" aria-labelledby="q-trains">
      <div class="q-section__head">
        <h2 id="q-trains" class="q-section__title">
          Deploy trains <span class="q-count tnum">{q.trains.length}</span>
        </h2>
        <p class="q-section__lede">
          Merged changes deploy in trains. A Worker takes its next train only after the current
          one's watch window closes.
        </p>
      </div>
      {q.trains.length === 0 ? (
        <p class="q-quiet">No trains are deploying.</p>
      ) : (
        <ul class="q-trains">
          {q.trains.map((t) => (
            <li key={t.id} class="q-train">
              <div class="q-train__top">
                <code class="q-train__worker">{t.worker}</code>
                <StatusChip meta={TRAIN_STATE[t.state]} />
              </div>
              <p class="q-train__meta">
                <span>{t.id}</span>
                {t.versionId ? <code>{t.versionId}</code> : null}
                {t.watchUntil !== null && t.state === "watching" ? (
                  <WatchCountdown until={t.watchUntil} />
                ) : null}
              </p>
              <ul class="q-train__changes">
                {t.changeIds.map((id) => (
                  <li key={id}>
                    <a href={`/changes/${id}`}>{find(id).title}</a>
                    {t.killed.includes(id) ? (
                      <span class="chip chip--danger">
                        <Icon name="flag" size={14} />
                        Flag killed
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
