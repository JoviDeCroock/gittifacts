/**
 * Internal: time-to-first-green (docs/prompts/02-onboarding.md §1). How long a new project takes
 * from `create_project` to a green first CI run with its preview serving, against the 60 s
 * target. Reads `GET /internal/ttfg` (human, repo:admin): Analytics Engine when the platform has
 * an API token for it, D1 otherwise.
 *
 * Form: a KPI row (median, share within target, volume), one horizontal bar per template (median,
 * with the p90 as a tick and the target as a rule), and the recent projects as a table, which is
 * also the chart's accessible table view. Bars are data ink (neutral): colour is reserved for
 * state, which is always spelled out ("Over target", "CI failed").
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { request } from "../api/client.js";
import { isMockMode } from "../api/mode.js";
import { Page } from "../components/Shell.js";
import { EmptyState, ErrorState, Loading, Meter, Segmented, StatusChip } from "../components/ui.js";
import { formatDateTime } from "../lib/time.js";
import type { StatusMeta } from "../lib/vocab.js";
import { useResource } from "../state/resource.js";
import "../styles/onboarding.css";

interface TtfgStats {
  projects: number;
  finished: number;
  green: number;
  withinTarget: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

interface TtfgProject {
  projectId: string;
  template: string | null;
  outcome: string | null;
  createdAt: string;
  msToRespond: number | null;
  msToGreen: number | null;
  msToPreview: number | null;
}

interface TtfgReport {
  source: "analytics-engine" | "d1";
  sinceDays: number;
  targetMs: number;
  overall: TtfgStats;
  byTemplate: Array<TtfgStats & { template: string }>;
  recent: TtfgProject[];
  note: string | null;
}

type Range = "7" | "30" | "90";

const OUTCOME: Record<string, StatusMeta> = {
  green: { label: "Green", tone: "ok", icon: "check-circle" },
  "ci-failed": { label: "CI failed", tone: "danger", icon: "x-circle" },
  "preview-failed": { label: "Preview failed", tone: "danger", icon: "triangle-alert" },
  "no-preview": { label: "Green, no preview", tone: "neutral", icon: "minus" },
};
const PENDING: StatusMeta = { label: "Running", tone: "neutral", icon: "loader" };

function seconds(ms: number | null): string {
  if (ms === null) return "–";
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;
}

/** Clean axis ticks every 15/30/60 s up to `max`. */
function ticks(maxMs: number): number[] {
  const step = maxMs <= 90_000 ? 15_000 : maxMs <= 180_000 ? 30_000 : 60_000;
  const out: number[] = [];
  for (let t = 0; t <= maxMs; t += step) out.push(t);
  return out;
}

function StatTile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="ttfg-tile">
      <p class="ttfg-tile__label">{label}</p>
      <p class="ttfg-tile__value">{value}</p>
      {children}
    </div>
  );
}

