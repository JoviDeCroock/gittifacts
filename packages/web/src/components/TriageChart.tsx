/**
 * "Why this lane" as a banded observation chart. One row per signal; the marker sits in the
 * column of the minimum lane that signal forces. The lane is the rightmost marker. Unknown
 * signals are hollow and plotted where they escalate to, because unknown never reads as good.
 */
import type { Lane, LaneReason } from "@app/domain";
import { itemAnchor } from "../lib/evidence.js";
import { LANES, type ChartRow, triageChart } from "../lib/lanes.js";
import { LaneTag } from "./ui.js";
import "../styles/triage.css";

const COLS: Lane[] = [0, 1, 2];

function Marker({ row }: { row: ChartRow }) {
  const cls = row.unknown ? "tm tm--unknown" : row.decisive ? `tm tm--decisive tm--l${row.lane}` : "tm tm--minor";
  return (
    <span class={cls}>
      <span class="sr-only">
        {row.unknown ? "Not measured, escalates to " : "Forces at least "}
        {LANES[row.lane].name}
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
}

export function TriageChart({ reasons, computedLane, lane, changeId, caption }: TriageChartProps) {
  const chart = triageChart(reasons, computedLane, lane);
  const routedMeta = LANES[chart.routedLane];
  return (
    <figure class="triage">
      <div class="triage__grid" role="table" aria-label={caption ?? `Why this change is in ${routedMeta.name}`}>
        <div class="triage__row triage__row--head" role="row">
          <span class="triage__label" role="columnheader">
            Signal
          </span>
          {COLS.map((l) => (
            <span key={l} class={`triage__cell triage__cell--l${l}`} role="columnheader">
              <LaneTag lane={l} size="sm" />
            </span>
          ))}
        </div>
        {chart.rows.map((row) => (
          <div class={`triage__row ${row.decisive ? "is-decisive" : ""}`} role="row" key={row.reason.code}>
            <div class="triage__label" role="rowheader">
              <span class="triage__family">{row.label}</span>
              {row.reason.evidenceRef && changeId ? (
                <a class="triage__msg" href={`/changes/${changeId}/evidence#${itemAnchor(row.reason.evidenceRef)}`}>
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
        ))}
        <div class="triage__row triage__row--total" role="row">
          <div class="triage__label" role="rowheader">
            <span class="triage__family">Evidence computes</span>
            <span class="triage__msg">The highest lane any signal forces.</span>
          </div>
          {COLS.map((l) => (
            <span key={l} class={`triage__cell triage__cell--l${l}`} role="cell">
              {chart.computedLane === l ? <LaneTag lane={l} size="md" shadow={chart.shadowRaised && l === 0} /> : null}
            </span>
          ))}
        </div>
        {chart.shadowRaised ? (
          <div class="triage__row triage__row--total triage__row--shadow" role="row">
            <div class="triage__label" role="rowheader">
              <span class="triage__family">Shadow mode routes to</span>
              <span class="triage__msg">{chart.shadowReason?.message ?? "Lane 0 is not enabled for this repo yet."}</span>
            </div>
            {COLS.map((l) => (
              <span key={l} class={`triage__cell triage__cell--l${l}`} role="cell">
                {chart.routedLane === l ? <LaneTag lane={l} size="md" /> : chart.computedLane === l ? <span class="triage__arrow" aria-hidden="true" /> : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  );
}
