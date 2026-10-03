import type { Change, RolloutPolicy, RolloutState } from "@app/domain";
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { LinkedIssue, RepoDetail, TimelineEvent } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, LinkButton, Loading, StatusChip } from "../components/ui.js";
import { detectionSentence, findIncident, healthGapCopy, type Incident, SIGNAL_LABEL, type TimelineRow, timelineRows } from "../lib/rollout-incident.js";
import { addMinutes, countdown, countdownWords, formatClock, formatTime, formatWhenPrecise, relative, spanLabel } from "../lib/time.js";
import { CHANGE_STATUS, ROLLOUT_STATUS, num, plural } from "../lib/vocab.js";
import { useTick } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/rollout.css";

interface RolloutData {
  change: Change;
  rollout: RolloutState | null;
  timeline: TimelineEvent[];
  /** The revert change's own timeline (it merging and shipping), when this change was reverted. */
  revertTimeline: TimelineEvent[];
  issues: LinkedIssue[];
  repo: RepoDetail;
}

async function loadRollout(changeId: string): Promise<RolloutData> {
  const { change } = await api.change(changeId);
  const revertId = change.revertedBy;
  const [r, issues, repo, revertTimeline] = await Promise.all([
    api.rollout(changeId),
    api.issues(changeId).then((x) => x.issues, () => []),
    api.repo(change.repoId),
    revertId ? api.rollout(revertId).then((x) => x.timeline, () => []) : Promise.resolve([]),
  ]);
  return { change, rollout: r.rollout, timeline: r.timeline, revertTimeline, issues, repo };
}

type NodeState = "done" | "current" | "pending" | "failed" | "skipped";

interface TrackNode {
  key: string;
  label: string;
  state: NodeState;
  time: string | null;
  note: string | null;
}

function trackNodes(r: RolloutState, policy: RolloutPolicy, now: number): TrackNode[] {
  const failed = r.status === "rolled-back" || r.status === "rolling-back" || r.status === "failed";
  const nodes: TrackNode[] = r.stages.map((s, i) => {
    let state: NodeState = "pending";
    if (s.completedAt) state = "done";
    else if (s.startedAt) state = failed ? "failed" : r.status === "rolling" ? "current" : "done";
    else if (failed) state = "skipped";
    const advance = s.startedAt && !s.completedAt && r.status === "rolling" ? addMinutes(s.startedAt, policy.stageMinutes) : null;
    return {
      key: `s${i}`,
      label: `${s.percent}%`,
      state,
      time: s.startedAt ? formatTime(s.startedAt) : null,
      note: advance ? `${countdown(advance, now)} left` : state === "failed" ? "stopped" : null,
    };
  });
  const watchState: NodeState = r.status === "watching" ? "current" : r.status === "released" ? "done" : failed ? "skipped" : "pending";
  nodes.push({
    key: "watch",
    label: "Watch",
    state: watchState,
    time: r.watchUntil && watchState !== "pending" ? formatTime(r.watchUntil) : `${policy.watchMinutes} min`,
    note: r.status === "watching" && r.watchUntil ? `${countdown(r.watchUntil, now)} left` : null,
  });
  return nodes;
}

function StageTrack({ nodes }: { nodes: TrackNode[] }) {
  return (
    <ol class="track" aria-label="Rollout stages">
      {nodes.map((n) => (
        <li key={n.key} class={`track__node track__node--${n.state}`} aria-current={n.state === "current" ? "step" : undefined}>
          <span class="track__dot" aria-hidden="true">
            {n.state === "done" ? <Icon name="check" size={14} /> : n.state === "failed" ? <Icon name="x" size={14} /> : null}
          </span>
          <span class="track__label tnum">{n.label}</span>
          <span class="track__time tnum">{n.note ?? n.time ?? "—"}</span>
          <span class="sr-only">{n.state === "current" ? "in progress" : n.state}</span>
        </li>
      ))}
    </ol>
  );
}

