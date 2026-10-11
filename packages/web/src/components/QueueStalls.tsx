/**
 * What is not moving in the merge queue, why, and what happens next. Journey 06: Changes sat in
 * "Building tree" for 16 minutes with an ETA on screen and no word of the failures behind it.
 * Each stall names the step, the Changes it holds, the error (class and redacted message), the
 * attempts so far and the next automatic step or the person who has to act.
 */
import type { QueueOverviewView, QueueStall } from "../api/queue.js";
import { attemptsLabel, entryIndex, STALL_STATE, stallNextLabel, stallTone } from "../lib/queue.js";
import { formatWhenPrecise } from "../lib/time.js";
import { Icon } from "./Icon.js";

function StallItem({ x, q, now }: { x: QueueStall; q: QueueOverviewView; now: number }) {
  const find = entryIndex(q.entries);
  const meta = STALL_STATE[x.state];
  return (
    <li class="q-freeze__item q-stall">
      <p class="q-freeze__kind">
        <span class={`q-stall__state tone--${meta.tone}`}>{meta.label}:</span> {x.what}
        {x.changeIds.length > 0 ? (
          <>
            {" "}
            for{" "}
            {x.changeIds.map((id, i) => (
              <span key={id}>
                {i > 0 ? ", " : null}
                <a href={`/changes/${id}`}>{find(id).title}</a>
              </span>
            ))}
          </>
        ) : null}
      </p>
      <p class="q-banner__msg q-stall__error">
        {x.error ? (
          <>
            <code>{x.error.errorClass}</code> {x.error.message}
          </>
        ) : (
          "No error was recorded: the step was lost or given up without one."
        )}
      </p>
      <dl class="q-freeze__facts">
        <div class="q-stall__next">
          <dt>Next</dt>
          <dd class={x.next.kind === "human" ? "tone--danger" : ""}>
            {stallNextLabel(x.next, now)}
          </dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd class="tnum">{attemptsLabel(x)}</dd>
        </div>
        {x.since !== null ? (
          <div>
            <dt>Since</dt>
            <dd class="tnum">{formatWhenPrecise(new Date(x.since).toISOString(), now)}</dd>
          </div>
        ) : null}
        {x.batchId ? (
          <div>
            <dt>Batch</dt>
            <dd>{x.batchId}</dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}

export function QueueStalls({ q, now }: { q: QueueOverviewView; now: number }) {
  if (q.stalls.length === 0) return null;
  const tone = stallTone(q.stalls);
  const stopped = tone === "danger";
  return (
    <section
      class={`q-banner q-banner--${tone}`}
      role={stopped ? "alert" : "status"}
      aria-labelledby="q-stalled"
    >
      <Icon name={stopped ? "pause" : "redo"} size={22} class="q-banner__icon" />
      <div class="q-banner__body">
        <h2 id="q-stalled" class="q-banner__title">
          {stopped ? "Queue stalled" : "Retrying a failed step"}
        </h2>
        <p class="q-banner__lede">
          {stopped
            ? "Something the queue needs stopped. The changes it holds have no ETA until it moves again."
            : "A step keeps failing. The queue retries it on its own; the changes it holds have no ETA meanwhile."}
        </p>
        <ul class="q-freeze">
          {q.stalls.map((x) => (
            <StallItem
              key={`${x.command}:${x.batchId ?? ""}:${x.changeIds.join(",")}`}
              x={x}
              q={q}
              now={now}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
