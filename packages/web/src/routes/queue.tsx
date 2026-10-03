/**
 * Merge queue: tracks as swimlanes, the landing lane, freeze and halt banners, per-entry reasons
 * and deploy trains. Thin by design: everything here is read-only; agents act through the API/MCP.
 */
import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ApiError, api, describeError } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import { fetchQueueOverview, QUEUE_POLL_MS, type QueueOverviewView } from "../api/queue.js";
import { Icon } from "../components/Icon.js";
import { QueueEntries } from "../components/QueueEntries.js";
import { QueueStalls } from "../components/QueueStalls.js";
import { DeployTrains, QueueLanes } from "../components/QueueLanes.js";
import { Page } from "../components/Shell.js";
import { ErrorState, Hash, Loading } from "../components/ui.js";
import {
  durationShort,
  FREEZE_KIND,
  flakeRows,
  freezeTone,
  percentLabel,
  updatedLabel,
} from "../lib/queue.js";
import { formatWhen } from "../lib/time.js";
import { num, shortSha } from "../lib/vocab.js";
import { useTick } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { sessionExpired } from "../state/session.js";
import "../styles/queue.css";

interface QueueState {
  data: QueueOverviewView | null;
  /** The last failed load; kept beside stale data so a failed refresh never blanks the screen. */
  error: unknown;
  fetchedAt: number | null;
}

