import type { Lane } from "@app/domain";
import { api } from "../api/client.js";
import type { RepoSummary } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { EmptyState, ErrorState, LaneTag, Loading, Meter } from "../components/ui.js";
import { LANES, pct, shadowProgress } from "../lib/lanes.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/repos.css";

function LaneCount({ lane, count, shadow = false }: { lane: Lane; count: number; shadow?: boolean }) {
  const word = shadow ? "shadow" : LANES[lane].short.toLowerCase();
  return (
    <span class={`lane-count ${count === 0 ? "is-zero" : ""}`} aria-label={`Lane ${lane}${shadow ? " (shadow)" : ""}: ${count} open`}>
      <LaneTag lane={lane} size="sm" shadow={shadow} />
      <span aria-hidden="true">
        <b class="tnum">{count}</b> {word}
      </span>
    </span>
  );
}

export function ShadowLine({
  repo,
  detail = true,
}: {
  repo: RepoSummary | { policy: RepoSummary["policy"]; shadow: RepoSummary["shadow"] };
  /** The explanation under the bar. Off in the repository list, where it would repeat on every row. */
  detail?: boolean;
}) {
  const p = shadowProgress(repo.shadow);
  const enabled = repo.policy.lane0Enabled;
  const fill = p.state === "collecting" ? p.samples / Math.max(1, p.samples + p.needed) : (p.ratio ?? 0);
  const value = p.state === "collecting" ? `${p.samples}/${p.samples + p.needed}` : pct(p.ratio ?? 0, 1);
  return (
    <div class={`shadow-line shadow-line--${enabled ? "on" : p.state}`}>
      <span class="shadow-line__head">
        {enabled ? <Icon name="check-circle" size={15} /> : <Icon name="circle-dashed" size={15} />}
        {enabled ? "Lane 0 on" : "Lane 0 in shadow mode"}
      </span>
      <div class={`shadow-line__bar ${p.state === "collecting" && !enabled ? "" : "has-tick"}`}>
        <Meter
          value={fill}
          threshold={p.state === "collecting" ? undefined : p.threshold}
          thresholdLabel={p.state === "collecting" ? undefined : `needs ${pct(p.threshold)}`}
          tone={enabled || p.state === "eligible" ? "ok" : p.state === "below" ? "warn" : "neutral"}
          label={`${enabled ? "Lane 0 on" : "Shadow mode"}: ${p.headline}. ${p.detail}`}
        />
        <span class="shadow-line__value tnum" aria-hidden="true">
          {value}
        </span>
      </div>
      {detail ? <p class="shadow-line__detail">{enabled ? `Agreement held at ${pct(p.ratio ?? 0, 1)} over ${p.samples} reviews.` : p.detail}</p> : null}
    </div>
  );
}

function RepoRow({ repo }: { repo: RepoSummary }) {
  const c = repo.counts;
  const shadow = !repo.policy.lane0Enabled;
  const empty = c.lane0 + c.lane1 + c.lane2 + c.awaitingReview + c.rollingOut + c.failing === 0;
  return (
    <li>
      <a class={`repo-row ${empty ? "repo-row--idle" : ""}`} href={`/repos/${repo.id}`}>
        <div class="repo-row__id">
          <span class="repo-row__name">{repo.name}</span>
          <span class="repo-row__sub">
            {repo.namespace} · {repo.defaultBranch}
            {repo.deployTarget ? ` · deploys ${repo.deployTarget}` : " · no deploy target"}
            <span class="repo-row__juris" title="Data jurisdiction">
              {repo.jurisdiction === "unrestricted" ? "any region" : repo.jurisdiction.toUpperCase()}
            </span>
            {repo.claim.status === "unclaimed" ? (
              <span class="repo-row__unclaimed">
                Unclaimed{repo.claim.expiresAt ? `, deleted ${relative(repo.claim.expiresAt, minuteClock.value)}` : ""}
              </span>
            ) : null}
          </span>
        </div>
        <div class="repo-row__waiting">
          {c.awaitingReview > 0 ? (
            <span class="waiting tnum">
              <b>{c.awaitingReview}</b> awaiting review
            </span>
          ) : (
            <span class="waiting waiting--none">Nothing to review</span>
          )}
          <span class="repo-row__flight">
            {c.rollingOut > 0 ? (
              <span class="flight">
                <Icon name="rocket" size={14} /> {plural(c.rollingOut, "rollout")} in flight
              </span>
            ) : null}
            {c.failing > 0 ? (
              <span class="flight flight--danger">
                <Icon name="x-circle" size={14} /> {c.failing} failing
              </span>
            ) : null}
          </span>
        </div>
        <div class="repo-row__lanes">
          <LaneCount lane={2} count={c.lane2} />
          <LaneCount lane={1} count={c.lane1} />
          <LaneCount lane={0} count={c.lane0} shadow={shadow} />
        </div>
        <div class="repo-row__shadow">
          <ShadowLine repo={repo} detail={false} />
        </div>
        <Icon name="chevron-right" class="repo-row__chev" />
      </a>
    </li>
  );
}

function byAttention(a: RepoSummary, b: RepoSummary): number {
  const waiting = (r: RepoSummary) => r.counts.awaitingReview + (r.counts.plansAwaitingApproval ?? 0);
  const live = (r: RepoSummary) => r.counts.failing + r.counts.rollingOut;
  return waiting(b) - waiting(a) || Number(live(b) > 0) - Number(live(a) > 0) || a.name.localeCompare(b.name);
}

export function Repos() {
  const res = useResource(() => api.repos(), []);
  const st = res.state.value;
  // Triage order: work waiting for you first, then live rollouts and failures, then the rest by name.
  const repos = st.status === "ok" ? [...st.data.repos].sort(byAttention) : [];
  const waiting = repos.reduce((n, r) => n + r.counts.awaitingReview, 0);
  const rolling = repos.reduce((n, r) => n + r.counts.rollingOut, 0);
  const withWaiting = repos.filter((r) => r.counts.awaitingReview > 0).length;

  return (
    <Page
      title="Repositories"
      wide
      meta={
        st.status === "ok" && repos.length > 0 ? (
          <p class="repos-summary">
            {waiting > 0 ? (
              <>
                <b class="tnum">{plural(waiting, "change")}</b> {waiting === 1 ? "waits" : "wait"} for review across {plural(withWaiting, "repository", "repositories")}.
              </>
            ) : (
              "Nothing waits for your review."
            )}{" "}
            {rolling > 0 ? `${plural(rolling, "rollout")} in flight.` : null}
          </p>
        ) : null
      }
    >
      {st.status === "loading" ? <Loading label="Loading repositories" lines={6} /> : null}
      {st.status === "error" ? <ErrorState error={st.error} what="your repositories" onRetry={res.reload} /> : null}
      {st.status === "ok" && repos.length === 0 ? (
        <EmptyState icon="git-branch" title="No repositories yet">
          <p>Import a GitHub repository or create an empty one. Agents then start changes through the API or MCP, and you review them here by lane.</p>
          <p>
            Use <code>POST /api/v1/repos</code> with <code>importFrom</code>, or ask a repo admin to add you.
          </p>
        </EmptyState>
      ) : null}
      {st.status === "ok" && repos.length > 0 ? (
        <>
          <div class="repo-cols" aria-hidden="true">
            <span>Repository</span>
            <span>Review</span>
            <span>Open by lane</span>
            <span>Lane 0 agreement</span>
          </div>
          <ul class="rows repo-list">
            {repos.map((r) => (
              <RepoRow key={r.id} repo={r} />
            ))}
          </ul>
        </>
      ) : null}
    </Page>
  );
}
