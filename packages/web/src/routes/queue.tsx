/**
 * Merge queue: freeze and halt banners, a strip of figures, per-entry reasons ("where is my
 * change?") with the acts a person may take, then tracks as swimlanes, the landing lane and
 * deploy trains. Agents do the same through the API/MCP; the acts show their twins.
 */
import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { ApiError, api, describeError } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import { membersApi } from "../api/members.js";
import { fetchQueueOverview, QUEUE_POLL_MS, type QueueEntryView, type QueueOverviewView } from "../api/queue.js";
import { Icon } from "../components/Icon.js";
import { paletteRepos } from "../components/Palette.js";
import { EntryActs, FreezeForm, ResumeAct } from "../components/QueueActs.js";
import { QueueEntries } from "../components/QueueEntries.js";
import { QueueStalls } from "../components/QueueStalls.js";
import { DeployTrains, QueueLanes } from "../components/QueueLanes.js";
import { Page } from "../components/Shell.js";
import { Button, ErrorState, Hash, Loading } from "../components/ui.js";
import {
  durationShort,
  FREEZE_KIND,
  flakeRows,
  freezeTone,
  percentLabel,
  queuePowers,
  updatedLabel,
} from "../lib/queue.js";
import { formatWhen } from "../lib/time.js";
import { num, shortSha } from "../lib/vocab.js";
import { useTick } from "../state/clock.js";
import { useMedia } from "../state/media.js";
import { useResource } from "../state/resource.js";
import { principal, sessionExpired } from "../state/session.js";
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

/** "Maya Okafor", "Maya Okafor or Dev Patel": who to ask when the viewer cannot act. */
function ownersLine(owners: string[]): string {
  if (owners.length === 0) return "a repository owner";
  if (owners.length === 1) return `a repository owner (${owners[0]})`;
  return `a repository owner (${owners.slice(0, -1).join(", ")} or ${owners[owners.length - 1]})`;
}

function HaltedBanner({
  halted,
  now,
  admin,
}: {
  halted: NonNullable<QueueOverviewView["halted"]>;
  now: number;
  /** The resume act for an owner, or who to ask. */
  admin: { act: ComponentChildren } | { ask: string };
}) {
  return (
    <section class="q-banner q-banner--danger" role="alert" aria-labelledby="q-halted" data-testid="queue-halted">
      <Icon name="pause" size={22} class="q-banner__icon" />
      <div class="q-banner__body">
        <h2 id="q-halted" class="q-banner__title">
          Queue halted
        </h2>
        <p class="q-banner__lede">
          A safety check failed, so the queue stopped instead of guessing. Nothing is tested or
          lands until a person checks main and resumes it.
        </p>
        <p class="q-banner__msg">{halted.message}</p>
        <p class="q-banner__meta">
          <code>{halted.code}</code> · since {formatWhen(new Date(halted.at).toISOString(), now)}
        </p>
        {"act" in admin ? admin.act : <p class="q-banner__msg">Ask {admin.ask} to check main and resume the queue.</p>}
      </div>
    </section>
  );
}

function FreezeBanner({ q, now, thaw }: { q: QueueOverviewView; now: number; thaw: ComponentChildren }) {
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
        {thaw}
      </div>
    </section>
  );
}

const rate = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/**
 * One strip of figures between hairlines, not a grid of cards: value in Title with tabular
 * numerals, its label under it in Meta. A figure takes a tone only when it is a state
 * (conflicts being resolved, a measurement missing), and then says so in words.
 */