function headline(r: RolloutState, policy: RolloutPolicy, now: number, incident: Incident | null): { title: string; line: string; live: boolean } {
  const current = r.stages.find((s) => s.startedAt && !s.completedAt);
  const next = current ? r.stages[r.stages.indexOf(current) + 1] : undefined;
  switch (r.status) {
    case "rolling": {
      const pct = current?.percent ?? 0;
      const advance = current?.startedAt ? addMinutes(current.startedAt, policy.stageMinutes) : null;
      return {
        title: `Rolling out to ${pct}% of traffic`,
        line: advance && next ? `Moves to ${next.percent}% ${countdownWords(advance, now).replace(" left", "")} from now if the checks stay healthy.` : "Holding at this stage.",
        live: true,
      };
    }
    case "watching":
      return {
        title: "Serving 100% and watching",
        line: r.watchUntil ? `The watch window closes in ${countdownWords(r.watchUntil, now).replace(" left", "")}. A breach before then reverts automatically.` : "Watching.",
        live: true,
      };
    case "released":
      return { title: "Released", line: "The watch window closed with no breach.", live: false };
    case "rolled-back":
      return {
        title: "Rolled back",
        line: incident ? detectionSentence(incident, spanLabel) : "Traffic went back to the previous version and a revert change was opened.",
        live: false,
      };
    case "rolling-back":
      return { title: "Rolling back", line: "Traffic is moving back to the previous version.", live: true };
    case "failed":
      return { title: "Rollout failed", line: "The rollout could not complete. Traffic stays on the previous version.", live: false };
    case "pending":
      return { title: "Waiting to start", line: "The rollout starts after the merge deploys.", live: false };
  }
}

/** What happened, to the second: the first error, the detection, and each automatic step after it. */
function IncidentFacts({ incident }: { incident: Incident }) {
  const by = incident.signal === "person" ? "Killed by a person" : incident.signal ? `Detected by ${SIGNAL_LABEL[incident.signal]}` : "Regression detected";
  return (
    <div class="incident">
      <ol class="incident__list" aria-label="What happened, to the second">
        {incident.firstError ? (
          <li class="incident__row is-bad">
            <span class="incident__what">First error in production</span>
            <time class="incident__clock tnum" dateTime={incident.firstError.at}>
              {formatClock(incident.firstError.at)}
            </time>
            <span class="incident__after tnum" />
          </li>
        ) : null}
        <li class="incident__row is-bad">
          <span class="incident__what">{by}</span>
          <time class="incident__clock tnum" dateTime={incident.detectedAt}>
            {formatClock(incident.detectedAt)}
          </time>
          <span class="incident__after tnum">{incident.detectedAfterMs !== null ? `+${spanLabel(incident.detectedAfterMs)}` : "0 s"}</span>
        </li>
        {incident.steps.map((s) => (
          <li key={s.key} class="incident__row">
            <span class="incident__what">{s.label}</span>
            <time class="incident__clock tnum" dateTime={s.at}>
              {formatClock(s.at)}
            </time>
            <span class="incident__after tnum">+{spanLabel(s.afterMs)}</span>
          </li>
        ))}
      </ol>
      <p class="incident__legend">
        {incident.firstError ? "The detection is timed from the first error, each step after it from the detection." : "Each step is timed from the detection."}
      </p>
    </div>
  );
}

function stoppedNote(incident: Incident): string {
  const at = formatClock(incident.detectedAt);
  if (incident.signal === "person") return `Killed by a person at ${at}. The rates below are from the last check that was kept.`;
  const by = incident.signal ? ` by ${SIGNAL_LABEL[incident.signal]}` : "";
  return `Stopped at ${at}${by}. The rates below are from the last check that was kept.`;
}