function TemplateBars({ report }: { report: TtfgReport }) {
  const rows = report.byTemplate.filter((t) => t.p50Ms !== null);
  if (rows.length === 0) return null;
  const max = Math.max(report.targetMs * 1.25, ...rows.map((r) => r.p90Ms ?? r.p50Ms ?? 0)) * 1.05;
  const x = (ms: number) => `${Math.min(100, (ms / max) * 100)}%`;
  return (
    <figure class="ttfg-bars">
      <figcaption class="sr-only">
        Median time to first green per template, with the 90th percentile and the target. The recent
        projects table below lists every value.
      </figcaption>
      <div class="ttfg-bars__row ttfg-bars__row--head" aria-hidden="true">
        <span />
        <span class="ttfg-bars__track">
          <span
            class="ttfg-bars__target-label tnum"
            style={{ insetInlineStart: x(report.targetMs) }}
          >
            {seconds(report.targetMs)} target
          </span>
        </span>
      </div>
      {rows.map((r) => {
        const over = (r.p50Ms ?? 0) > report.targetMs;
        const detail = `median ${seconds(r.p50Ms)}, p90 ${seconds(r.p90Ms)}, ${r.withinTarget} of ${r.green} within target`;
        // Focus shows the same readout as hover (tooltips never gate: the table has every value).
        return (
          <section
            class="ttfg-bars__row"
            key={r.template}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users get the hover readout
            tabIndex={0}
            aria-label={`${r.template}: ${detail}`}
          >
            <span class="ttfg-bars__name">
              {r.template}
              {over ? <span class="tone tone--danger ttfg-bars__flag">Over target</span> : null}
            </span>
            <span class="ttfg-bars__track">
              <span class="ttfg-bars__target" style={{ insetInlineStart: x(report.targetMs) }} />
              <span class="ttfg-bars__bar" style={{ inlineSize: x(r.p50Ms ?? 0) }} />
              {r.p90Ms !== null ? (
                <span class="ttfg-bars__p90" style={{ insetInlineStart: x(r.p90Ms) }} />
              ) : null}
              <span class="ttfg-bars__value tnum">{seconds(r.p50Ms)}</span>
              <span class="ttfg-bars__tip" role="tooltip">
                <b class="tnum">{seconds(r.p50Ms)}</b> median ·{" "}
                <span class="tnum">{seconds(r.p90Ms)}</span> p90
                <br />
                <span class="tnum">
                  {r.withinTarget} of {r.green}
                </span>{" "}
                within target · <span class="tnum">{r.projects}</span> created
              </span>
            </span>
          </section>
        );
      })}
      <div class="ttfg-bars__row ttfg-bars__row--axis" aria-hidden="true">
        <span class="ttfg-bars__unit">seconds</span>
        <span class="ttfg-bars__track">
          {ticks(max).map((t) => (
            <span key={t} class="ttfg-bars__tick tnum" style={{ insetInlineStart: x(t) }}>
              {Math.round(t / 1000)}
            </span>
          ))}
        </span>
      </div>
      <p class="ttfg-bars__legend">
        <span class="ttfg-key ttfg-key--bar" aria-hidden="true" /> median
        <span class="ttfg-key ttfg-key--tick" aria-hidden="true" /> 90th percentile
        <span class="ttfg-key ttfg-key--target" aria-hidden="true" /> target
      </p>
    </figure>
  );
}

