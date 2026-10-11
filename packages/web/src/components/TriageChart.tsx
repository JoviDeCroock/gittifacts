/**
 * "Why this lane" as a banded observation chart. One row per signal; the marker sits in the
 * column of the minimum lane that signal forces. The lane is the rightmost marker. Unknown
 * signals are hollow and plotted where they escalate to, because unknown never reads as good.
 * The reasons that set the lane come first, then the ones that raised it; the checks that passed
 * fold into "N checks passed" under the result (foldChart, @app/domain groupLaneReasons).
 */
// The chart is a CSS grid with ARIA table semantics on purpose: <table>/<tr>/<td> cannot carry the
// banded grid layout, and a static table's rows and cells are not widgets, so they take no focus.
// biome-ignore-all lint/a11y/useSemanticElements: ARIA table roles on the CSS-grid chart (see above)
// biome-ignore-all lint/a11y/useFocusableInteractive: rows and cells of a static ARIA table are not focusable widgets
import type { Lane, LaneReason } from "@app/domain";
import { itemAnchor } from "../lib/evidence.js";
import { type ChartRow, foldChart, LANES, laneTitle, triageChart } from "../lib/lanes.js";
import { plural } from "../lib/vocab.js";
import { Icon } from "./Icon.js";
import { LaneTag } from "./ui.js";
import "../styles/triage.css";

const COLS: Lane[] = [0, 1, 2];
const COL_WORD: Record<Lane, string> = { 0: "auto", 1: "quick", 2: "full" };

function Marker({ row }: { row: ChartRow }) {
  const cls = row.unknown
    ? "tm tm--unknown"
    : row.decisive
      ? `tm tm--decisive tm--l${row.lane}`
      : "tm tm--minor";
  return (
    <span class={cls}>
      <span class="sr-only">
        {row.unknown ? "Not measured, escalates to " : "Forces at least "}
        {laneTitle(row.lane)}
      </span>
    </span>
  );
}

interface TriageChartProps {
  reasons: LaneReason[];
  computedLane: Lane | null;
  lane: Lane | null;
  /** When set, rows with an evidenceRef link to the evidence detail. */
  changeId?: string;
  caption?: string;
  /** Fold the passing checks under the result (default). The landing shows every row. */
  foldPassing?: boolean;
}

function Row({ row, changeId }: { row: ChartRow; changeId?: string }) {
  return (
    <div
      class={`triage__row ${row.decisive ? "is-decisive" : ""}`}
      role="row"
      data-testid="triage-row"
      data-lane={row.lane}
    >
      <div class="triage__label" role="rowheader">
        <span class="triage__family">{row.label}</span>
        {row.reason.evidenceRef && changeId ? (
          <a
            class="triage__msg"
            href={`/changes/${changeId}/evidence#${itemAnchor(row.reason.evidenceRef)}`}
          >
            {row.reason.message}
          </a>
        ) : (
          <span class="triage__msg">{row.reason.message}</span>
        )}
      </div>
      {COLS.map((l) => (
        <span key={l} class={`triage__cell triage__cell--l${l}`} role="cell">
          {row.lane === l ? <Marker row={row} /> : null}
        </span>
      ))}
    </div>
  );
}

export function TriageChart({
  reasons,
  computedLane,
  lane,
  changeId,
  caption,
  foldPassing = true,
}: TriageChartProps) {
  const chart = triageChart(reasons, computedLane, lane);
  const fold = foldPassing ? foldChart(chart.rows) : { shown: chart.rows, passing: [] };
  const routedMeta = LANES[chart.routedLane];
  return (
    <figure class="triage">
      <div
        class="triage__grid"
        role="table"
        aria-label={
          caption ?? `Why this change gets ${routedMeta.name.toLowerCase()} (${routedMeta.badge})`
        }
      >
        <div class="triage__row triage__row--head" role="row">
          <span class="triage__label" role="columnheader">
            Reason
          </span>
          {COLS.map((l) => (
            <span
              key={l}
              class={`triage__cell triage__cell--l${l} triage__colhead`}
              role="columnheader"
            >
              <LaneTag lane={l} size="sm" />
              <span class="triage__colword" aria-hidden="true">
                {COL_WORD[l]}
              </span>
            </span>
          ))}
        </div>
        {fold.shown.map((row) => (
          <Row key={row.reason.code} row={row} changeId={changeId} />
        ))}
        <div class="triage__row triage__row--total" role="row">
          <div class="triage__label" role="rowheader">
            <span class="triage__family">Evidence computes</span>
            <span class="triage__msg">The highest lane any reason forces.</span>
          </div>
          {COLS.map((l) => (
            <span key={l} class={`triage__cell triage__cell--l${l}`} role="cell">
              {chart.computedLane === l ? (
                <LaneTag lane={l} size="md" shadow={chart.shadowRaised && l === 0} />
              ) : null}
            </span>
          ))}
        </div>
        {chart.shadowRaised ? (
          <div class="triage__row triage__row--total triage__row--shadow" role="row">
            <div class="triage__label" role="rowheader">
              <span class="triage__family">Calibrating, so routed to</span>
              <span class="triage__msg">
                {chart.shadowReason?.message ?? "Auto-merge is not on for this repo yet."}
              </span>
            </div>
            {COLS.map((l) => (
              <span key={l} class={`triage__cell triage__cell--l${l}`} role="cell">
                {chart.routedLane === l ? (
                  <LaneTag lane={l} size="md" />
                ) : chart.computedLane === l ? (
                  <span class="triage__arrow" aria-hidden="true" />
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {fold.passing.length > 0 ? (
        <details class="disclosure triage__passed" data-testid="triage-passed">
          <summary>
            <Icon name="check-circle" size={16} class="tone--ok" />
            {plural(fold.passing.length, "check")} passed
            <Icon name="chevron-down" class="disclosure__chev" />
          </summary>
          <div class="triage__grid" role="table" aria-label="Checks that passed">
            {fold.passing.map((row) => (
              <Row key={row.reason.code} row={row} changeId={changeId} />
            ))}
          </div>
        </details>
      ) : null}
    </figure>
  );
}
