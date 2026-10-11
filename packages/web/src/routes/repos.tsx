import type { Lane } from "@app/domain";
import { GITHUB_SURFACES } from "@app/domain/surfaces";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api } from "../api/client.js";
import { gettingStartedApi } from "../api/getting-started.js";
import type { RepoSummary } from "../api/types.js";
import { Fleet, fleetRows, rememberedFleet } from "../components/Fleet.js";
import { GettingStarted } from "../components/GettingStarted.js";
import { Icon } from "../components/Icon.js";
import { ImportRepo } from "../components/ImportRepo.js";
import { Page } from "../components/Shell.js";
import { Term } from "../components/Term.js";
import {
  Button,
  EmptyState,
  ErrorState,
  LaneTag,
  Meter,
  SkeletonHead,
  SkeletonRows,
} from "../components/ui.js";
import { checklistView, POLL_MS, readDismissed, writeDismissed } from "../lib/getting-started.js";
import { LANES, pct, shadowProgress } from "../lib/lanes.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import "../styles/repos.css";

function LaneCount({
  lane,
  count,
  shadow = false,
}: {
  lane: Lane;
  count: number;
  shadow?: boolean;
}) {
  const word = shadow ? "calibrating" : LANES[lane].name.toLowerCase();
  return (
    <span
      class={`lane-count ${count === 0 ? "is-zero" : ""}`}
      role="img"
      aria-label={`${LANES[lane].name} (Lane ${lane})${shadow ? ", calibrating" : ""}: ${count} open`}
    >
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
  const fill =
    p.state === "collecting" ? p.samples / Math.max(1, p.samples + p.needed) : (p.ratio ?? 0);
  const value =
    p.state === "collecting" ? `${p.samples}/${p.samples + p.needed}` : pct(p.ratio ?? 0, 1);
  // Auto-merge on: the agreement no longer decides anything, so the list row says only that.
  if (enabled && !detail) {
    return (
      <div class="shadow-line shadow-line--on">
        <span class="shadow-line__head">
          <Icon name="check-circle" size={15} /> Auto-merge on
        </span>
      </div>
    );
  }
  return (
    <div class={`shadow-line shadow-line--${enabled ? "on" : p.state}`}>
      <span class="shadow-line__head">
        {enabled ? <Icon name="check-circle" size={15} /> : <Icon name="circle-dashed" size={15} />}
        {enabled ? "Auto-merge on" : "Auto-merge calibrating"}
      </span>
      <div class={`shadow-line__bar ${p.state === "collecting" && !enabled ? "" : "has-tick"}`}>
        <Meter
          value={fill}
          threshold={p.state === "collecting" ? undefined : p.threshold}
          thresholdLabel={p.state === "collecting" ? undefined : `needs ${pct(p.threshold)}`}
          tone={enabled || p.state === "eligible" ? "ok" : p.state === "below" ? "warn" : "neutral"}
          label={`${enabled ? "Auto-merge on" : "Auto-merge calibrating"}: ${p.headline}. ${p.detail}`}
        />
        <span class="shadow-line__value tnum" aria-hidden="true">
          {value}
        </span>
      </div>
      {detail ? (
        <p class="shadow-line__detail">
          {enabled
            ? `Agreement held at ${pct(p.ratio ?? 0, 1)} over ${p.samples} reviews.`
            : p.detail}
        </p>
      ) : null}
    </div>
  );
}

function RepoRow({ repo }: { repo: RepoSummary }) {
  const c = repo.counts;
  const shadow = !repo.policy.lane0Enabled;
  const plans = c.plansAwaitingApproval ?? 0;
  const empty = c.lane0 + c.lane1 + c.lane2 + c.awaitingReview + c.rollingOut + c.failing === 0;
  return (
    <li>
      <a class={`repo-row ${empty ? "repo-row--idle" : ""}`} href={`/repos/${repo.id}`}>
        <div class="repo-row__id">
          <span class="repo-row__name">{repo.name}</span>
          <span class="repo-row__sub">
            {repo.host
              ? `on GitHub (mirrored) · ${repo.defaultBranch}`
              : `${repo.namespace} · ${repo.defaultBranch}`}
            {repo.host
              ? ""
              : repo.deployTarget
                ? ` · deploys ${repo.deployTarget}`
                : " · no deploy target"}
            <span class="repo-row__juris" title="Data jurisdiction">
              {repo.jurisdiction === "unrestricted"
                ? "any region"
                : repo.jurisdiction.toUpperCase()}
            </span>
            {repo.claim.status === "unclaimed" ? (
              <span class="repo-row__unclaimed">
                Unclaimed
                {repo.claim.expiresAt
                  ? `, deleted ${relative(repo.claim.expiresAt, minuteClock.value)}`
                  : ""}
              </span>
            ) : null}
          </span>
        </div>
        <div class="repo-row__waiting">
          {c.awaitingReview > 0 ? (
            <span class="waiting tnum">
              <b>{c.awaitingReview}</b> awaiting review
            </span>
          ) : null}
          {plans > 0 ? (
            <span class="waiting tnum">
              <b>{plans}</b> {plans === 1 ? "plan" : "plans"} to approve
            </span>
          ) : null}
          {c.awaitingReview === 0 && plans === 0 ? (
            <span class="waiting waiting--none">Nothing to review</span>
          ) : null}
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
  const waiting = (r: RepoSummary) =>
    r.counts.awaitingReview + (r.counts.plansAwaitingApproval ?? 0);
  const live = (r: RepoSummary) => r.counts.failing + r.counts.rollingOut;
  return (
    waiting(b) - waiting(a) ||
    Number(live(b) > 0) - Number(live(a) > 0) ||
    a.name.localeCompare(b.name)
  );
}

/** The signed-in home (`/dashboard`): the getting-started checklist, then repositories by attention. */
export function Repos() {
  const res = useResource(() => api.repos(), []);
  const gs = useResource(() => gettingStartedApi.state(), []);
  const audit = useResource(() => api.audit({ limit: 100 }), []);
  const me = principal.value;
  const dismissed = useSignal(me ? readDismissed(me.id) : false);
  const gsState = gs.state.value.status === "ok" ? gs.state.value.data : null;
  const view = gsState ? checklistView(gsState, dismissed.value) : null;
  const running = view?.steps.some((s) => s.state === "running") ?? false;
  // While a first run is going, re-read the checklist (and the list, when it finishes).
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => gs.reload(), POLL_MS);
    return () => {
      window.clearInterval(id);
      res.reload();
    };
  }, [running]);
  const onChanged = () => {
    gs.reload();
    res.reload();
  };
  const onDismiss = () => {
    if (me) writeDismissed(me.id, true);
    dismissed.value = true;
  };
  // The palette's "Import a private repo…" lands on /dashboard#import.
  const { url } = useLocation();
  const importing = useSignal(false);
  useEffect(() => {
    if (window.location.hash === "#import") importing.value = true;
  }, [url]);
  const st = res.state.value;
  // Triage order: work waiting for you first, then live rollouts and failures, then the rest by name.
  const repos = st.status === "ok" ? [...st.data.repos].sort(byAttention) : [];
  const waiting = repos.reduce((n, r) => n + r.counts.awaitingReview, 0);
  const plansWaiting = repos.reduce((n, r) => n + (r.counts.plansAwaitingApproval ?? 0), 0);
  const rolling = repos.reduce((n, r) => n + r.counts.rollingOut, 0);
  const withWaiting = repos.filter(
    (r) => r.counts.awaitingReview + (r.counts.plansAwaitingApproval ?? 0) > 0,
  ).length;
  // One arrival, not three: the checklist, the band and the list each load on their own, so the
  // page holds a skeleton shaped like itself until all three have answered (errors count).
  const settled =
    st.status !== "loading" &&
    gs.state.value.status !== "loading" &&
    audit.state.value.status !== "loading";
  const fleet = audit.state.value;
  // Triage order: when an agent waits on a person, the band leads; otherwise the list does.
  const bandFirst = settled
    ? fleetRows(fleet, minuteClock.value).some((r) => r.state === "waiting")
    : rememberedFleet().waiting;
  const band = <Fleet state={settled ? fleet : { status: "loading" }} me={me?.id ?? null} />;

  return (
    <Page
      title="Dashboard"
      wide
      actions={
        importing.value ? null : (
          <Button
            size="sm"
            icon="upload"
            onClick={() => (importing.value = true)}
            data-testid="import-open-panel"
          >
            Import a private repo
          </Button>
        )
      }
      meta={
        settled && st.status === "ok" && repos.length > 0 ? (
          <p class="repos-summary">
            {waiting + plansWaiting > 0 ? (
              <>
                {waiting > 0 ? (
                  <b class="tnum">
                    {waiting} <Term id="change">{waiting === 1 ? "Change" : "Changes"}</Term>
                  </b>
                ) : null}
                {waiting > 0 && plansWaiting > 0 ? " and " : null}
                {plansWaiting > 0 ? (
                  <b class="tnum">
                    {plansWaiting} <Term id="plan">{plansWaiting === 1 ? "Plan" : "Plans"}</Term>
                  </b>
                ) : null}{" "}
                {waiting + plansWaiting === 1 ? "waits" : "wait"} for review in{" "}
                {plural(withWaiting, "repository", "repositories")}.
              </>
            ) : (
              "Nothing waits for review."
            )}{" "}
            {rolling > 0 ? `${plural(rolling, "rollout")} in flight.` : null}
          </p>
        ) : null
      }
    >
      {importing.value ? (
        <ImportRepo
          onClose={() => {
            importing.value = false;
            if (window.location.hash === "#import")
              history.replaceState(null, "", window.location.pathname + window.location.search);
          }}
          onImported={() => res.reload()}
        />
      ) : null}
      {!settled ? (
        <div class="dash-loading" role="status" aria-live="polite" data-testid="dashboard-loading">
          <span class="sr-only">Loading your dashboard</span>
          {bandFirst ? band : null}
          <SkeletonHead />
          <SkeletonRows count={4} mark="none" />
          {bandFirst ? null : band}
        </div>
      ) : (
        <>
          {gsState && view ? (
            <GettingStarted
              state={gsState}
              view={view}
              onDismiss={onDismiss}
              onChanged={onChanged}
            />
          ) : null}
          {bandFirst ? band : null}
          {st.status === "error" ? (
            <ErrorState error={st.error} what="your repositories" onRetry={res.reload} />
          ) : null}
          {st.status === "ok" && repos.length === 0 && view?.mode !== "full" ? (
            <EmptyState icon="git-branch" title="No repositories yet">
              <p>
                Ask your agent to <code>use {window.location.origin}/start</code>
                {GITHUB_SURFACES ? (
                  <>
                    , connect the GitHub App in <a href="/settings/github">GitHub settings</a>,
                  </>
                ) : null}{" "}
                or ask a repo admin to add you. Changes then show up here by lane.
              </p>
            </EmptyState>
          ) : null}
          {st.status === "ok" && repos.length > 0 ? (
            <section class="repos" aria-labelledby="repos-title" data-testid="repo-list">
              <div class="repos__head">
                <h2 id="repos-title" class="repos__title">
                  Repositories
                </h2>
                <p class="repos__sum">
                  <span class="tnum">{repos.length}</span>, what waits for review first
                </p>
              </div>
              <div class="repo-cols" aria-hidden="true">
                <span>Repository</span>
                <span>Review</span>
                <span>Open by lane</span>
                <span>Auto-merge agreement</span>
              </div>
              <ul class="rows repo-list">
                {repos.map((r) => (
                  <RepoRow key={r.id} repo={r} />
                ))}
              </ul>
            </section>
          ) : null}
          {bandFirst ? null : band}
        </>
      )}
    </Page>
  );
}