function Stats({ q }: { q: QueueOverviewView }) {
  const t = q.timeInQueueMs;
  return (
    <section class="q-figs" aria-label="Queue health">
      <dl class="q-figs__row">
        <div class="q-fig">
          <dt>Waiting</dt>
          <dd class="tnum">{num.format(q.waiting)}</dd>
        </div>
        <div class={`q-fig ${q.resolving > 0 ? "q-fig--warn" : ""}`}>
          <dt>Resolving conflicts</dt>
          <dd class="tnum">{num.format(q.resolving)}</dd>
        </div>
        <div class="q-fig">
          <dt>Landed per hour</dt>
          <dd class="tnum">{rate.format(q.throughputPerHour)}</dd>
        </div>
        <div class="q-fig">
          <dt>
            Median wait
            {t.p95 !== null ? <span class="q-fig__sub">p95 {durationShort(t.p95)}</span> : null}
          </dt>
          <dd class={`tnum ${t.p50 === null ? "tone--warn q-fig__nm" : ""}`}>{durationShort(t.p50)}</dd>
        </div>
        <div class="q-fig">
          <dt>CI run, median</dt>
          <dd class={`tnum ${q.ciDurationMs > 0 ? "" : "tone--warn q-fig__nm"}`}>
            {q.ciDurationMs > 0 ? durationShort(q.ciDurationMs) : "Not measured"}
          </dd>
        </div>
        <div class="q-fig">
          <dt>
            {q.quarantined.length > 0 ? (
              <a href="#q-flaky">Quarantined tests</a>
            ) : (
              "Quarantined tests"
            )}
          </dt>
          <dd class="tnum">{num.format(q.quarantined.length)}</dd>
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
          A quarantined test never counts as passing: a change whose affected set includes one gets
          at least a quick review (Lane 1).
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

/** Who the viewer is on this repo (role, own agents, owners' names); unknown hides the acts. */
function useAccess(repoId: string) {
  const res = useResource(async () => {
    const [members, mine] = await Promise.all([membersApi.list(repoId), api.principals()]);
    return { members, mine: new Set(mine.principals.filter((p) => p.kind === "agent").map((p) => p.id)) };
  }, [repoId]);
  const st = res.state.value;
  const data = st.status === "ok" ? st.data : null;
  const powers = queuePowers(principal.value, data?.members.viewerRole ?? null, data?.mine ?? new Set());
  const owners = data?.members.members.filter((m) => m.role === "owner").map((m) => m.name) ?? [];
  return { powers, owners };
}

export function QueueView({ repoId }: { repoId: string }) {
  const repo = useResource(() => api.repo(repoId), [repoId]);
  const rs = repo.state.value;
  // The name the sidebar already has, so the crumb never flashes "Repository".
  const known = paletteRepos.value.find((r) => r.id === repoId)?.name;
  const repoName = rs.status === "ok" ? rs.data.repo.name : (known ?? "Repository");
  const crumbs = [
    { href: "/dashboard", label: "Dashboard" },
    { href: `/repos/${repoId}`, label: repoName },
  ];
  const { state, retry } = useQueue(repoId);
  const s = state.value;
  const now = useTick(30_000).value;
  const { powers, owners } = useAccess(repoId);
  const notice = useSignal<string | null>(null);
  const phone = useMedia("(max-width: 639px)");
  const freezing = useSignal<"freeze" | "thaw" | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const acted = (message: string) => {
    notice.value = message;
    freezing.value = null;
    retry();
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

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
  const titleOf = (id: string) => q.entries.find((e) => e.changeId === id)?.title ?? id;
  const actsFor = (e: QueueEntryView) =>
    powers.canAct(e.authorId) ? (
      <EntryActs
        e={e}
        dependents={q.entries.filter((d) => d.dependsOn.includes(e.changeId) && d.state !== "dequeued").map((d) => titleOf(d.changeId))}
        onActed={acted}
      />
    ) : null;
  const automatic = q.freezeReasons.some((r) => r.kind !== "manual");
  return (
    <Page
      title="Merge queue"
      wide
      crumbs={crumbs}
      actions={
        powers.canAdmin && !q.frozen && freezing.value === null ? (
          <Button size="sm" icon="lock" data-testid="queue-freeze" onClick={() => (freezing.value = "freeze")}>
            Freeze the queue…
          </Button>
        ) : null
      }
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
        {freezing.value === "freeze" && !q.frozen ? (
          <FreezeForm repoId={repoId} freeze automatic={false} onDone={acted} onCancel={() => (freezing.value = null)} />
        ) : null}
        {q.halted ? (
          <HaltedBanner
            halted={q.halted}
            now={now}
            admin={powers.canAdmin ? { act: <ResumeAct repoId={repoId} onDone={acted} /> } : { ask: ownersLine(owners) }}
          />
        ) : null}
        {q.frozen ? (
          <FreezeBanner
            q={q}
            now={now}
            thaw={
              !powers.canAdmin ? null : freezing.value === "thaw" ? (
                <FreezeForm repoId={repoId} freeze={false} automatic={automatic} onDone={acted} onCancel={() => (freezing.value = null)} />
              ) : (
                <div class="q-banner__acts">
                  <Button size="sm" icon="lock" data-testid="queue-thaw" onClick={() => (freezing.value = "thaw")}>
                    Thaw the queue…
                  </Button>
                </div>
              )
            }
          />
        ) : null}
        <QueueStalls q={q} now={now} />
        <Stats q={q} />
        {/* After an act the row it came from may move or close, so focus lands on what happened. */}
        <p class="q-notice" role="status" tabIndex={-1} ref={noticeRef} data-testid="queue-notice">
          {notice.value}
        </p>
        <QueueEntries q={q} now={now} actions={actsFor} />
        <QueueLanes q={q} folded={phone} />
        <DeployTrains q={q} />
        <FlakyTests q={q} />
      </div>
    </Page>
  );
}
