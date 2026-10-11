/**
 * Per-entry rows of the merge queue: where each change is, why, what blocks it, and, for an
 * ejected change, exactly what its agent should do next.
 */
import type { ComponentChildren } from "preact";
import type { EjectReason, QueueEntryView, QueueOverlap, QueueOverviewView } from "../api/queue.js";
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
  STALL_STATE,
  trackLabel,
} from "../lib/queue.js";
import { relative } from "../lib/time.js";
import { Icon } from "./Icon.js";
import { CopyButton, Hash, LaneTag, StatusChip } from "./ui.js";

type Find = ReturnType<typeof entryIndex>;

function ChangeLinks({ ids, find }: { ids: string[]; find: Find }) {
  return (
    <>
      {ids.map((id, i) => {
        // The title is what people know a change by; the id stays beside it, in Meta.
        const { title } = find(id);
        return (
          <span key={id}>
            {i > 0 ? ", " : null}
            <a href={`/changes/${id}`}>{title}</a>
            {title === id ? null : <span class="q-dim q-rel__id"> {id}</span>}
          </span>
        );
      })}
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

/** At most this many overlap notes per entry; the rest are counted. */
const OVERLAP_NOTES = 3;

/** What one reason adds after the title: "same paths: a.ts", "same plan", or the server's words. */
function OverlapReasonText({ r }: { r: QueueOverlap["reasons"][number] }) {
  if (r.code === "same-paths") {
    return (
      <>
        {" · same paths: "}
        {r.paths.map((p, i) => (
          <span key={p}>
            {i > 0 ? ", " : null}
            <code>{p}</code>
          </span>
        ))}
        {r.morePaths > 0 ? <span class="q-dim"> and {r.morePaths} more</span> : null}
      </>
    );
  }
  if (r.code === "same-plan") return <>{" · same plan"}</>;
  if (r.code === "paths-unknown") return <span class="q-dim">{" · nothing pushed yet"}</span>;
  return <>{` · ${r.message}`}</>;
}

/** Quiet notes: other open changes on the same plan or paths, each linking to that change. */
function OverlapNotes({ overlaps }: { overlaps: QueueOverlap[] }) {
  const shown = overlaps.slice(0, OVERLAP_NOTES);
  const more = overlaps.length - shown.length;
  return (
    <>
      {shown.map((o) => (
        <p
          key={o.changeId}
          class="q-entry__rel q-entry__overlap"
          data-testid="queue-overlap"
          title={o.reasons.map((r) => r.message).join("; ")}
        >
          Overlaps with <a href={`/changes/${o.changeId}`}>{o.title}</a>{" "}
          <span class="q-dim">({o.author.name})</span>
          {o.reasons.map((r) => (
            <OverlapReasonText key={r.code} r={r} />
          ))}
        </p>
      ))}
      {more > 0 ? (
        <p class="q-entry__rel q-dim">
          and {more} more overlapping {more === 1 ? "change" : "changes"}
        </p>
      ) : null}
    </>
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
          <dd class={`tnum ${e.etaSeconds === null ? "q-dim" : ""}`}>{etaFor(e)}</dd>
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

/** No number while the queue cannot honestly estimate one: a stall, or a person's review. */
function etaFor(e: QueueEntryView): string {
  if (e.stall !== null) return `None while ${STALL_STATE[e.stall].label.toLowerCase()}`;
  if (e.etaSeconds === null && e.hold === "approval") return "Waits on a person";
  return etaLabel(e.etaSeconds);
}

function EntryRow({
  e,
  find,
  trackName,
  now,
  actions,
}: {
  e: QueueEntryView;
  find: Find;
  trackName: string | null;
  now: number;
  actions?: ComponentChildren;
}) {
  const prio = PRIORITY[e.priority];
  const stacked = e.dependsOn.filter((id) => !e.blocking.includes(id));
  return (
    <li class={`q-entry q-entry--${e.state}`} data-testid="queue-entry" data-change-id={e.changeId} data-state={e.state}>
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
          {e.changeId} · enqueued {relative(new Date(e.enqueuedAt).toISOString(), now)}
        </p>
        <div class="q-entry__tags">
          <LaneTag lane={e.lane} size="sm" label="name" />
          <StatusChip meta={ENTRY_STATE[e.state]} />
          {e.stall !== null ? <StatusChip meta={STALL_STATE[e.stall]} /> : null}
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
        {e.overlaps && e.overlaps.length > 0 ? <OverlapNotes overlaps={e.overlaps} /> : null}
        {e.mergedSha ? (
          <p class="q-entry__rel" title="The queue lands every change as one commit; a change of several commits is squashed and its message lists them.">
            Merged as <Hash value={e.mergedSha} head={7} tail={0} /> <span class="q-dim">· one commit per change</span>
          </p>
        ) : null}
        {e.ejectReason ? <EjectPanel r={e.ejectReason} find={find} /> : null}
      </div>
      <Facts e={e} trackName={trackName} />
      {actions}
    </li>
  );
}

export function QueueEntries({
  q,
  now,
  actions,
}: {
  q: QueueOverviewView;
  now: number;
  /** What the viewer may do to an active entry (dequeue, priority), if anything. */
  actions?: (e: QueueEntryView) => ComponentChildren;
}) {
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
            <EntryRow key={e.changeId} e={e} find={find} trackName={nameOf(e)} now={now} actions={actions?.(e)} />
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
