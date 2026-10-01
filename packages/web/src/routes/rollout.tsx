import type { Change, RolloutPolicy, RolloutState } from "@app/domain";
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { AuditEvent, LinkedIssue, RepoDetail } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, LinkButton, Loading, StatusChip } from "../components/ui.js";
import { addMinutes, countdown, countdownWords, formatTime, formatWhen, relative } from "../lib/time.js";
import { CHANGE_STATUS, ROLLOUT_STATUS, num, plural } from "../lib/vocab.js";
import { useTick } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/rollout.css";

interface RolloutData {
  change: Change;
  rollout: RolloutState | null;
  timeline: AuditEvent[];
  issues: LinkedIssue[];
  repo: RepoDetail;
}

async function loadRollout(changeId: string): Promise<RolloutData> {
  const { change } = await api.change(changeId);
  const [r, issues, repo] = await Promise.all([api.rollout(changeId), api.issues(changeId).then((x) => x.issues, () => []), api.repo(change.repoId)]);
  return { change, rollout: r.rollout, timeline: r.timeline, issues, repo };
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

function headline(r: RolloutState, policy: RolloutPolicy, now: number): { title: string; line: string; live: boolean } {
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
      return { title: "Rolled back", line: "Traffic went back to the previous version and a revert change was opened.", live: false };
    case "rolling-back":
      return { title: "Rolling back", line: "Traffic is moving back to the previous version.", live: true };
    case "failed":
      return { title: "Rollout failed", line: "The rollout could not complete. Traffic stays on the previous version.", live: false };
    case "pending":
      return { title: "Waiting to start", line: "The rollout starts after the merge deploys.", live: false };
  }
}

function Health({ r, policy, now }: { r: RolloutState; policy: RolloutPolicy; now: number }) {
  const c = r.lastCheck;
  if (!c) return <p class="ev-sub">No health check has run yet.</p>;
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

const ACTION_LABEL: Record<string, string> = {
  "merge.completed": "Merged into main",
  "rollout.stage.started": "Stage started",
  "rollout.stage.completed": "Stage completed",
  "rollout.check.passed": "Health check passed",
  "rollout.check.failed": "Health check breached the limit",
  "rollout.watch.started": "Watch window opened",
  "rollout.released": "Released",
  "rollout.rolled-back": "Rolled back to the previous version",
  "rollout.killed": "Killed by a person",
  "flag.disabled": "Flag turned off",
  "revert.opened": "Revert change opened",
  "review.approved": "Approved",
  "change.created": "Change opened",
};

function humanAction(action: string): string {
  const words = action.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Timeline({ events, now }: { events: AuditEvent[]; now: number }) {
  if (events.length === 0) return null;
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  return (
    <section class="timeline" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Timeline</h2>
      <ol>
        {ordered.map((e) => (
          <li key={e.seq} class={e.action.includes("failed") || e.action.includes("rolled-back") || e.action.includes("killed") ? "is-bad" : ""}>
            <time class="tnum" dateTime={e.at}>
              {formatWhen(e.at, now)}
            </time>
            <span>{ACTION_LABEL[e.action] ?? humanAction(e.action)}</span>
            <a href={`/audit?subject=${encodeURIComponent(e.subject)}`} class="timeline__seq tnum" aria-label={`Audit event ${e.seq}`}>
              #{e.seq}
            </a>
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
  const crumbs = [{ href: "/", label: "Repositories" }];
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
  const { change, rollout, timeline, issues, repo } = st.data;
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

  const h = headline(rollout, policy, now);
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

          <Health r={rollout} policy={policy} now={now} />

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
          <Timeline events={timeline} now={now} />
        </aside>
      </div>
    </Page>
  );
}
