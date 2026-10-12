/**
 * Commit activity (`/repos/:repoId/activity`): commits per day by when they landed, over whole
 * weeks, as a calendar in one ink ramp (a count is ink, never teal or a lane band), with a readout
 * for the day under the pointer or finger, a table view, the totals and the top authors. Agents:
 * `get_commit_activity`.
 */
import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { type CommitActivity, codeApi } from "../api/code.js";
import { RepoTabs } from "../components/RepoTabs.js";
import { Page } from "../components/Shell.js";
import { ErrorState, Loading, Segmented } from "../components/ui.js";
import {
  type ActivityCell,
  activityGrid,
  activityHref,
  dayLabel,
  weeklyTotals,
} from "../lib/code.js";
import { plural } from "../lib/vocab.js";
import { useResource } from "../state/resource.js";
import { NothingLanded, useRepoName } from "./code.js";
import "../styles/code.css";

const RANGES = [
  { id: "13", label: "3 months" },
  { id: "26", label: "6 months" },
  { id: "52", label: "1 year" },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

function readout(cell: ActivityCell): string {
  return `${plural(cell.commits, "commit")} on ${dayLabel(cell.date)}`;
}

function Calendar({ activity }: { activity: CommitActivity }) {
  const grid = activityGrid(activity);
  const picked = useSignal<ActivityCell | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The newest weeks matter most: a narrow screen starts scrolled to today.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [activity.from, activity.to]);
  const busiest = activity.days.reduce<ActivityCell | null>(
    (best, d) => (d.commits > (best?.commits ?? 0) ? { ...d, level: 4 } : best),
    null,
  );
  const shown = picked.value ?? null;
  return (
    <figure class="calendar" data-testid="activity-calendar">
      <div
        class="calendar__scroll scroll-x"
        ref={scroller}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable chart must be keyboard-focusable (axe scrollable-region-focusable)
        tabIndex={0}
        role="img"
        aria-label={`${plural(activity.total, "commit")} from ${dayLabel(activity.from)} to ${dayLabel(activity.to)}${busiest ? `; the busiest day was ${readout(busiest)}` : ""}. The table below lists every week.`}
        onPointerLeave={() => (picked.value = null)}
      >
        <div
          class="calendar__grid"
          style={{ "--weeks": String(grid.weeks.length) } as Record<string, string>}
        >
          <span class="calendar__corner" aria-hidden="true" />
          {grid.weeks.map((_, col) => {
            const m = grid.months.find((x) => x.column === col);
            return (
              <span key={`m${col}`} class="calendar__month" aria-hidden="true">
                {m?.label ?? ""}
              </span>
            );
          })}
          {WEEKDAYS.map((wd, row) => (
            <Fragment key={`r${row}`}>
              <span class="calendar__weekday" aria-hidden="true">
                {wd}
              </span>
              {grid.weeks.map((week, col) => {
                const cell = week[row] ?? null;
                return cell === null ? (
                  <span
                    key={`${col}-${row}`}
                    class="calendar__cell calendar__cell--none"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    key={`${col}-${row}`}
                    class={`calendar__cell heat-${cell.level} ${shown?.date === cell.date ? "is-picked" : ""}`}
                    title={readout(cell)}
                    aria-hidden="true"
                    data-date={cell.date}
                    data-commits={cell.commits}
                    onPointerEnter={() => (picked.value = cell)}
                    onClick={() => (picked.value = cell)}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <figcaption class="calendar__foot">
        <span class="calendar__readout tnum" aria-live="polite" data-testid="activity-readout">
          {shown ? readout(shown) : "Point at a day for its count."}
        </span>
        <span class="calendar__key" aria-hidden="true">
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} class={`calendar__cell heat-${l}`} />
          ))}
          More
        </span>
      </figcaption>
    </figure>
  );
}

function Totals({ activity }: { activity: CommitActivity }) {
  const active = activity.days.filter((d) => d.commits > 0).length;
  const busiest = activity.days.reduce((b, d) => (d.commits > b.commits ? d : b), {
    date: "",
    commits: 0,
  });
  return (
    <dl class="activity-totals" data-testid="activity-totals">
      <div>
        <dt>Commits</dt>
        <dd class="tnum">
          {activity.truncated ? "at least " : ""}
          {activity.total.toLocaleString()}
        </dd>
      </div>
      <div>
        <dt>Days with commits</dt>
        <dd class="tnum">
          {active} of {activity.days.length}
        </dd>
      </div>
      <div>
        <dt>Busiest day</dt>
        <dd class="tnum">
          {busiest.commits > 0 ? `${busiest.commits} on ${dayLabel(busiest.date)}` : "None yet"}
        </dd>
      </div>
    </dl>
  );
}

function Authors({ activity }: { activity: CommitActivity }) {
  if (activity.authors.length === 0) return null;
  const top = activity.authors[0]?.commits ?? 1;
  return (
    <section class="activity-authors" aria-labelledby="authors-title">
      <h2 id="authors-title" class="code-section__title">
        Who committed
      </h2>
      <ol>
        {activity.authors.map((a) => (
          <li key={a.name}>
            <span class="activity-authors__name">{a.name}</span>
            <span class="activity-authors__bar" aria-hidden="true">
              <span style={{ inlineSize: `${Math.max(4, (a.commits / top) * 100)}%` }} />
            </span>
            <span class="activity-authors__n tnum">{plural(a.commits, "commit")}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function WeekTable({ activity }: { activity: CommitActivity }) {
  return (
    <details class="disclosure activity-table">
      <summary>Commits per week as a table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Commits</th>
          </tr>
        </thead>
        <tbody>
          {weeklyTotals(activity)
            .reverse()
            .map((w) => (
              <tr key={w.week}>
                <td>{dayLabel(w.week)}</td>
                <td class="tnum">{w.commits}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </details>
  );
}

export function ActivityView({ repoId }: { repoId: string }) {
  const { query, route } = useLocation();
  const refName = query.ref || undefined;
  const range: RangeId = RANGES.some((r) => r.id === query.weeks) ? (query.weeks as RangeId) : "26";
  const repoName = useRepoName(repoId);
  const res = useResource(
    () => codeApi.activity(repoId, { ref: refName, weeks: Number(range) }),
    [repoId, refName, range],
  );
  const st = res.state.value;
  return (
    <Page title={repoName} wide crumbs={[{ href: "/dashboard", label: "Dashboard" }]}>
      <RepoTabs repoId={repoId} current="activity" />
      <div class="activity-bar">
        <h2 class="code-section__title">
          Commit activity
          {st.status === "ok" ? (
            <>
              {" "}
              on <code>{st.data.ref}</code>
            </>
          ) : null}
        </h2>
        <Segmented
          label="Time range"
          size="sm"
          value={range}
          options={RANGES.map((r) => ({ id: r.id, label: r.label }))}
          onChange={(id) => {
            const href = activityHref(repoId, refName);
            route(`${href}${href.includes("?") ? "&" : "?"}weeks=${id}`, true);
          }}
        />
      </div>
      {st.status === "loading" ? <Loading label="Loading activity" lines={6} /> : null}
      {st.status === "error" ? (
        <ErrorState error={st.error} what="the activity" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" && st.data.headSha === null ? <NothingLanded repoId={repoId} /> : null}
      {st.status === "ok" && st.data.headSha !== null ? (
        <>
          <Totals activity={st.data} />
          {st.data.truncated ? (
            <p class="code-note" role="note">
              Not complete: only the newest 1,000 commits were read, and the window reaches further
              back. The counts are a lower bound.
            </p>
          ) : null}
          <Calendar activity={st.data} />
          <WeekTable activity={st.data} />
          <Authors activity={st.data} />
          <p class="code-foot">
            Days are UTC and count each commit on the day it landed on the branch.
          </p>
        </>
      ) : null}
    </Page>
  );
}