function RecentTable({ rows, targetMs }: { rows: TtfgProject[]; targetMs: number }) {
  return (
    <div class="ttfg-table-wrap">
      <table class="ttfg-table">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Template</th>
            <th scope="col">Outcome</th>
            <th scope="col" class="num">
              Responded
            </th>
            <th scope="col" class="num">
              CI green
            </th>
            <th scope="col" class="num">
              Preview
            </th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const meta = (p.outcome !== null ? OUTCOME[p.outcome] : undefined) ?? PENDING;
            const slowest = Math.max(p.msToGreen ?? 0, p.msToPreview ?? 0);
            return (
              <tr key={p.projectId}>
                <td>
                  <a href={`/repos/${p.projectId}`}>{p.projectId}</a>
                </td>
                <td>{p.template ?? "empty"}</td>
                <td>
                  <StatusChip meta={meta} />
                  {p.outcome === "green" && slowest > targetMs ? (
                    <span class="tone tone--danger ttfg-table__over">over {seconds(targetMs)}</span>
                  ) : null}
                </td>
                <td class="num tnum">{seconds(p.msToRespond)}</td>
                <td class="num tnum">{seconds(p.msToGreen)}</td>
                <td class="num tnum">{seconds(p.msToPreview)}</td>
                <td class="tnum">{formatDateTime(p.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Demo data for the in-browser mock backend (screenshots, local UI work). */
function sampleReport(days: number): TtfgReport {
  const now = Date.now();
  const sample: Array<[string, string, number | null, number | null]> = [
    ["workers-api", "green", 34_200, 38_900],
    ["preact-app", "green", 41_000, 46_400],
    ["static-site", "green", 29_800, 33_100],
    ["ts-library", "no-preview", 31_500, null],
    ["workers-api", "green", 36_700, 41_200],
    ["preact-app", "green", 58_900, 71_300],
    ["workers-api", "ci-failed", null, null],
  ];
  const recent: TtfgProject[] = sample.map(([template, outcome, green, preview], i) => ({
    projectId: `prj${(1000 + i).toString(36)}`,
    template,
    outcome,
    createdAt: new Date(now - (i + 1) * 3_600_000).toISOString(),
    msToRespond: 900 + i * 37,
    msToGreen: green,
    msToPreview: preview,
  }));
  const stats = (rows: TtfgProject[]): TtfgStats => {
    const greens = rows
      .filter((r) => r.outcome === "green")
      .map((r) => Math.max(r.msToGreen ?? 0, r.msToPreview ?? 0))
      .sort((a, b) => a - b);
    const q = (p: number) =>
      greens.length === 0 ? null : (greens[Math.ceil(p * greens.length) - 1] ?? null);
    return {
      projects: rows.length,
      finished: rows.length,
      green: greens.length,
      withinTarget: greens.filter((g) => g <= 60_000).length,
      p50Ms: q(0.5),
      p90Ms: q(0.9),
    };
  };
  return {
    source: "d1",
    sinceDays: days,
    targetMs: 60_000,
    overall: stats(recent),
    byTemplate: ["preact-app", "static-site", "workers-api"].map((t) => ({
      template: t,
      ...stats(recent.filter((r) => r.template === t)),
    })),
    recent,
    note: "Demo data (mock backend)",
  };
}

export function OnboardingView() {
  const range = useSignal<Range>("30");
  const days = Number(range.value);
  const res = useResource(
    () =>
      isMockMode()
        ? Promise.resolve(sampleReport(days))
        : request<TtfgReport>("GET", `/internal/ttfg?days=${days}`),
    [days],
  );
  const st = res.state.value;

  return (
    <Page
      title="Time to first green"
      meta={
        <p class="ttfg-intro">
          From create_project to a green first CI run with its preview serving. Target: 60 seconds.
        </p>
      }
      wide
    >
      <div class="ttfg-filters">
        <Segmented<Range>
          label="Period"
          value={range.value}
          options={[
            { id: "7", label: "7 days" },
            { id: "30", label: "30 days" },
            { id: "90", label: "90 days" },
          ]}
          onChange={(v) => {
            range.value = v;
          }}
        />
      </div>
      {st.status === "loading" ? <Loading label="Loading onboarding metrics" lines={5} /> : null}
      {st.status === "error" ? (
        <ErrorState error={st.error} what="the onboarding metrics" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" ? <Report report={st.data} /> : null}
    </Page>
  );
}

function Report({ report }: { report: TtfgReport }) {
  const o = report.overall;
  if (o.projects === 0) {
    return (
      <EmptyState icon="timer" title="No projects yet">
        Nothing was created with create_project in the last {report.sinceDays} days.
      </EmptyState>
    );
  }
  const share = o.green === 0 ? 0 : o.withinTarget / o.green;
  return (
    <div class="stack">
      <section class="ttfg-kpis" aria-label="Summary">
        <StatTile label="Median time to first green" value={seconds(o.p50Ms)}>
          <p class="ttfg-tile__sub tnum">p90 {seconds(o.p90Ms)}</p>
        </StatTile>
        <StatTile
          label={`Within ${seconds(report.targetMs)}`}
          value={percent(o.withinTarget, o.green)}
        >
          <Meter
            value={share}
            threshold={0.9}
            thresholdLabel="90%"
            tone={o.green === 0 ? "neutral" : share >= 0.9 ? "ok" : "warn"}
            label={`${o.withinTarget} of ${o.green} green projects within the target`}
          />
          <p class="ttfg-tile__sub tnum">
            {o.withinTarget} of {o.green} green projects
          </p>
        </StatTile>
        <StatTile label="Projects created" value={String(o.projects)}>
          <p class="ttfg-tile__sub tnum">
            {o.finished} finished · {o.green} green
          </p>
        </StatTile>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>By template</h2>
          <span class="section-head__aside">Median, with the 90th percentile</span>
        </div>
        <TemplateBars report={report} />
      </section>

      <section class="section">
        <div class="section-head">
          <h2>Recent projects</h2>
          <span class="section-head__aside">
            {report.source === "analytics-engine" ? "From Analytics Engine" : "From D1"}
            {report.note ? ` · ${report.note}` : ""}
          </span>
        </div>
        <RecentTable rows={report.recent} targetMs={report.targetMs} />
      </section>
    </div>
  );
}
