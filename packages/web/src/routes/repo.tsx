import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { ApiError, api, describeError } from "../api/client.js";
import type { ChangeSummary, Plan, RepoDetail } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, LaneTag, Loading, Segmented, StatusChip, Who } from "../components/ui.js";
import { type ChangeFilter, FILTERS, LANES, type LaneGroup, groupByLane, matchesFilter, topReason } from "../lib/lanes.js";
import { shortAge } from "../lib/time.js";
import { CATEGORY_LABEL, CHANGE_STATUS, PLAN_STATUS, plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import { ShadowLine } from "./repos.js";
import "../styles/repo.css";

function ChangeRow({ change, now, showStatus }: { change: ChangeSummary; now: number; showStatus: boolean }) {
  const status = CHANGE_STATUS[change.status];
  const why = topReason(change.laneReasons, change.computedLane, change.lane);
  return (
    <li>
      <a class="change-row" href={`/changes/${change.id}`}>
        <span class="change-row__title">{change.title}</span>
        <span class="change-row__status">
          {showStatus || !why ? <StatusChip meta={status} /> : null}
          {why ? (
            <span class={`change-row__why ${why.shadow ? "is-shadow" : ""}`}>
              <b>{why.label}:</b> {why.message}
            </span>
          ) : null}
        </span>
        <span class="change-row__who">
          <Who kind={change.authorKind} name={change.authorName} size={20} compact />
          {change.authorKind === "agent" ? <span class="change-row__agent">agent</span> : null}
        </span>
        <span class="change-row__plan">
          {change.planTitle ? (
            <>
              <Icon name="file-text" size={14} />
              <span class="change-row__plan-title">{change.planTitle}</span>
            </>
          ) : (
            <span class="change-row__noplan">{CATEGORY_LABEL[change.claim.category] ?? change.claim.category}, no plan</span>
          )}
        </span>
        <time class="change-row__age tnum" dateTime={change.updatedAt} title={new Date(change.updatedAt).toLocaleString()}>
          {shortAge(change.updatedAt, now)}
        </time>
      </a>
    </li>
  );
}

function groupTitle(group: LaneGroup<ChangeSummary>): { title: string; detail: string } {
  if (group.lane === null) return { title: "Not routed yet", detail: "Checks are still running or failing, so there is no lane or tour yet." };
  const meta = LANES[group.lane];
  if (group.lane === 0 && group.shadow) {
    return {
      title: `${meta.name} · Shadow`,
      detail: "Evidence alone would auto-merge these. Shadow mode routes them to you, and your lane call trains agreement.",
    };
  }
  return { title: `${meta.name} · ${meta.short}`, detail: meta.description };
}

function LaneSection({ group, now, showStatus }: { group: LaneGroup<ChangeSummary>; now: number; showStatus: boolean }) {
  const { title, detail } = groupTitle(group);
  const id = `group-${group.key}`;
  return (
    <section class={`lane-group lane-group--${group.key}`} aria-labelledby={id}>
      <header class="lane-group__head">
        <LaneTag lane={group.lane} shadow={group.shadow} size="lg" />
        <div class="lane-group__text">
          <h2 id={id}>
            {title} <span class="lane-group__count tnum">{group.items.length}</span>
          </h2>
          <p>{detail}</p>
        </div>
      </header>
      <ul class="change-list">
        {group.items.map((c) => (
          <ChangeRow key={c.id} change={c} now={now} showStatus={showStatus} />
        ))}
      </ul>
    </section>
  );
}

function PlanRow({ plan, now }: { plan: Plan; now: number }) {
  return (
    <li>
      <a class="plan-row" href={`/plans/${plan.id}`}>
        <Icon name="file-text" size={20} class="plan-row__icon" />
        <span class="plan-row__title">{plan.title}</span>
        <span class="plan-row__meta">
          <StatusChip meta={PLAN_STATUS[plan.status]} />
          <span>
            {plural(plan.acceptanceCriteria.length, "criterion", "criteria")} · {plural(plan.scopePaths.length, "scope path")}
          </span>
          <time class="tnum" dateTime={plan.createdAt}>
            {shortAge(plan.createdAt, now)}
          </time>
        </span>
      </a>
    </li>
  );
}

function Lane0Control({ detail, onChange }: { detail: RepoDetail; onChange: (d: RepoDetail) => void }) {
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const confirm = useSignal(false);
  const me = principal.value;
  const isAdmin = me?.scopes.includes("repo:admin") ?? false;
  const enabled = detail.repo.policy.lane0Enabled;
  const eligible = detail.shadow.eligibleToEnableLane0;

  async function apply(next: boolean) {
    busy.value = true;
    error.value = null;
    try {
      const { repo } = await api.setLane0(detail.repo.id, next);
      onChange({ ...detail, repo });
      confirm.value = false;
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : describeError(err).detail;
    } finally {
      busy.value = false;
    }
  }

  return (
    <section class="lane0" aria-labelledby="lane0-title">
      <h2 id="lane0-title" class="sr-only">
        Lane 0
      </h2>
      <ShadowLine repo={{ policy: detail.repo.policy, shadow: detail.shadow }} />
      {isAdmin && (eligible || enabled) ? (
        <div class="lane0__actions">
          {confirm.value ? (
            <div class="lane0__confirm" role="group" aria-label="Confirm Lane 0 change">
              <p>
                {enabled
                  ? "Changes that compute Lane 0 will go back to a human glance. Nothing already merged changes."
                  : "Changes that compute Lane 0 will merge without a human. Each still rolls out behind a flag with automatic revert."}
              </p>
              <div class="lane0__buttons">
                <Button variant="secondary" size="sm" onClick={() => (confirm.value = false)} disabled={busy.value}>
                  Cancel
                </Button>
                <Button variant={enabled ? "danger-outline" : "primary"} size="sm" busy={busy.value} busyLabel="Saving…" onClick={() => apply(!enabled)}>
                  {enabled ? "Return Lane 0 to shadow mode" : "Turn on Lane 0"}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant={enabled ? "secondary" : "primary"} size="sm" icon={enabled ? "pause" : "power"} onClick={() => (confirm.value = true)}>
              {enabled ? "Return to shadow mode" : "Turn on Lane 0"}
            </Button>
          )}
          {error.value ? (
            <p class="field__error" role="alert">
              {error.value}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function RepoChanges({ repoId }: { repoId: string }) {
  const { query, route } = useLocation();
  const filter = (FILTERS.some((f) => f.id === query.filter) ? query.filter : "review") as ChangeFilter;
  const res = useResource(async () => {
    const [detail, list] = await Promise.all([api.repo(repoId), api.changes(repoId)]);
    return { detail, changes: list.changes };
  }, [repoId]);
  const plans = useResource(() => api.repoPlans(repoId), [repoId]);
  const st = res.state.value;
  const now = minuteClock.value;

  if (st.status === "loading") {
    return (
      <Page title="Repository" crumbs={[{ href: "/", label: "Repositories" }]}>
        <Loading label="Loading changes" lines={8} />
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title="Repository" crumbs={[{ href: "/", label: "Repositories" }]}>
        <ErrorState error={st.error} what="this repository" onRetry={res.reload} />
      </Page>
    );
  }

  const { detail, changes } = st.data;
  const repo = detail.repo;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, changes.filter((c) => matchesFilter(c.status, f.id)).length])) as Record<ChangeFilter, number>;
  const visible = changes.filter((c) => matchesFilter(c.status, filter));
  const groups = groupByLane(visible, repo.policy.lane0Enabled);
  const pl = plans.state.value;
  const drafts = pl.status === "ok" ? pl.data.plans.filter((p) => p.status === "draft") : [];
  const others = pl.status === "ok" ? pl.data.plans.filter((p) => p.status !== "draft") : [];

  return (
    <Page
      title={repo.name}
      wide
      crumbs={[{ href: "/", label: "Repositories" }]}
      meta={
        <>
          <span>
            {repo.namespace} · {repo.defaultBranch}
          </span>
          <span>{repo.jurisdiction === "unrestricted" ? "Any region" : `Data stays in ${repo.jurisdiction.toUpperCase()}`}</span>
          {repo.deployTarget ? (
            <span>
              Deploys <code>{repo.deployTarget}</code>
            </span>
          ) : null}
          {repo.policySha ? (
            <span title="Policy is read from the default branch">
              Policy at <code>{repo.policySha.slice(0, 7)}</code>
            </span>
          ) : null}
        </>
      }
    >
      <div class="repo-layout">
        <div class="repo-layout__main">
          {drafts.length > 0 ? (
            <section class="plans-waiting" aria-labelledby="plans-waiting">
              <h2 id="plans-waiting" class="plans-waiting__title">
                {plural(drafts.length, "plan")} {drafts.length === 1 ? "needs" : "need"} approval
              </h2>
              <p class="plans-waiting__lede">Agents cannot start work on a plan until a person other than its author approves it.</p>
              <ul class="plan-list">
                {drafts.map((p) => (
                  <PlanRow key={p.id} plan={p} now={now} />
                ))}
              </ul>
            </section>
          ) : null}

          <section class="changes" aria-labelledby="changes-title">
            <div class="changes__bar">
              <h2 id="changes-title" class="changes__title">
                Changes
              </h2>
              <Segmented
                label="Filter changes"
                value={filter}
                options={FILTERS.map((f) => ({ id: f.id, label: f.label, count: counts[f.id] }))}
                onChange={(id) => route(`/repos/${repoId}${id === "review" ? "" : `?filter=${id}`}`, true)}
              />
            </div>
            {changes.length === 0 ? (
              <EmptyState icon="git-branch" title="No changes yet">
                <p>
                  Agents start changes against an approved plan through the API or MCP (<code>POST /api/v1/changes</code>). Each one shows up here with its lane once
                  its checks pass and the reviewer agent has written a tour.
                </p>
              </EmptyState>
            ) : groups.length === 0 ? (
              <EmptyState
                icon="check-circle"
                title={filter === "review" ? "Nothing waits for your review" : `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} changes`}
                action={
                  <Button variant="secondary" size="sm" onClick={() => route(`/repos/${repoId}?filter=all`, true)}>
                    Show all changes
                  </Button>
                }
              />
            ) : (
              groups.map((g) => <LaneSection key={g.key} group={g} now={now} showStatus={filter !== "review"} />)
            )}
          </section>
        </div>

        <aside class="repo-layout__side">
          <Lane0Control detail={detail} onChange={(d) => res.set({ detail: d, changes })} />
          <section class="side-block" aria-labelledby="all-plans">
            <h2 id="all-plans" class="side-block__title">
              Plans
            </h2>
            {pl.status === "loading" ? <Loading label="Loading plans" lines={3} /> : null}
            {pl.status === "error" ? <ErrorState error={pl.error} what="plans" onRetry={plans.reload} /> : null}
            {pl.status === "ok" && others.length === 0 && drafts.length === 0 ? <p class="side-block__empty">No plans yet. Agents and people draft them through the API.</p> : null}
            {others.length > 0 ? (
              <ul class="plan-mini">
                {others.map((p) => (
                  <li key={p.id}>
                    <a href={`/plans/${p.id}`}>{p.title}</a>
                    <span class={`tone tone--${PLAN_STATUS[p.status].tone}`}>{PLAN_STATUS[p.status].label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </aside>
      </div>
    </Page>
  );
}
