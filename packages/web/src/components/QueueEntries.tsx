/**
 * Per-entry rows of the merge queue: where each change is, why, what blocks it, and, for an
 * ejected change, exactly what its agent should do next.
 */
import type { EjectReason, QueueEntryView, QueueOverviewView } from "../api/queue.js";
import {
  BATCH_STATE,
  EJECT_CODE,
  ENTRY_STATE,
  entryIndex,
  etaLabel,
  HOLD,
  isTerminal,
  PRIORITY,
  percentLabel,
  splitEntries,
  trackLabel,
} from "../lib/queue.js";
import { shortAge } from "../lib/time.js";
import { Icon } from "./Icon.js";
import { CopyButton, Hash, LaneTag, StatusChip } from "./ui.js";

type Find = ReturnType<typeof entryIndex>;

function ChangeLinks({ ids, find }: { ids: string[]; find: Find }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ", " : null}
          <a href={`/changes/${id}`} title={find(id).title}>
            {id}
          </a>
        </span>
      ))}
    </>
  );
}

function CodeLine({ text, label }: { text: string; label: string }) {
  return (
    <div class="q-code">
      <span class="q-code__label">{label}</span>
      <div class="q-code__box">
        <code class="q-code__text">{text}</code>
        <CopyButton text={text} />
      </div>
    </div>
  );
}