function Health({ r, policy, now, incident }: { r: RolloutState; policy: RolloutPolicy; now: number; incident: Incident | null }) {
  const c = r.lastCheck;
  const live = r.status === "rolling" || r.status === "watching" || r.status === "pending";
  if (!c) {
    let copy = "No health check result was recorded for this rollout. The timeline has what happened.";
    if (live) copy = "No health check has run yet.";
    else if (incident) copy = healthGapCopy(incident, formatClock);
    return <p class="ev-sub">{copy}</p>;
  }
  const base = c.baselineErrorRate;
  const limit = base !== null ? base + policy.maxErrorRateIncrease : null;
  const rate = c.errorRate;
  const scale = Math.max(limit ?? 0, rate ?? 0, base ?? 0) * 1.15 || 0.01;
  const breach = rate !== null && limit !== null && rate > limit;
  const tooFew = c.requests < policy.minRequests;
  const p = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  return (
    <section class="health" aria-labelledby="health-title">
      <div class="health__head">
        <h2 id="health-title">Health</h2>
        <span class="health__when">
          Checked {relative(c.at, now)} · {num.format(c.requests)} requests
          {tooFew ? <span class="tone--warn"> · fewer than the {policy.minRequests} needed to trust the rate</span> : null}
        </span>
      </div>
      {incident && !live ? <p class="health__note">{stoppedNote(incident)}</p> : null}
      <div class="rates" role="group" aria-label="Error rate against baseline">
        <div class={`rate ${breach ? "rate--bad" : ""}`}>
          <span class="rate__label">This version</span>
          <span class="rate__bar">
            <span class="rate__fill" style={{ inlineSize: `${((rate ?? 0) / scale) * 100}%` }} />
            {limit !== null ? <span class="rate__limit" style={{ insetInlineStart: `${(limit / scale) * 100}%` }} /> : null}
          </span>
          <span class="rate__value tnum">{rate === null ? "unknown" : p(rate)}</span>
        </div>
        <div class="rate rate--base">
          <span class="rate__label">Previous version</span>
          <span class="rate__bar">
            <span class="rate__fill" style={{ inlineSize: `${((base ?? 0) / scale) * 100}%` }} />
            {limit !== null ? <span class="rate__limit" style={{ insetInlineStart: `${(limit / scale) * 100}%` }} /> : null}
          </span>
          <span class="rate__value tnum">{base === null ? "unknown" : p(base)}</span>
        </div>
        {limit !== null ? (
          <p class="rates__legend">
            <span class="rates__tick" aria-hidden="true" /> Reverts above {p(limit)} (baseline + {(policy.maxErrorRateIncrease * 100).toFixed(1)} points)
          </p>
        ) : null}
      </div>
      <dl class="health__facts">
        <div class={c.newIssueGroups > policy.maxNewIssueGroups ? "is-bad" : ""}>
          <dt>New issue groups</dt>
          <dd class="tnum">
            {c.newIssueGroups}
            <span class="health__rule">
              {policy.maxNewIssueGroups === 0 ? "The first new group reverts the change." : `More than ${policy.maxNewIssueGroups} reverts the change.`}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function KillSwitch({ change, onKilled }: { change: Change; onKilled: (c: Change) => void }) {
  const open = useSignal(false);
  const reason = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const prev = change.rolloutState?.previousVersionId;
  const intentKey = useRef<string | null>(null);

  async function kill(e: Event) {
    e.preventDefault();
    if (!reason.value.trim()) {
      error.value = "Give a reason. It goes into the audit log and the revert change.";
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      intentKey.current ??= newIdempotencyKey();
      const res = await api.kill(change.id, reason.value.trim(), intentKey.current);
      onKilled(res.change);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <section class="kill" aria-labelledby="kill-title">
      <h2 id="kill-title" class="kill__title">
        <Icon name="power" size={18} /> Kill switch
      </h2>
      <p class="kill__line">
        Turns the flag off for everyone, sends all traffic back to {prev ? <code>{prev}</code> : "the previous version"}, and opens a revert change.
      </p>
      {open.value ? (
        <form class="kill__form" onSubmit={kill}>
          <label class="field">
            <span class="field__label">Why are you killing this rollout?</span>
            <textarea class="textarea" rows={2} value={reason.value} onInput={(e) => (reason.value = e.currentTarget.value)} aria-describedby={error.value ? "kill-error" : undefined} aria-invalid={error.value ? "true" : undefined} />
          </label>
          {error.value ? (
            <p class="field__error" id="kill-error" role="alert">
              {error.value}
            </p>
          ) : null}
          <div class="kill__actions">
            <Button variant="secondary" onClick={() => ((open.value = false), (error.value = null))} disabled={busy.value}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" icon="power" busy={busy.value} busyLabel="Turning off…" wide>
              Turn off and revert
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="danger-outline" icon="power" onClick={() => (open.value = true)}>
          Kill rollout…
        </Button>
      )}
    </section>
  );
}

function Timeline({ rows, now, revertId }: { rows: TimelineRow[]; now: number; revertId: string | null }) {
  if (rows.length === 0) return null;
  return (
    <section class="timeline" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Timeline</h2>
      <ol>
        {rows.map((r) => (
          <li key={r.key} class={r.bad ? "is-bad" : ""}>
            <time class="tnum" dateTime={r.at} title={new Date(r.at).toLocaleString()}>
              {formatWhenPrecise(r.at, now)}
            </time>
            <span class="timeline__what">
              {r.source === "revert" && revertId ? (
                <a href={`/changes/${revertId}`} class="timeline__label" title={r.action ?? undefined}>
                  {r.label}
                </a>
              ) : (
                <span class="timeline__label" title={r.action ?? undefined}>
                  {r.label}
                </span>
              )}
              {r.detail ? <span class="timeline__detail">{r.detail}</span> : null}
            </span>
            <span class="timeline__end">
              {r.afterMs !== null && r.afterMs > 0 ? (
                <span class="timeline__after tnum" title="After the detection">
                  +{spanLabel(r.afterMs)}
                </span>
              ) : null}
              {r.seq !== null && r.subject ? (
                <a href={`/audit?subject=${encodeURIComponent(r.subject)}`} class="timeline__seq tnum" aria-label={`Audit event ${r.seq}`}>
                  #{r.seq}
                </a>
              ) : (
                <span class="timeline__seq">Issues</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RolloutView({ changeId }: { changeId: string }) {
  const res = useResource(() => loadRollout(changeId), [changeId]);
  const tick = useTick(1000);
  const st = res.state.value;
  const crumbs = [{ href: "/dashboard", label: "Dashboard" }];
  if (st.status === "loading") {
    return (
      <Page title="Rollout" crumbs={crumbs}>
        <Loading label="Loading rollout" lines={6} />
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title="Rollout" crumbs={crumbs}>
        <ErrorState error={st.error} what="this rollout" onRetry={res.reload} />
      </Page>
    );
  }
  const { change, rollout, timeline, revertTimeline, issues, repo } = st.data;
  const policy = repo.repo.policy.rollout;
  const now = tick.value;
  const pageCrumbs = [...crumbs, { href: `/repos/${repo.repo.id}`, label: repo.repo.name }, { href: `/changes/${change.id}`, label: change.title }];

  if (!rollout) {
    return (
      <Page title="Rollout" crumbs={pageCrumbs} meta={<span>{change.title}</span>}>
        <EmptyState icon="rocket" title="No rollout yet" action={<LinkButton href={`/changes/${change.id}`} icon="eye">Open the tour</LinkButton>}>
          <p>Rollouts start after a change merges. It goes to 5%, then 25%, then 100% behind its own flag, with a {policy.watchMinutes}-minute watch window and automatic revert.</p>
        </EmptyState>
      </Page>
    );
  }

  const incident = findIncident(timeline, issues);
  const h = headline(rollout, policy, now, incident);
  const live = rollout.status === "rolling" || rollout.status === "watching" || rollout.status === "pending";
  const meta = ROLLOUT_STATUS[rollout.status];

  return (
    <Page
      title="Rollout"
      wide
      crumbs={pageCrumbs}
      meta={
        <>
          <span>{change.title}</span>
          <StatusChip meta={CHANGE_STATUS[change.status]} />
        </>
      }
    >
      <div class="rollout-layout">
        <div class="rollout-main">
          <section class={`rollout-state rollout-state--${meta.tone}`} aria-live="polite">
            <p class="rollout-state__title">
              <Icon name={meta.icon} size={22} />
              {h.title}
            </p>
            <p class="rollout-state__line">{h.line}</p>
            {incident ? <IncidentFacts incident={incident} /> : null}
            <StageTrack nodes={trackNodes(rollout, policy, now)} />
            <dl class="rollout-facts">
              <div>
                <dt>Flag</dt>
                <dd>{rollout.flagKey ? <code>{rollout.flagKey}</code> : "none"}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>
                  <code>{rollout.versionId ?? "—"}</code>
                  {rollout.previousVersionId ? (
                    <span class="ev-sub">
                      {" "}
                      replaces <code>{rollout.previousVersionId}</code>
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
          </section>

          <Health r={rollout} policy={policy} now={now} incident={incident} />

          {issues.length > 0 ? (
            <section class="issues" aria-labelledby="issues-title">
              <h2 id="issues-title">New issue groups {issues.length > 0 ? <span class="tnum issues__n">{issues.length}</span> : null}</h2>
              <ul>
                {issues.map((i) => (
                  <li key={i.id}>
                    <code class="issues__title">{i.title}</code>
                    <span class="ev-sub tnum">
                      {plural(i.count, "event")} · first {relative(i.firstSeen, now)}
                      {i.url ? (
                        <>
                          {" · "}
                          <a href={i.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside class="rollout-side">
          {live ? (
            <KillSwitch change={change} onKilled={(c) => res.set({ ...st.data, change: c, rollout: c.rolloutState })} />
          ) : change.revertedBy ? (
            <section class="revert-note">
              <Icon name="undo" size={18} />
              <div>
                <p class="revert-note__title">Reverted</p>
                <p>
                  The revert is its own change, verified as the exact inverse. <a href={`/changes/${change.revertedBy}`}>Open the revert change</a>
                </p>
              </div>
            </section>
          ) : change.revertOf ? (
            <section class="revert-note">
              <Icon name="undo" size={18} />
              <div>
                <p class="revert-note__title">This change is a revert</p>
                <p>
                  It restores the state before <a href={`/changes/${change.revertOf}`}>the reverted change</a>.
                </p>
              </div>
            </section>
          ) : null}
          <Timeline rows={timelineRows(timeline, revertTimeline, incident)} now={now} revertId={change.revertedBy} />
        </aside>
      </div>
    </Page>
  );
}
