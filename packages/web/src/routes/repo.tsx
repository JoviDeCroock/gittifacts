import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { ChangeSummary, Plan, PrincipalRef, RepoDetail } from "../api/types.js";
import { BacktestCard } from "../components/BacktestCard.js";
import { IntentPanel } from "../components/IntentPanel.js";
import { Icon } from "../components/Icon.js";
import { paletteRepos } from "../components/Palette.js";
import { Page } from "../components/Shell.js";
import { Term } from "../components/Term.js";
import { Button, Command, EmptyState, ErrorState, LaneTag, LinkButton, Loading, Segmented, StatusChip, Who } from "../components/ui.js";
import { type ChangeFilter, FILTERS, LANES, type LaneGroup, groupByLane, matchesFilter, topReason } from "../lib/lanes.js";
import { cloneCommand } from "../lib/start.js";
import { relative, shortAge } from "../lib/time.js";
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
        <span class="change-row__title">
          {change.host ? <span class="change-row__pr tnum">#{change.host.number} </span> : null}
          {change.title}
        </span>
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

function groupTitle(group: LaneGroup<ChangeSummary>): { title: string; detail: string; calibrating?: boolean } {
  if (group.lane === null) return { title: "Not routed yet", detail: "Checks are still running or failing, so there is no lane or walkthrough yet." };
  const meta = LANES[group.lane];
  if (group.lane === 0 && group.shadow) {
    return {
      title: `${meta.name} (${meta.badge})`,
      calibrating: true,
      detail: "The evidence alone would auto-merge these. Auto-merge is calibrating, so they come to you, and your lane pick counts toward agreement.",
    };
  }
  return { title: `${meta.name} (${meta.badge})`, detail: meta.description };
}

function LaneSection({ group, now, showStatus }: { group: LaneGroup<ChangeSummary>; now: number; showStatus: boolean }) {
  const { title, detail, calibrating } = groupTitle(group);
  const id = `group-${group.key}`;
  return (
    <section class={`lane-group lane-group--${group.key}`} aria-labelledby={id}>
      <header class="lane-group__head">
        <LaneTag lane={group.lane} shadow={group.shadow} size="lg" />
        <div class="lane-group__text">
          <h2 id={id}>
            {title}
            {calibrating ? (
              <>
                {" · "}
                <Term id="calibrating" />
              </>
            ) : null}{" "}
            <span class="lane-group__count tnum">{group.items.length}</span>
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

/**
 * A plan waiting for approval. The heading above already says it waits, so the row says who
 * drafted it (an agent's square, a person's circle) and for how long.
 */
function PlanRow({ plan, author, now }: { plan: Plan; author: PrincipalRef | null; now: number }) {
  return (
    <li>
      <a class="plan-row" href={`/plans/${plan.id}`}>
        <Icon name="file-text" size={20} class="plan-row__icon" />
        <span class="plan-row__title">{plan.title}</span>
        <span class="plan-row__meta">
          {author ? <Who kind={author.kind} name={author.name} id={author.id} owner={author.ownerName ?? null} size={20} /> : null}
          <span>
            {plural(plan.acceptanceCriteria.length, "criterion", "criteria")} · {plural(plan.scopePaths.length, "scope path")}
          </span>
          <span>
            waiting <time dateTime={plan.createdAt}>{relative(plan.createdAt, now).replace(/ ago$/, "")}</time>
          </span>
        </span>
      </a>
    </li>
  );
}

/** Who drafted each plan (an agent with its person); the change list stands in if a lookup fails. */
function useAuthors(plans: Plan[], changes: ChangeSummary[]): Map<string, PrincipalRef> {
  const ids = [...new Set(plans.map((p) => p.authorId))].sort();
  const res = useResource(
    () =>
      Promise.all(
        ids.map(async (id): Promise<PrincipalRef | null> => {
          const c = changes.find((x) => x.authorId === id);
          const fallback = c ? { id, kind: c.authorKind, name: c.authorName, ownerId: null } : null;
          return api.principal(id).then((r) => r.principal, () => fallback);
        }),
      ),
    [ids.join(",")],
  );
  const st = res.state.value;
  return new Map(st.status === "ok" ? st.data.filter((p): p is PrincipalRef => p !== null).map((p) => [p.id, p]) : []);
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
      const { repo } = await api.setLane0(detail.repo.id, next, newIdempotencyKey());
      onChange({ ...detail, repo });
      confirm.value = false;
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <section class="lane0" aria-labelledby="lane0-title">
      <h2 id="lane0-title" class="sr-only">
        Auto-merge (Lane 0)
      </h2>
      <ShadowLine repo={{ policy: detail.repo.policy, shadow: detail.shadow }} />
      {isAdmin && (eligible || enabled) ? (
        <div class="lane0__actions">
          {confirm.value ? (
            <div class="lane0__confirm" role="group" aria-label="Confirm the auto-merge change">
              <p>
                {enabled
                  ? "Changes the evidence would auto-merge will go back to a quick review by a person. Nothing already merged changes."
                  : "Changes the evidence qualifies for auto-merge will merge without a person. Each still rolls out behind a flag with automatic revert."}
              </p>
              <div class="lane0__buttons">
                <Button variant="secondary" size="sm" onClick={() => (confirm.value = false)} disabled={busy.value}>
                  Cancel
                </Button>
                <Button variant={enabled ? "danger-outline" : "primary"} size="sm" busy={busy.value} busyLabel="Saving…" onClick={() => apply(!enabled)}>
                  {enabled ? "Turn auto-merge off (calibrate again)" : "Turn on auto-merge"}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant={enabled ? "secondary" : "primary"} size="sm" icon={enabled ? "pause" : "power"} onClick={() => (confirm.value = true)}>
              {enabled ? "Turn auto-merge off" : "Turn on auto-merge"}
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

interface RailPlan {
  plan: Plan;
  /** What the side rail says about it, in ink: "2 changes open", "Ready: no changes yet", "Superseded". */
  note: string;
}

const OPEN_CHANGE: ReadonlySet<ChangeSummary["status"]> = new Set(["awaiting-push", "running", "failing", "awaiting-review", "approved", "queued", "merged", "rolling-out"]);

/**
 * The side rail puts plans with work in flight first, then approved plans nobody has started,
 * and folds the finished and withdrawn ones away (finding 20: a wall of green said nothing).
 * Drafts are listed above the changes instead.
 */
function planRail(plans: Plan[], changes: ChangeSummary[]): { open: RailPlan[]; ready: RailPlan[]; done: RailPlan[] } {
  const open: RailPlan[] = [];
  const ready: RailPlan[] = [];
  const done: RailPlan[] = [];
  for (const plan of plans) {
    if (plan.status === "draft") continue;
    if (plan.status !== "approved") {
      done.push({ plan, note: PLAN_STATUS[plan.status].label });
      continue;
    }
    const mine = changes.filter((c) => c.planId === plan.id);
    const live = mine.filter((c) => OPEN_CHANGE.has(c.status));
    const review = live.filter((c) => c.status === "awaiting-review").length;
    if (live.length > 0) open.push({ plan, note: `${plural(live.length, "change")} open${review > 0 ? ` · ${review} to review` : ""}` });
    else if (mine.length === 0) ready.push({ plan, note: "Approved, no changes yet" });
    else done.push({ plan, note: `Done: ${plural(mine.length, "change")}` });
  }
  return { open, ready, done };
}

function PlanMini({ plans }: { plans: RailPlan[] }) {
  if (plans.length === 0) return null;
  return (
    <ul class="plan-mini">
      {plans.map(({ plan, note }) => (
        <li key={plan.id}>
          <a href={`/plans/${plan.id}`}>{plan.title}</a>
          <span class="plan-mini__note">{note}</span>
        </li>
      ))}
    </ul>
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
  const pl = plans.state.value;
  const drafts = pl.status === "ok" ? pl.data.plans.filter((p) => p.status === "draft") : [];
  const authors = useAuthors(drafts, st.status === "ok" ? st.data.changes : []);
  // The sidebar already knows the name: no "Repository" flash while the rest loads.
  const known = paletteRepos.value.find((r) => r.id === repoId)?.name ?? "Repository";

  if (st.status === "loading") {
    // The frame the data will fill (filter, lane groups, the side rail), so nothing jumps.
    return (
      <Page title={known} wide crumbs={[{ href: "/dashboard", label: "Dashboard" }]}>
        <div class="repo-layout">
          <div class="repo-layout__main">
            <section class="changes" aria-labelledby="changes-title">
              <div class="changes__bar">
                <h2 id="changes-title" class="changes__title">
                  Changes
                </h2>
                <Segmented label="Filter changes" value={filter} options={FILTERS.map((f) => ({ id: f.id, label: f.label }))} onChange={() => undefined} />
              </div>
              <Loading label="Loading changes" lines={8} />
            </section>
          </div>
          <aside class="repo-layout__side">
            <section class="side-block" aria-label="Plans">
              <h2 class="side-block__title">Plans</h2>
              <Loading label="Loading plans" lines={3} />
            </section>
          </aside>
        </div>
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title={known} crumbs={[{ href: "/dashboard", label: "Dashboard" }]}>
        <ErrorState error={st.error} what="this repository" onRetry={res.reload} />
      </Page>
    );
  }

  const { detail, changes } = st.data;
  const repo = detail.repo;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, changes.filter((c) => matchesFilter(c.status, f.id)).length])) as Record<ChangeFilter, number>;
  const visible = changes.filter((c) => matchesFilter(c.status, filter));
  const groups = groupByLane(visible, repo.policy.lane0Enabled);
  const rail = planRail(pl.status === "ok" ? pl.data.plans : [], changes);
  const agentsAtWork = changes.some((c) => c.authorKind === "agent" && !matchesFilter(c.status, "closed"));
  const clone = cloneCommand(window.location.origin, repo.id);

  return (
    <Page
      title={repo.name}
      wide
      actions={
        <>
          {/* GitHub mode: GitHub merges; the platform's queue is native only. Mission control only
              once agents have open Changes here (DESIGN.md, the Show It When It Matters Rule). */}
          {repo.host || !agentsAtWork ? null : (
            <LinkButton href={`/repos/${repoId}/mission`} size="sm" icon="bot">
              Mission control
            </LinkButton>
          )}
          {repo.host ? null : (
            <LinkButton href={`/repos/${repoId}/queue`} size="sm" icon="list-ordered">
              Merge queue
            </LinkButton>
          )}
          <LinkButton href={`/repos/${repoId}/members`} size="sm" icon="user">
            Members
          </LinkButton>
        </>
      }
      crumbs={[{ href: "/dashboard", label: "Dashboard" }]}
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
          {repo.claim.status === "unclaimed" ? (
            <span class="repo-unclaimed" data-testid="repo-unclaimed">
              <Term id="unclaimed" />: previews only and no auto-merge
              {repo.claim.expiresAt ? `, deleted ${relative(repo.claim.expiresAt, now)}` : ""} unless a person claims it with the claim link its agent was given.{" "}
              <a href="/docs/guides/claim-a-project">How to claim</a>
            </span>
          ) : null}
          {repo.policySha ? (
            <span>
              <Term id="policy" /> at <code>{repo.policySha.slice(0, 7)}</code>
            </span>
          ) : null}
        </>
      }
    >
      <div class="repo-layout">
        <div class="repo-layout__main">
          <IntentPanel repoId={repo.id} />
          {drafts.length > 0 ? (
            <section class="plans-waiting" aria-labelledby="plans-waiting">
              <h2 id="plans-waiting" class="plans-waiting__title">
                {plural(drafts.length, "plan")} {drafts.length === 1 ? "needs" : "need"} approval
              </h2>
              <p class="plans-waiting__lede">Agents cannot start work on a plan until a person other than its author approves it.</p>
              <ul class="plan-list">
                {drafts.map((p) => (
                  <PlanRow key={p.id} plan={p} author={authors.get(p.authorId) ?? null} now={now} />
                ))}
              </ul>
            </section>
          ) : null}

          <section class="changes" aria-labelledby="changes-title">
            <div class="changes__bar">
              <h2 id="changes-title" class="changes__title">
                <Term id="change">Changes</Term>
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
                <p data-testid="changes-empty">
                  Tell your agent what should change (above). It drafts a Plan for you to approve, then starts a Change in this repo. Each Change shows up here with its review
                  lane once its checks pass and the reviewer agent has written a walkthrough.
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
          {repo.host ? <BacktestCard repoId={repo.id} repoUrl={`https://github.com/${repo.host.owner}/${repo.host.repo}`} /> : null}
          <section class="side-block" aria-labelledby="all-plans">
            <h2 id="all-plans" class="side-block__title">
              <Term id="plan">Plans</Term>
            </h2>
            {pl.status === "loading" ? <Loading label="Loading plans" lines={3} /> : null}
            {pl.status === "error" ? <ErrorState error={pl.error} what="plans" onRetry={plans.reload} /> : null}
            {pl.status === "ok" && rail.open.length + rail.ready.length + rail.done.length === 0 ? (
              <p class="side-block__empty">
                {drafts.length === 0
                  ? "No plans yet. Write what should change and your agent drafts one for you to approve."
                  : `No approved plans yet. ${drafts.length === 1 ? "The plan" : "The plans"} waiting for approval ${drafts.length === 1 ? "is" : "are"} listed above the changes.`}
              </p>
            ) : null}
            <PlanMini plans={rail.open} />
            <PlanMini plans={rail.ready} />
            {rail.done.length > 0 ? (
              <details class="disclosure plan-done">
                <summary>
                  Done and withdrawn <span class="tnum plan-done__count">{rail.done.length}</span>
                  <Icon name="chevron-down" size={18} class="disclosure__chev" />
                </summary>
                <PlanMini plans={rail.done} />
              </details>
            ) : null}
          </section>
          <section class="side-block" aria-labelledby="clone-title" data-testid="repo-clone">
            <h2 id="clone-title" class="side-block__title">
              Clone
            </h2>
            <div class="clone__cmd">
              <Command text={clone} />
            </div>
          </section>
        </aside>
      </div>
    </Page>
  );
}