/** Loads the overview, then polls every 10 s against the real API (paused while the tab is hidden). */
function useQueue(repoId: string): { state: Signal<QueueState>; retry: () => void } {
  const state = useSignal<QueueState>({ data: null, error: null, fetchedAt: null });
  const nonce = useSignal(0);
  const attempt = nonce.value;
  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: number | undefined;
    const poll = !isMockMode();
    // A new repo, or a retry after a failed first load, starts from the loading state.
    const current = state.peek().data;
    if (current === null || current.repoId !== repoId)
      state.value = { data: null, error: null, fetchedAt: null };

    const schedule = () => {
      window.clearTimeout(timer);
      if (live && poll) timer = window.setTimeout(load, QUEUE_POLL_MS);
    };
    async function load() {
      if (busy || (poll && document.hidden)) return schedule();
      busy = true;
      try {
        const data = await fetchQueueOverview(repoId);
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

/** "Updated 12 s ago" on its own one-second clock, so the page does not re-render every second. */
function UpdatedAgo({ at }: { at: number }) {
  const now = useTick(1000).value;
  return (
    <span class="tnum" title={new Date(at).toLocaleString()}>
      {updatedLabel(at, now)}
      {isMockMode() ? null : " · refreshes every 10 s"}
    </span>
  );
}

function HaltedBanner({
  halted,
  now,
}: {
  halted: NonNullable<QueueOverviewView["halted"]>;
  now: number;
}) {
  return (
    <section class="q-banner q-banner--danger" role="alert" aria-labelledby="q-halted">
      <Icon name="pause" size={22} class="q-banner__icon" />
      <div class="q-banner__body">
        <h2 id="q-halted" class="q-banner__title">
          Queue halted
        </h2>
        <p class="q-banner__lede">
          An invariant check failed, so the queue stopped instead of guessing. It needs an operator:
          nothing speculates or lands until someone reconciles it.
        </p>
        <p class="q-banner__msg">{halted.message}</p>
        <p class="q-banner__meta">
          <code>{halted.code}</code> · since {formatWhen(new Date(halted.at).toISOString(), now)}
        </p>
      </div>
    </section>
  );
}

function FreezeBanner({ q, now }: { q: QueueOverviewView; now: number }) {
  const tone = freezeTone(q.freezeReasons);
  return (
    <section class={`q-banner q-banner--${tone}`} role="status" aria-labelledby="q-frozen">
      <Icon name="lock" size={22} class="q-banner__icon" />
      <div class="q-banner__body">
        <h2 id="q-frozen" class="q-banner__title">
          Queue frozen
        </h2>
        <p class="q-banner__lede">
          Only reverts and incident fixes can land. Everything else keeps speculating, but nothing
          new merges until the queue thaws.
        </p>
        {q.freezeReasons.length === 0 ? (
          <p class="q-banner__msg">The server gave no reason for this freeze.</p>
        ) : null}
        <ul class="q-freeze">
          {q.freezeReasons.map((r) => (
            <li key={`${r.kind}-${r.at}`} class="q-freeze__item">
              <p class="q-freeze__kind">{FREEZE_KIND[r.kind]}</p>
              <p class="q-banner__msg">{r.message}</p>
              <dl class="q-freeze__facts">
                <div>
                  <dt>Since</dt>
                  <dd class="tnum">{formatWhen(new Date(r.at).toISOString(), now)}</dd>
                </div>
                {r.sha ? (
                  <div>
                    <dt>On main at</dt>
                    <dd>
                      <Hash value={r.sha} head={7} tail={0} />
                    </dd>
                  </div>
                ) : null}
                {r.changeId ? (
                  <div>
                    <dt>Change</dt>
                    <dd>
                      <a href={`/changes/${r.changeId}`}>{r.changeId}</a>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Signed by</dt>
                  <dd>
                    {r.signer ? (
                      <>
                        {r.signer.principalId} <Hash value={r.signer.signature} head={6} tail={4} />
                      </>
                    ) : (
                      <span class="tone--warn">Not signed</span>
                    )}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const rate = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function Stats({ q }: { q: QueueOverviewView }) {
  const t = q.timeInQueueMs;
  return (
    <section class="q-stats" aria-label="Queue health">
      <dl class="q-stats__grid">
        <div class="q-stat">
          <dt>Waiting</dt>
          <dd class="tnum">{num.format(q.waiting)}</dd>
        </div>
        <div class="q-stat">
          <dt>Resolving conflicts</dt>
          <dd class="tnum">{num.format(q.resolving)}</dd>
        </div>
        <div class="q-stat">
          <dt>Landed per hour</dt>
          <dd class="tnum">{rate.format(q.throughputPerHour)}</dd>
        </div>
        <div class="q-stat">
          <dt>Median time in queue</dt>
          <dd class="tnum">
            <span class={t.p50 === null ? "tone--warn q-stat__nm" : ""}>
              {durationShort(t.p50)}
            </span>
            <span class="q-stat__sub">
              p95 <span class={t.p95 === null ? "tone--warn" : ""}>{durationShort(t.p95)}</span>
            </span>
          </dd>
        </div>
        <div class="q-stat">
          <dt>CI run</dt>
          <dd class="tnum">
            <span class={q.ciDurationMs > 0 ? "" : "tone--warn q-stat__nm"}>
              {q.ciDurationMs > 0 ? durationShort(q.ciDurationMs) : "Not measured"}
            </span>
            <span class="q-stat__sub">recent median</span>
          </dd>
        </div>
        <div class="q-stat">
          <dt>Quarantined tests</dt>
          <dd class="tnum">
            {num.format(q.quarantined.length)}
            {q.quarantined.length > 0 ? (
              <a class="q-stat__sub" href="#q-flaky">
                See flake rates
              </a>
            ) : (
              <span class="q-stat__sub">none</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function FlakyTests({ q }: { q: QueueOverviewView }) {
  const rows = flakeRows(q.quarantined, q.flakeRates);
  if (rows.length === 0) return null;
  return (
    <section class="q-section" aria-labelledby="q-flaky">
      <div class="q-section__head">
        <h2 id="q-flaky" class="q-section__title" tabIndex={-1}>
          Flaky tests
        </h2>
        <p class="q-section__lede">
          A quarantined test never counts as passing: a change whose affected set includes one goes
          to at least Lane 1.
        </p>
      </div>
      <ul class="q-flaky">
        {rows.map((r) => (
          <li key={r.test} class="q-flaky__row">
            <code class="q-flaky__test">{r.test}</code>
            <span class="q-flaky__meta">
              {r.quarantined ? (
                <span class="chip chip--warn">
                  <Icon name="lock" size={14} />
                  Quarantined
                </span>
              ) : null}
              <span class="tnum q-flaky__rate">
                {r.rate === null ? (
                  <span class="tone--warn">Not measured</span>
                ) : (
                  `${percentLabel(r.rate)} flaky`
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function QueueView({ repoId }: { repoId: string }) {
  const repo = useResource(() => api.repo(repoId), [repoId]);
  const rs = repo.state.value;
  const repoName = rs.status === "ok" ? rs.data.repo.name : "Repository";
  const crumbs = [
    { href: "/dashboard", label: "Dashboard" },
    { href: `/repos/${repoId}`, label: repoName },
  ];
  const { state, retry } = useQueue(repoId);
  const s = state.value;
  const now = useTick(30_000).value;

  if (!s.data) {
    return (
      <Page title="Merge queue" crumbs={crumbs}>
        {s.error ? (
          <ErrorState error={s.error} what="the merge queue" onRetry={retry} />
        ) : (
          <Loading label="Loading the merge queue" lines={8} />
        )}
      </Page>
    );
  }

  const q = s.data;
  return (
    <Page
      title="Merge queue"
      wide
      crumbs={crumbs}
      meta={
        <>
          <span>
            main at <code>{shortSha(q.mainSha)}</code>
          </span>
          {s.fetchedAt ? <UpdatedAgo at={s.fetchedAt} /> : null}
          {s.error ? (
            <span class="tone--warn" role="status">
              Couldn't refresh: {describeError(s.error, "the queue").title}. Showing the last state.
            </span>
          ) : null}
        </>
      }
    >
      <div class="q">
        {q.halted ? <HaltedBanner halted={q.halted} now={now} /> : null}
        {q.frozen ? <FreezeBanner q={q} now={now} /> : null}
        <QueueStalls q={q} now={now} />
        <Stats q={q} />
        <QueueLanes q={q} />
        <QueueEntries q={q} now={now} />
        <DeployTrains q={q} />
        <FlakyTests q={q} />
      </div>
    </Page>
  );
}