function EjectPanel({ r, find }: { r: EjectReason; find: Find }) {
  return (
    <div class="q-eject">
      <p class="q-eject__title">
        <Icon name="x-circle" size={18} />
        {EJECT_CODE[r.code]}
      </p>
      <p class="q-eject__msg">{r.message}</p>
      {r.failingTests.length > 0 ? (
        <ul class="q-eject__tests" aria-label="Failing tests">
          {r.failingTests.map((t) => (
            <li key={t}>
              <code>{t}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {r.upstream.length > 0 ? (
        <p class="q-eject__line">
          Caused by <ChangeLinks ids={r.upstream} find={find} />
        </p>
      ) : null}
      <div class="q-eject__fix">
        <p class="q-eject__fixlabel">What to do next</p>
        <p>{r.fix.explanation}</p>
        {r.fix.call ? <CodeLine text={r.fix.call} label="Agent call" /> : null}
        {r.fix.command ? <CodeLine text={r.fix.command} label="Command" /> : null}
      </div>
      {r.evidenceRefs.length > 0 ? (
        <p class="q-eject__line">
          Evidence{" "}
          {r.evidenceRefs.map((ref) => (
            <Hash key={ref} value={ref} head={10} tail={4} />
          ))}
        </p>
      ) : null}
    </div>
  );
}

function Facts({ e, trackName }: { e: QueueEntryView; trackName: string | null }) {
  const done = isTerminal(e.state);
  // A finished entry keeps only facts that still say something: no "none yet", no pass chance.
  if (done && trackName === null && !e.batch) return null;
  return (
    <dl class="q-facts">
      {done && trackName === null ? null : (
        <div>
          <dt>Track</dt>
          <dd>{trackName ?? <span class="q-dim">none yet</span>}</dd>
        </div>
      )}
      {!done || e.batch ? (
        <div>
          <dt>Batch</dt>
          <dd
            title={
              e.batch
                ? `Step ${e.batch.chainPosition} of its track's chain, ${e.batch.size} ${e.batch.size === 1 ? "change" : "changes"}`
                : undefined
            }
          >
            {e.batch ? (
              <>
                {e.batch.id}
                <span class="q-dim"> · {BATCH_STATE[e.batch.state].label}</span>
              </>
            ) : (
              <span class="q-dim">none</span>
            )}
          </dd>
        </div>
      ) : null}
      {done ? null : (
        <div>
          <dt>ETA</dt>
          <dd class={`tnum ${e.etaSeconds === null ? "q-dim" : ""}`}>{etaLabel(e.etaSeconds)}</dd>
        </div>
      )}
      {done ? null : (
        <div>
          <dt>Pass chance</dt>
          <dd class={`tnum ${e.predictedPassProbability === null ? "q-dim" : ""}`}>
            {percentLabel(e.predictedPassProbability)}
          </dd>
        </div>
      )}
    </dl>
  );
}

function EntryRow({
  e,
  find,
  trackName,
  now,
}: {
  e: QueueEntryView;
  find: Find;
  trackName: string | null;
  now: number;
}) {
  const prio = PRIORITY[e.priority];
  const stacked = e.dependsOn.filter((id) => !e.blocking.includes(id));
  return (
    <li class={`q-entry q-entry--${e.state}`}>
      <span
        class="q-entry__pos tnum"
        title={e.position === null ? "No queue position" : `Position ${e.position}`}
      >
        <span class="sr-only">{e.position === null ? "No position" : "Position "}</span>
        {e.position ?? "–"}
      </span>
      <div class="q-entry__main">
        <a class="q-entry__title" href={`/changes/${e.changeId}`}>
          {e.title ?? e.changeId}
        </a>
        <p class="q-entry__id tnum">
          {e.changeId} · enqueued {shortAge(new Date(e.enqueuedAt).toISOString(), now)} ago
        </p>
        <div class="q-entry__tags">
          <LaneTag lane={e.lane} size="sm" label="name" />
          <StatusChip meta={ENTRY_STATE[e.state]} />
          {e.frozen ? (
            <span class="chip chip--warn">
              <Icon name="lock" size={14} />
              Frozen
            </span>
          ) : null}
          {e.hold ? (
            <span class="chip">
              <Icon name="pause" size={14} />
              {HOLD[e.hold]}
            </span>
          ) : null}
          {prio.icon ? (
            <span class="q-prio">
              <Icon name={prio.icon} size={14} />
              {prio.label}
            </span>
          ) : null}
        </div>
        {/* A reason that only repeats the state chip ("merged") adds nothing. */}
        {e.reason.trim().toLowerCase() === e.state || e.reason.trim().toLowerCase() === ENTRY_STATE[e.state].label.toLowerCase() ? null : (
          <p class="q-entry__reason">{e.reason}</p>
        )}
        {e.blocking.length > 0 ? (
          <p class="q-entry__rel">
            Blocked by <ChangeLinks ids={e.blocking} find={find} />
          </p>
        ) : null}
        {stacked.length > 0 ? (
          <p class="q-entry__rel">
            Stacked on <ChangeLinks ids={stacked} find={find} />
          </p>
        ) : null}
        {e.plangroup ? (
          <p class="q-entry__rel">
            Lands together with its plan group <a href={`/plans/${e.plangroup}`}>{e.plangroup}</a>
          </p>
        ) : null}
        {e.mergedSha ? (
          <p class="q-entry__rel">
            Merged as <Hash value={e.mergedSha} head={7} tail={0} />
          </p>
        ) : null}
        {e.ejectReason ? <EjectPanel r={e.ejectReason} find={find} /> : null}
      </div>
      <Facts e={e} trackName={trackName} />
    </li>
  );
}

export function QueueEntries({ q, now }: { q: QueueOverviewView; now: number }) {
  const { active, recent } = splitEntries(q.entries);
  const find = entryIndex(q.entries);
  const express = new Map(q.tracks.map((t) => [t.id, t.express]));
  const nameOf = (e: QueueEntryView) =>
    e.trackId === null ? null : trackLabel(e.trackId, express.get(e.trackId));
  return (
    <section class="q-section" aria-labelledby="q-entries">
      <div class="q-section__head">
        <h2 id="q-entries" class="q-section__title">
          Changes in the queue <span class="q-count tnum">{active.length}</span>
        </h2>
        <p class="q-section__lede">
          In landing order. Each row says why the change is where it is.
        </p>
      </div>
      {active.length === 0 ? (
        <p class="q-quiet">No change is waiting or being tested.</p>
      ) : (
        <ul class="q-entries">
          {active.map((e) => (
            <EntryRow key={e.changeId} e={e} find={find} trackName={nameOf(e)} now={now} />
          ))}
        </ul>
      )}
      {recent.length > 0 ? (
        <>
          <h3 class="q-subhead">
            Recently finished <span class="q-count tnum">{recent.length}</span>
          </h3>
          <ul class="q-entries">
            {recent.map((e) => (
              <EntryRow key={e.changeId} e={e} find={find} trackName={nameOf(e)} now={now} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
