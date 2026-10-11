/**
 * The tour: the main review surface. Read mode inside an Operate shell.
 * Phone: one column, sticky station strip on top, decision bar in the thumb zone.
 * Desktop: reading column plus a sticky rail with the lane chart and the decision panel.
 */
import type { Change, Principal, Tour, TourStop } from "@app/domain";
import type { EvidenceItem } from "@app/evidence";
import { useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { ApiError, api, inlineError, newIdempotencyKey, request } from "../api/client.js";
import { describesResolution, fetchResolution, type ResolutionView } from "../api/resolution.js";
import type { ChangeDiff, EvidenceResponse, PipelineRun, PrincipalRef, RepoDetail, ReviewDecisionKind } from "../api/types.js";
import { DecisionPanel } from "../components/DecisionPanel.js";
import { DiffExcerpt, WholeDiff } from "../components/DiffExcerpt.js";
import { EvidenceChip, MissingChip, RedGreenList, ShotPair } from "../components/EvidenceBits.js";
import { Icon } from "../components/Icon.js";
import { Prose } from "../components/Prose.js";
import { QaPanel } from "../components/QaPanel.js";
import { ResolutionPanel } from "../components/ResolutionPanel.js";
import { Page } from "../components/Shell.js";
import { TriageChart } from "../components/TriageChart.js";
import { Button, ErrorState, LaneTag, Loading, StatusChip, VerdictBadge, VerdictMark, Who } from "../components/ui.js";
import { findItem } from "../lib/evidence.js";
import { LANES, noTourCopy, triageChart, unroutedCopy } from "../lib/lanes.js";
import { relative, stepTime } from "../lib/time.js";
import { CATEGORY_LABEL, CHANGE_STATUS, plural, ROLLOUT_STATUS, STOP_KIND, shortSha, VERDICT } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { usePageCommands } from "../state/keys.js";
import { prefersReducedMotion } from "../state/media.js";
import { readTourProgress, writeTourProgress } from "../state/prefs.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import "../styles/tour.css";

interface TourData {
  change: Change;
  plan: Awaited<ReturnType<typeof api.change>>["plan"];
  runs: PipelineRun[];
  repo: RepoDetail;
  tour: Tour | null;
  diff: ChangeDiff | null;
  evidence: EvidenceResponse | null;
  evidenceError: unknown;
  /** The merge queue's resolution: what lands instead of the pushed head (null: none). */
  resolution: ResolutionView | null;
  resolutionError: unknown;
  author: PrincipalRef | null;
  approver: PrincipalRef | null;
  /** The agent that wrote the walkthrough, a separate principal from the author (null: unknown). */
  reviewer: PrincipalRef | null;
}

const notFoundToNull = (err: unknown) => {
  if (err instanceof ApiError && err.status === 404) return null;
  throw err;
};

async function loadTour(changeId: string): Promise<TourData> {
  const detail = await api.change(changeId);
  const c = detail.change;
  let evidenceError: unknown = null;
  let resolutionError: unknown = null;
  const tourP = api.tour(changeId).then((r) => r.tour, notFoundToNull);
  // The reviewer is named in the handover; an unknown principal stays "the reviewer agent".
  const reviewerP = tourP.then(
    (t) =>
      t
        ? api.principal(t.generatedBy.principalId).then(
            (r) => r.principal,
            () => null,
          )
        : null,
    () => null,
  );
  const [repo, tour, diff, evidence, author, approver, resolution, reviewer] = await Promise.all([
    api.repo(c.repoId),
    tourP,
    api.diff(changeId).then((r) => r.diff, notFoundToNull),
    api.evidence(changeId).catch((err: unknown) => {
      if (!(err instanceof ApiError && err.status === 404)) evidenceError = err;
      return null;
    }),
    api.principal(c.authorId).then(
      (r) => r.principal,
      () => null,
    ),
    detail.plan?.approvedBy
      ? api.principal(detail.plan.approvedBy).then(
          (r) => r.principal,
          () => null,
        )
      : Promise.resolve(null),
    fetchResolution(changeId).catch((err: unknown) => {
      resolutionError = err;
      return null;
    }),
    reviewerP,
  ]);
  return {
    change: c,
    plan: detail.plan,
    runs: detail.runs,
    repo,
    tour,
    diff,
    evidence,
    evidenceError,
    resolution,
    resolutionError,
    author,
    approver,
    reviewer,
  };
}

// ---------------------------------------------------------------- station strip

interface StripProps {
  tour: Tour;
  current: number;
  onJump: (i: number) => void;
  resumeAt: number | null;
  onResume: () => void;
  announce: string;
  inert: boolean;
}

function StationStrip({ tour, current, onJump, resumeAt, onResume, announce, inert }: StripProps) {
  const n = tour.stops.length;
  return (
    <nav class={`stations ${resumeAt !== null ? "stations--resume" : ""}`} aria-label="Walkthrough stops" inert={inert}>
      <div class="stations__inner">
        {/* The count stays put while you scroll; only a jump (J/K, a station, Resume) is announced. */}
        <span class="stations__count tnum" data-testid="stations-count">
          Stop <b>{current + 1}</b> of {n}
        </span>
        <span class="sr-only" aria-live="polite" aria-atomic="true">
          {announce}
        </span>
        <ol class="stations__line">
          {tour.stops.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                class="station"
                aria-current={i === current ? "step" : undefined}
                aria-label={`Stop ${i + 1} of ${n}: ${s.title}. ${VERDICT[s.verdict].label}.`}
                title={`${i + 1}. ${s.title}`}
                onClick={() => onJump(i)}
              >
                <VerdictMark verdict={s.verdict} size={i === current ? 22 : 18} />
              </button>
            </li>
          ))}
        </ol>
        {resumeAt !== null ? (
          <button type="button" class="stations__resume" onClick={onResume} data-testid="stations-resume">
            <Icon name="undo" size={15} />
            Resume at stop {resumeAt + 1}
          </button>
        ) : null}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- lane block

function LaneBlock({ change, open, rail = false }: { change: Change; open: boolean; rail?: boolean }) {
  const chart = triageChart(change.laneReasons, change.computedLane, change.lane);
  if (change.lane === null) {
    const copy = unroutedCopy(change.status, change.id);
    return (
      <section class="lane-block lane-block--none" data-testid="lane-block">
        <LaneTag lane={null} size="lg" />
        <div>
          <h2 class="lane-block__title">{copy.title}</h2>
          <p class="lane-block__line">{copy.line}</p>
        </div>
      </section>
    );
  }
  const routed = LANES[chart.routedLane];
  const why = chart.shadowRaised
    ? `The evidence alone says ${LANES[chart.computedLane].name.toLowerCase()}. Auto-merge is calibrating on this repo, so a person approves it.`
    : (chart.rows.find((r) => r.decisive)?.reason.message ?? "Every reason allows this lane.");
  return (
    <section
      data-testid="lane-block"
      class={`lane-block lane-block--l${chart.routedLane} ${rail ? "lane-block--rail" : ""}`}
      aria-labelledby={rail ? "lane-title-rail" : "lane-title"}
    >
      <div class="lane-block__head">
        <LaneTag lane={chart.routedLane} size="lg" />
        <div>
          <h2 class="lane-block__title" id={rail ? "lane-title-rail" : "lane-title"}>
            {routed.name} <span class="lane-block__badge">({routed.badge})</span>
          </h2>
          <p class="lane-block__line lane-block__line--clamp" title={why.length > 160 ? why : undefined}>
            {why}
          </p>
        </div>
      </div>
      <details class="disclosure lane-block__why" open={open}>
        <summary>
          Why {routed.name.toLowerCase()}
          <span class="lane-block__n">{plural(chart.rows.length, "reason")}</span>
          <Icon name="chevron-down" class="disclosure__chev" />
        </summary>
        <TriageChart reasons={change.laneReasons} computedLane={change.computedLane} lane={change.lane} changeId={change.id} />
      </details>
    </section>
  );
}

// ---------------------------------------------------------------- context links

function ContextLinks({ data }: { data: TourData }) {
  const { change, plan, evidence, approver } = data;
  const verified = evidence?.verification.ok ?? false;
  return (
    <ul class="ctx-links">
      {plan ? (
        <li>
          <a href={`/plans/${plan.id}`} class="ctx-link">
            <Icon name="file-text" />
            <span class="ctx-link__text">
              <span class="ctx-link__label">Plan</span>
              <span class="ctx-link__value">{plan.title}</span>
              <span class="ctx-link__sub">
                {plan.approvedAt ? `Approved by ${approver?.name ?? "a reviewer"} ${relative(plan.approvedAt, minuteClock.value)}` : "Not approved yet"}
              </span>
            </span>
            <Icon name="chevron-right" class="ctx-link__chev" />
          </a>
        </li>
      ) : (
        <li class="ctx-link ctx-link--static">
          <Icon name="file-text" />
          <span class="ctx-link__text">
            <span class="ctx-link__label">Plan</span>
            <span class="ctx-link__value">
              None.{" "}
              {change.claim.category === "transform" || change.claim.category === "revert" ? "Policy allows this category without one." : "This change was started without a plan."}
            </span>
          </span>
        </li>
      )}
      <li>
        <a href={`/changes/${change.id}/evidence`} class="ctx-link">
          <Icon name={evidence ? (verified ? "shield-check" : "shield-alert") : "circle-dashed"} class={evidence ? (verified ? "tone--ok" : "tone--danger") : ""} />
          <span class="ctx-link__text">
            <span class="ctx-link__label">Evidence</span>
            <span class="ctx-link__value">
              {evidence ? `${plural(evidence.evidence.items.length, "item")}, ${verified ? "signed and verified" : "signature does not verify"}` : "Not signed yet"}
            </span>
          </span>
          <Icon name="chevron-right" class="ctx-link__chev" />
        </a>
      </li>
      {change.rolloutState ? (
        <li>
          <a href={`/changes/${change.id}/rollout`} class="ctx-link">
            <Icon name="rocket" />
            <span class="ctx-link__text">
              <span class="ctx-link__label">Rollout</span>
              <span class="ctx-link__value">{ROLLOUT_STATUS[change.rolloutState.status].label}</span>
            </span>
            <Icon name="chevron-right" class="ctx-link__chev" />
          </a>
        </li>
      ) : null}
    </ul>
  );
}

// ---------------------------------------------------------------- handover

function Handover({ tour, reviewer }: { tour: Tour; reviewer: PrincipalRef | null }) {
  const by = tour.generatedBy;
  return (
    <section class="handover" aria-labelledby="handover-title">
      <h2 id="handover-title" class="handover__title">
        What the reviewer agent is unsure about
      </h2>
      <div class="handover__cols">
        <div>
          <h3 class="handover__sub">
            <VerdictMark verdict="unproven" size={18} /> Least confident
          </h3>
          <ul class="handover__list">
            {tour.leastConfident.map((t, i) => (
              <li key={i}>
                <Prose text={t} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 class="handover__sub">
            <Icon name="minus" size={18} /> Not done
          </h3>
          <ul class="handover__list handover__list--notdone">
            {tour.notDone.map((t, i) => (
              <li key={i}>
                <Prose text={t} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      {/* Two agents, two squares: the one that wrote the code (in the byline above) and this one. */}
      <p class="handover__by" data-testid="handover-by">
        <span>Written by</span>
        <Who kind="agent" name={reviewer?.name ?? "the reviewer agent"} size={16} compact />
        <span>
          a separate agent from the author, using {by.model} ({plural(by.attempts, "attempt")}, ${by.costUsd.toFixed(2)}).
        </span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- stops

function evidenceFor(stop: TourStop, items: EvidenceItem[]) {
  return stop.evidenceRefs.map((id) => ({ id, item: findItem(items, id) }));
}

/** The red/green table appears once per tour: on the proof stop if one cites it, else the behavior stop. */
function testsStopIndex(tour: Tour): number {
  const cites = (s: TourStop) => s.evidenceRefs.includes("red-green");
  const proof = tour.stops.findIndex((s) => s.kind === "proof" && cites(s));
  return proof >= 0 ? proof : tour.stops.findIndex((s) => s.kind === "behavior" && cites(s));
}

function StopBody({ stop, data, items, tests }: { stop: TourStop; data: TourData; items: EvidenceItem[]; tests: boolean }) {
  const refs = evidenceFor(stop, items);
  const redGreen = refs.find((r) => r.item?.kind === "red-green")?.item;
  const shots = refs.find((r) => r.item?.kind === "screenshots")?.item;
  const transform = refs.find((r) => r.item?.kind === "transform")?.item;
  const showTests = tests && redGreen?.kind === "red-green";
  return (
    <>
      <p class="stop__why">
        <Prose text={stop.why} />
      </p>
      {showTests && redGreen?.kind === "red-green" ? <RedGreenList item={redGreen} compact /> : null}
      {shots?.kind === "screenshots" && shots.shots.length > 0 ? (
        <div class="stop__shots">
          {shots.shots.map((s) => (
            <ShotPair key={`${s.route}:${s.viewport}`} shot={s} />
          ))}
        </div>
      ) : null}
      {transform?.kind === "transform" ? (
        <dl class="kv stop__transform">
          <dt>Command</dt>
          <dd>
            <code>{transform.command}</code>
          </dd>
          <dt>Reproduced</dt>
          <dd>{transform.verified ? `All ${transform.files.length} files, byte for byte` : `${transform.mismatchedFiles.length} of ${transform.files.length} files differ`}</dd>
        </dl>
      ) : null}
      {stop.kind === "resolution" && data.resolution ? (
        <p class="stop__noev">
          <Icon name="git-merge" size={15} />
          <span>
            <a href="#resolution-title">The resolved lines are above</a>, next to what each side had.
          </span>
        </p>
      ) : stop.hunkRefs.length > 0 && data.diff ? (
        <DiffExcerpt diff={data.diff} refs={stop.hunkRefs} />
      ) : null}
      {refs.length > 0 ? (
        <div class="stop__evidence">
          <span class="stop__evlabel">Evidence</span>
          {refs.map((r) => (r.item ? <EvidenceChip key={r.id} item={r.item} changeId={data.change.id} /> : <MissingChip key={r.id} id={r.id} />))}
        </div>
      ) : (
        <p class="stop__noev">
          <Icon name="info" size={15} /> No evidence cited. This stop is the reviewer agent's reading.
        </p>
      )}
    </>
  );
}

function StopView({
  stop,
  index,
  total,
  data,
  items,
  current,
  tests,
}: {
  stop: TourStop;
  index: number;
  total: number;
  data: TourData;
  items: EvidenceItem[];
  current: boolean;
  tests: boolean;
}) {
  const head = (
    <div class="stop__head">
      <span class="stop__num tnum" aria-hidden="true">
        {index + 1}
      </span>
      <div class="stop__heading">
        <h2 class="stop__title" tabIndex={-1}>
          <span class="sr-only">
            Stop {index + 1} of {total}:{" "}
          </span>
          <Prose text={stop.title} />
        </h2>
        <p class="stop__meta">
          <VerdictBadge verdict={stop.verdict} />
          <span class="stop__kind">{STOP_KIND[stop.kind]}</span>
        </p>
      </div>
    </div>
  );
  if (stop.kind === "transform") {
    return (
      <li class={`stop stop--${stop.verdict} stop--transform ${current ? "is-current" : ""}`} id={`stop-${index + 1}`} data-stop={index}>
        {/* The heading stays outside the summary (a button), so heading navigation and J find it. */}
        {head}
        <details class="stop__collapse">
          <summary class="stop__expand">
            Show what was verified <Icon name="chevron-down" class="disclosure__chev" />
          </summary>
          <div class="stop__body">
            <StopBody stop={stop} data={data} items={items} tests={tests} />
          </div>
        </details>
      </li>
    );
  }
  return (
    <li class={`stop stop--${stop.verdict} ${current ? "is-current" : ""}`} id={`stop-${index + 1}`} data-stop={index}>
      {head}
      <div class="stop__body">
        <StopBody stop={stop} data={data} items={items} tests={tests} />
      </div>
    </li>
  );
}

function TourEnd({ tour, desktop, awaiting, onGithub = false }: { tour: Tour; desktop: boolean; awaiting: boolean; onGithub?: boolean }) {
  const tally = { proven: 0, unproven: 0, risk: 0 };
  for (const s of tour.stops) tally[s.verdict]++;
  return (
    <section class="tour-end" aria-label="End of walkthrough">
      <p class="tour-end__title">End of the walkthrough</p>
      <p class="tour-end__tally">
        {(["proven", "unproven", "risk"] as const)
          .filter((v) => tally[v] > 0)
          .map((v) => (
            <span key={v} class={`tally tally--${v}`}>
              <VerdictMark verdict={v} size={16} /> {tally[v]} {VERDICT[v].label.toLowerCase()}
            </span>
          ))}
      </p>
      {/* Only while there is something to decide; after a decision the panel says what happened. */}
      {awaiting ? (
        <p class="tour-end__hint">
          {onGithub
            ? desktop
              ? "Decide in the panel on the right, or on the pull request."
              : "Decide with the bar below, or on the pull request."
            : desktop
              ? "Decide in the panel on the right."
              : "Decide with the bar below."}{" "}
          Unproven stops are yours to judge: no evidence covers them.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- not ready

function PipelineHead({ run }: { run: PipelineRun }) {
  const idx = run.steps.findIndex((s) => s.status === "running" || s.status === "failed");
  switch (run.status) {
    case "passed":
      return (
        <>
          <Icon name="check-circle" class="tone--ok" /> All {run.steps.length} checks passed
        </>
      );
    case "failed":
    case "errored":
      return (
        <>
          <Icon name="x-circle" class="tone--danger" /> Failed at <b>{run.steps[idx]?.name ?? "a step"}</b>
        </>
      );
    case "cancelled":
    case "superseded":
      return (
        <>
          <Icon name="circle-dashed" /> This run was {run.status}; a newer push replaces it
        </>
      );
    default:
      return idx >= 0 ? (
        <>
          <Icon name="loader" class="spin" /> Running step {idx + 1} of {run.steps.length}: <b>{run.steps[idx]?.name}</b>
        </>
      ) : (
        <>
          <Icon name="loader" class="spin" /> Waiting for a runner
        </>
      );
  }
}

function PipelineSteps({ run }: { run: PipelineRun }) {
  return (
    <div class="pipeline">
      <ol class="pipeline__steps">
        {run.steps.map((s) => (
          <li key={s.name} class={`pstep pstep--${s.status}`}>
            <Icon
              name={s.status === "passed" || s.status === "cached" ? "check" : s.status === "failed" ? "x" : s.status === "running" ? "loader" : "circle-dashed"}
              size={15}
              class={s.status === "running" ? "spin" : ""}
            />
            <span class="pstep__name">{s.name}</span>
            <span class="pstep__dur tnum">{stepTime(s)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NotReady({ data }: { data: TourData }) {
  const run = data.runs[0];
  const copy = noTourCopy(data.change, run?.status);
  const diff = copy.showDiff && data.diff && data.diff.files.length > 0 ? data.diff : null;
  return (
    <>
      <section class="not-ready" aria-labelledby="not-ready-title">
        <h2 id="not-ready-title" class="not-ready__title">
          {copy.title}
        </h2>
        <p>{copy.body}</p>
        {run ? (
          <details class="not-ready__run" open={run.status !== "passed"}>
            <summary class="pipeline__head">
              <PipelineHead run={run} />
              <Icon name="chevron-down" size={14} class="disclosure__chev" />
            </summary>
            <PipelineSteps run={run} />
          </details>
        ) : data.change.status === "awaiting-push" ? null : (
          <p class="not-ready__fine">No pipeline has run for this change.</p>
        )}
      </section>
      {diff ? (
        <section class="whole-diff" aria-labelledby="whole-diff-title">
          <h2 id="whole-diff-title" class="whole-diff__title">
            Changed files <span class="whole-diff__count tnum">{diff.files.length}</span>
          </h2>
          <WholeDiff diff={diff} />
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- page

function useStopTracking(tour: Tour | null, changeId: string) {
  const current = useSignal(0);
  const saved = tour ? readTourProgress(changeId) : null;
  const resumeAt = useSignal<number | null>(saved && tour && saved.headSha === tour.headSha && saved.stop > 0 && saved.stop < tour.stops.length ? saved.stop : null);
  const listRef = useRef<HTMLOListElement>(null);
  /** What the strip's live region says: set by a jump, never by scrolling (that would chatter). */
  const announce = useSignal("");

  /** Set by `jump`: the stop it scrolls to stays current until the scroll settles. */
  const pinned = useRef<number | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!tour || !list) return;
    // The current stop is the last one whose top has passed a reading line near the top of the
    // view. (The old visible-band rule kept stop 1 current while only its tail showed above stop 2.)
    let frame = 0;
    const settle = () => {
      frame = 0;
      const line = Math.min(window.innerHeight * 0.3, 280);
      let i = 0;
      for (const el of list.querySelectorAll<HTMLElement>("[data-stop]")) {
        if (el.getBoundingClientRect().top <= line) i = Number(el.dataset.stop);
        else break;
      }
      if (pinned.current !== null) return;
      if (i === current.value) return;
      current.value = i;
      if (resumeAt.value !== null && i >= resumeAt.value) resumeAt.value = null;
      writeTourProgress(changeId, { stop: i, headSha: tour.headSha });
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(settle);
    };
    // After a jump lands, the target stays current until the reader scrolls again.
    const onEnd = () => {
      pinned.current = null;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", onEnd);
    settle();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", onEnd);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [tour, changeId, current, resumeAt]);

  const jump = (i: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-stop="${i}"]`);
    if (!el) return;
    const details = el.querySelector("details");
    if (details) details.open = true;
    current.value = i;
    if (resumeAt.value !== null && i >= resumeAt.value) resumeAt.value = null;
    if (tour) writeTourProgress(changeId, { stop: i, headSha: tour.headSha });
    // Hold the target while the scroll runs; a stop too short to reach the line stays current.
    pinned.current = i;
    window.setTimeout(() => {
      if (pinned.current === i) pinned.current = null;
    }, 1200);
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    // Focus the stop's heading: a screen reader hears its title, and the next Tab continues inside it.
    el.querySelector<HTMLElement>(".stop__title")?.focus({ preventScroll: true });
    const stop = tour?.stops[i];
    if (stop) announce.value = `Stop ${i + 1} of ${tour.stops.length}: ${stop.title}`;
  };
  return { current, resumeAt, listRef, jump, announce };
}

/**
 * "updated 3 minutes ago" / "updated just now". The minute clock can trail a decision made a moment
 * ago, so anything newer than a minute (or a few seconds ahead) is "just now", never "in under a minute".
 */
function updatedAgo(iso: string, now: number): string {
  return Date.parse(iso) > now - 60_000 ? "just now" : relative(iso, now);
}

// ---------------------------------------------------------------- close (abandon)

/** Statuses a change can still be closed from (the coordinator's FINAL_STATUSES are the rest). */
const CLOSABLE: ReadonlySet<Change["status"]> = new Set(["awaiting-push", "running", "failing", "awaiting-review", "approved", "queued"]);

/**
 * A stale change, closed by a person: its author, the author agent's owner or a maintainer (the
 * server checks; `close_change` is the agent's twin). Quiet until asked, then an inline
 * confirmation that names the act before the danger button appears.
 */
function CloseChange({ change, me, author, onClosed }: { change: Change; me: Principal | null; author: PrincipalRef | null; onClosed: (c: Change) => void }) {
  const open = useSignal(false);
  const reason = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open.value) formRef.current?.querySelector<HTMLElement>("textarea")?.focus();
  }, [open.value]);
  // The palette's "Close the change" lands here with #close: open the confirmation.
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash === "#close") open.value = true;
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [open]);
  const may = me !== null && (change.authorId === me.id || author?.ownerId === me.id || (me.kind === "human" && me.scopes.includes("change:review")));
  if (!may || !CLOSABLE.has(change.status)) return null;

  const cancel = () => {
    open.value = false;
    error.value = null;
    key.current = null;
    // The trigger is back on the next render; hand focus to it then.
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    key.current ??= newIdempotencyKey();
    const why = reason.value.trim();
    try {
      const res = await request<{ change: Change }>("POST", `/api/v1/changes/${encodeURIComponent(change.id)}/close`, why ? { reason: why } : {}, key.current);
      open.value = false;
      onClosed(res.change);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  if (!open.value) {
    return (
      <div class="close-change" id="close">
        <button type="button" class="close-change__open" ref={triggerRef} onClick={() => (open.value = true)} data-testid="close-change-open">
          <Icon name="ban" size={15} /> Close change…
        </button>
      </div>
    );
  }
  return (
    <form
      class="close-change close-change--open"
      ref={formRef}
      onSubmit={submit}
      aria-labelledby="close-change-title"
      data-testid="close-change-form"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy.value) {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <h2 id="close-change-title" class="close-change__title">
        Close this change?
      </h2>
      <p class="close-change__line">
        Its checks stop, it leaves the merge queue and it can't be reopened.{" "}
        {author?.kind === "agent" ? `${author.name} would have to start a new change.` : "Its author would have to start a new change."}
      </p>
      <label class="field">
        <span class="field__label">
          Reason <span class="field__hint">(optional, goes to the audit log)</span>
        </span>
        <textarea class="textarea" rows={2} value={reason.value} onInput={(e) => (reason.value = e.currentTarget.value)} maxLength={2000} />
      </label>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <div class="close-change__actions">
        <Button variant="secondary" onClick={cancel} disabled={busy.value}>
          Keep it open
        </Button>
        <Button type="submit" variant="danger" busy={busy.value} busyLabel="Closing…" data-testid="close-change-confirm">
          Close change
        </Button>
      </div>
    </form>
  );
}

/** The tour's own width at which the rail fits beside a reading column of at least 640px. */
const RAIL_AT = 1040;

/**
 * Rail or bar, from the tour's own width rather than the viewport: next to the 248px sidebar, a
 * viewport switch at 1100px squeezed the reading column below a phone's. Measured before paint.
 */
function useRail(ref: RefObject<HTMLElement | null>): boolean {
  const rail = useSignal(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      rail.value = el.clientWidth >= RAIL_AT;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, rail]);
  return rail.value;
}

/** The fixed bar's height as `--bar-h` on the tour, so the page end is never under the bar (or its done sheet). */
function useBarHeight(root: RefObject<HTMLElement | null>, bar: RefObject<HTMLElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = bar.current;
    const host = root.current;
    if (!on || !el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty("--bar-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty("--bar-h");
    };
  }, [root, bar, on]);
}

function TourBody({ data, onChange }: { data: TourData; onChange: (c: Change) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const desktop = useRail(rootRef);
  useBarHeight(rootRef, barRef, !desktop);
  /** The decision sheet, shared with the panel: on phones the page behind it goes inert under a scrim. */
  const sheet = useSignal<ReviewDecisionKind | null>(null);
  const modal = !desktop && sheet.value !== null;
  const { change, tour, repo, author } = data;
  const me = principal.value;
  const own = data.evidence?.evidence.items ?? [];
  // The resolution stop cites the resolved head's conflict-resolution item.
  const resolutionItem = data.resolution?.item ?? null;
  const items = resolutionItem && !own.some((i) => i.id === resolutionItem.id) ? [...own, resolutionItem] : own;
  const { current, resumeAt, listRef, jump, announce } = useStopTracking(tour, change.id);
  const { route } = useLocation();
  const stops = tour?.stops.length ?? 0;
  usePageCommands(
    {
      "next-stop": () => stops > 0 && jump(Math.min(current.value + 1, stops - 1)),
      "prev-stop": () => stops > 0 && jump(Math.max(current.value - 1, 0)),
    },
    {
      j: "next-stop",
      k: "prev-stop",
      a: "approve",
      e: () => route(`/changes/${encodeURIComponent(change.id)}/evidence`),
    },
  );
  const now = minuteClock.value;
  const stale = tour && change.headSha && tour.headSha !== change.headSha && !describesResolution(tour.headSha, data.resolution);
  const authorName = author?.name ?? "the author";
  const testsAt = tour ? testsStopIndex(tour) : -1;

  // GitHub PRs: the same decision as an approval on GitHub (one record); GitHub still merges.
  const decision = (
    <DecisionPanel
      change={change}
      me={me}
      author={author}
      authorName={authorName}
      shadow={repo.shadow}
      lane0Enabled={repo.repo.policy.lane0Enabled}
      layout={desktop ? "rail" : "bar"}
      resolvedHead={data.resolution?.approvalRequested ? data.resolution.headSha : null}
      sheet={sheet}
      onDecided={onChange}
    />
  );
  const closing = <CloseChange change={change} me={me} author={author} onClosed={onChange} />;

  return (
    <div ref={rootRef} class={`tour ${tour ? "" : "tour--pending"} ${desktop ? "tour--rail" : "tour--bar"}`}>
      {tour ? (
        <StationStrip
          inert={modal}
          tour={tour}
          current={current.value}
          onJump={jump}
          resumeAt={resumeAt.value}
          announce={announce.value}
          onResume={() => {
            const at = resumeAt.value;
            resumeAt.value = null;
            if (at !== null) jump(at);
          }}
        />
      ) : null}

      <div class="tour__layout" inert={modal} data-testid="tour-layout">
        <div class="tour__main" data-testid="tour-main">
          <div class="tour__meta">
            {author ? <Who kind={author.kind} name={author.name} owner={author.ownerName} /> : null}
            <span class="tour__dot" aria-hidden="true" />
            <span>
              {CATEGORY_LABEL[change.claim.category]} · updated <time dateTime={change.updatedAt}>{updatedAgo(change.updatedAt, now)}</time>
            </span>
            {data.diff && data.diff.files.length > 0 ? (
              <span class="tour__stat tnum">
                <span class="tone--ok">+{data.diff.additions}</span> <span class="tone--danger">−{data.diff.deletions}</span> in {plural(data.diff.files.length, "file")}
              </span>
            ) : null}
            {change.status !== "awaiting-review" ? <StatusChip meta={CHANGE_STATUS[change.status]} /> : null}
          </div>
          {change.host ? (
            <p class="tour__github">
              <Icon name="git-branch" size={16} />
              <span>
                <a href={change.host.url} target="_blank" rel="noopener noreferrer">
                  {data.repo.repo.name}#{change.host.number}
                </a>{" "}
                on GitHub by {change.host.author.login}
                {change.host.fork ? " (from a fork)" : ""}. Approve here or on GitHub: it's the same approval. GitHub merges it.
              </span>
            </p>
          ) : null}

          {!desktop ? <LaneBlock change={change} open={false} /> : null}

          {stale ? (
            <p class="tour__stale" role="alert">
              <Icon name="triangle-alert" size={18} />
              This walkthrough describes head <code>{shortSha(tour?.headSha)}</code>, but the change is now at <code>{shortSha(change.headSha)}</code>. The reviewer agent is
              rewriting it.
            </p>
          ) : null}

          {data.evidenceError ? <ErrorState error={data.evidenceError} what="the evidence bundle" /> : null}
          {data.resolutionError ? <ErrorState error={data.resolutionError} what="the merge queue's conflict resolution" /> : null}
          {data.resolution ? <ResolutionPanel r={data.resolution} awaiting={change.status === "awaiting-review"} /> : null}

          {tour ? (
            <>
              <Handover tour={tour} reviewer={data.reviewer} />
              <ol class="stops has-current" ref={listRef}>
                {tour.stops.map((s, i) => (
                  <StopView key={i} stop={s} index={i} total={tour.stops.length} data={data} items={items} current={i === current.value} tests={i === testsAt} />
                ))}
              </ol>
              {/* QA gathers evidence, so it comes before the end of the walkthrough that says decide. */}
              <QaPanel change={change} />
              <TourEnd tour={tour} desktop={desktop} awaiting={change.status === "awaiting-review"} onGithub={!!change.host} />
            </>
          ) : (
            <>
              <NotReady data={data} />
              <QaPanel change={change} />
            </>
          )}

          {!desktop ? (
            <>
              <ContextLinks data={data} />
              {closing}
            </>
          ) : null}
        </div>

        {desktop ? (
          <aside class="tour__rail" aria-label="Decision and lane" data-testid="tour-rail">
            {decision}
            <LaneBlock change={change} open rail />
            <ContextLinks data={data} />
            {closing}
          </aside>
        ) : null}
      </div>

      {/* Phones: the open sheet is a modal moment (you sign here). The page recedes and goes inert;
          a tap on it is Back. The sheet itself stays solid paper (the Acetate Rule). */}
      {modal ? <div class="tour__scrim" aria-hidden="true" data-testid="decision-scrim" onClick={() => (sheet.value = null)} /> : null}
      {!desktop ? (
        <div class="tour__bar" ref={barRef} data-testid="decision-bar">
          {decision}
        </div>
      ) : null}
    </div>
  );
}

export function TourView({ changeId }: { changeId: string }) {
  const res = useResource(() => loadTour(changeId), [changeId]);
  const st = res.state.value;
  const crumbsBase = [{ href: "/dashboard", label: "Dashboard" }];

  if (st.status === "loading") {
    return (
      <Page title="Change" crumbs={crumbsBase} wide>
        <Loading label="Loading the walkthrough" lines={10} />
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title="Change" crumbs={crumbsBase} wide>
        <ErrorState error={st.error} what="this change" onRetry={res.reload} />
      </Page>
    );
  }
  const data = st.data;
  return (
    <Page title={data.change.title} crumbs={[...crumbsBase, { href: `/repos/${data.repo.repo.id}`, label: data.repo.repo.name }]} wide class="tour-page">
      <TourBody data={data} onChange={(c) => res.set({ ...data, change: c })} />
    </Page>
  );
}
