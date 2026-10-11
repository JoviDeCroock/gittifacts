/**
 * Attempts at one plan, on the plan page: every Change on the plan ranked by what the machines
 * proved (the server's `rankAttempts`), best first, and one tap to pick one. Picking approves it
 * as you, at the head you saw, and closes the other open attempts as superseded; nothing changes
 * on screen until the server confirms. Rows on paper, hairline-separated: one decision, one
 * primary (teal) button, on the recommended attempt.
 */
import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { type PickResult, type PlanAttemptsView, type RankedAttempt, attemptsApi } from "../api/attempts.js";
import { ApiError, api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { StatusMeta } from "../lib/vocab.js";
import { CHANGE_STATUS, plural } from "../lib/vocab.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import { Icon } from "./Icon.js";
import { Button, ErrorState, LaneTag, Skeleton, StatusChip, Who } from "./ui.js";
import "../styles/attempts.css";

interface AttemptsData {
  view: PlanAttemptsView;
  /** An agent's accountable person, by agent id. */
  owners: Record<string, string | null>;
}

const ownerCache = new Map<string, Promise<string | null>>();

function ownerOf(id: string): Promise<string | null> {
  let hit = ownerCache.get(id);
  if (!hit) {
    hit = api.principal(id).then(
      (r) => r.principal.ownerName ?? null,
      () => {
        ownerCache.delete(id);
        return null;
      },
    );
    ownerCache.set(id, hit);
  }
  return hit;
}

async function loadAttempts(planId: string): Promise<AttemptsData> {
  const view = await attemptsApi.list(planId);
  const agents = [...new Set(view.attempts.filter((a) => a.author.kind === "agent").map((a) => a.author.id))];
  const names = await Promise.all(agents.map(ownerOf));
  return { view, owners: Object.fromEntries(agents.map((id, i) => [id, names[i] ?? null])) };
}

const RECOMMENDED: StatusMeta = { label: "Recommended", tone: "neutral", icon: "badge-check" };
const LEADING: StatusMeta = { label: "Leading so far", tone: "neutral", icon: "badge-check" };
const PICKED: StatusMeta = { label: "Picked", tone: "ok", icon: "check-circle" };
const SUPERSEDED: StatusMeta = { label: "Superseded", tone: "neutral", icon: "archive" };
const GRADING: StatusMeta = { label: "Still grading", tone: "neutral", icon: "timer" };

/** A reason that names a failure or risk reads in carmine; one that wasn't measured, in ochre. */
function reasonTone(r: string): "danger" | "warn" | null {
  if (/failing|failed|drift|breaks/.test(r)) return "danger";
  if (/not measured|not checked|not proven|no lane/.test(r)) return "warn";
  return null;
}

function Reasons({ a }: { a: RankedAttempt }) {
  // Lane, standing and diff size have their own places on the row; the rest is the evidence, best first.
  const size = a.diff ? plural(a.diff.lines, "line") : null;
  const lane = a.lane === null ? null : `Lane ${a.lane}`;
  const shown = a.reasons.filter((r) => r !== size && r !== lane && r !== "still grading" && r !== "closed");
  return (
    <p class="attempt__reasons" data-testid="attempt-reasons">
      {shown.map((r, i) => {
        const tone = reasonTone(r);
        return (
          <span key={r}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            <span class={tone ? `tone--${tone}` : undefined}>{r}</span>
          </span>
        );
      })}
    </p>
  );
}

interface RowProps {
  a: RankedAttempt;
  view: PlanAttemptsView;
  owner: string | null;
  /** The attempt being picked right now, if any. */
  busy: string | null;
  onPick: (a: RankedAttempt) => void;
}

function AttemptRow({ a, view, owner, busy, onPick }: RowProps) {
  const me = principal.value;
  const picked = view.picked?.changeId === a.changeId;
  const mine = me !== null && a.author.id === me.id;
  const canPick = view.picked === null && a.pickable && !mine;
  const href = `/changes/${encodeURIComponent(a.changeId)}`;
  return (
    <li
      class={`attempt${a.recommended ? " attempt--recommended" : ""}${a.standing === "closed" ? " attempt--closed" : ""}`}
      data-testid="attempt-card"
      data-change-id={a.changeId}
      data-rank={a.rank}
      data-standing={a.standing}
      data-status={a.status}
      data-recommended={a.recommended ? "true" : "false"}
      data-picked={picked ? "true" : "false"}
    >
      <span class="attempt__rank tnum">
        <span class="sr-only">Rank </span>
        {a.rank}
      </span>
      <div class="attempt__body">
        <a class="attempt__title" href={href}>
          {a.title}
        </a>
        <div class="attempt__meta">
          <LaneTag lane={a.lane} size="sm" />
          <Who kind={a.author.kind} name={a.author.name} owner={owner} size={20} />
          {a.diff ? (
            <span class="attempt__size tnum">
              {plural(a.diff.lines, "line")} in {plural(a.diff.files, "file")}
            </span>
          ) : null}
        </div>
        <Reasons a={a} />
        <div class="attempt__chips">
          {picked ? <StatusChip meta={PICKED} /> : null}
          {a.recommended && !picked ? (
            <span data-testid="attempt-recommended" data-provisional={view.recommended?.provisional ? "true" : "false"}>
              <StatusChip meta={view.recommended?.provisional ? LEADING : RECOMMENDED} class="attempt__rec" />
            </span>
          ) : null}
          {a.standing === "grading" ? <StatusChip meta={GRADING} /> : null}
          {a.standing === "closed" ? <StatusChip meta={a.status === "abandoned" && view.picked ? SUPERSEDED : CHANGE_STATUS[a.status]} /> : null}
          {a.standing === "finished" && !picked && a.status !== "awaiting-review" ? <StatusChip meta={CHANGE_STATUS[a.status]} /> : null}
        </div>
      </div>
      {canPick ? (
        <div class="attempt__act">
          <Button
            variant={a.recommended ? "primary" : "secondary"}
            icon="check"
            busy={busy === a.changeId}
            busyLabel="Picking…"
            disabled={busy !== null && busy !== a.changeId}
            onClick={() => onPick(a)}
            data-testid="attempt-pick"
            aria-label={`Pick this one: ${a.title}`}
          >
            Pick this one
          </Button>
        </div>
      ) : mine && view.picked === null && a.pickable ? (
        <p class="attempt__note">
          <Icon name="lock" size={14} /> Yours: someone else picks it.
        </p>
      ) : null}
    </li>
  );
}

/** The view as the server's pick answer left it: the pick recorded, the others closed. */
function applyPick(view: PlanAttemptsView, result: PickResult): PlanAttemptsView {
  const closed = new Map(result.superseded.map((x) => [x.changeId, x.status]));
  return {
    ...view,
    picked: result.picked,
    attempts: view.attempts.map((a) => {
      if (a.changeId === result.picked.changeId) return { ...a, status: result.change.status };
      const status = closed.get(a.changeId);
      return status ? { ...a, status: status as RankedAttempt["status"], standing: "closed", pickable: false } : a;
    }),
  };
}

/** What the pick recorded, in words: approved, and how many other attempts closed. */
function Confirmation({ result, authorName, repoId }: { result: PickResult; authorName: string | null; repoId: string }) {
  const n = result.superseded.length;
  const which = authorName ? (
    <>
      <span class="attempts__who">{authorName}'s</span> attempt
    </>
  ) : (
    "the attempt"
  );
  return (
    <div class="attempts__done" role="status" data-testid="attempts-picked" data-fresh="true">
      <Icon name="check-circle" size={20} />
      <div>
        <p class="attempts__done-title">
          {result.approved ? <>Picked and approved {which}.</> : <>Picked {which}; it was already approved.</>}{" "}
          {n === 0 ? "No other attempt was open." : `${plural(n, "other attempt")} closed as superseded.`}
        </p>
        {result.notClosed.length > 0 ? (
          <p class="attempts__fine tone--warn" data-testid="attempts-not-closed">
            {plural(result.notClosed.length, "attempt")} could not be closed: {result.notClosed.map((x) => x.error).join(" ")}
          </p>
        ) : null}
        <p class="attempts__fine">
          Signed as {result.picked.by.name} and recorded in the audit log.{" "}
          <a href={`/repos/${encodeURIComponent(repoId)}/queue`}>Watch it land in the merge queue</a>
        </p>
      </div>
    </div>
  );
}

export function Attempts({ planId, repoId }: { planId: string; repoId: string }) {
  const res = useResource(() => loadAttempts(planId), [planId]);
  const busy = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const done = useSignal<PickResult | null>(null);
  /** One key per attempt picked; a retry after a network error reuses it. */
  const keys = useRef<Record<string, string>>({});
  const st = res.state.value;

  async function pick(a: RankedAttempt) {
    if (busy.value) return;
    busy.value = a.changeId;
    error.value = null;
    const key = keys.current[a.changeId] ?? newIdempotencyKey();
    keys.current[a.changeId] = key;
    try {
      const result = await attemptsApi.pick(planId, a.changeId, a.headSha ? { headSha: a.headSha } : {}, key);
      done.value = result;
      // What the server confirmed shows at once; the fresh ranking replaces it when it arrives.
      if (st.status === "ok") res.set({ ...st.data, view: applyPick(st.data.view, result) });
      res.reload();
    } catch (err) {
      error.value = inlineError(err);
      if (err instanceof ApiError && err.status === 409) res.reload();
    } finally {
      busy.value = null;
    }
  }

  const head = (count?: number) => (
    <h2 id="attempts-title">
      Attempts{count !== undefined ? <span class="plan-sec__n tnum">{count}</span> : null}
    </h2>
  );
  if (st.status === "loading") {
    return (
      <section class="plan-sec attempts" id="attempts" aria-labelledby="attempts-title" aria-busy="true">
        {head()}
        <Skeleton lines={4} />
      </section>
    );
  }
  if (st.status === "error") {
    return (
      <section class="plan-sec attempts" id="attempts" aria-labelledby="attempts-title">
        {head()}
        <ErrorState error={st.error} what="the attempts" onRetry={res.reload} />
      </section>
    );
  }
  const { view, owners } = st.data;
  if (view.attempts.length < 2) return null;
  const pickedBy = view.picked;
  const pickedAttempt = done.value ? view.attempts.find((x) => x.changeId === done.value?.picked.changeId) : undefined;
  const anyPickable = pickedBy === null && view.attempts.some((x) => x.pickable);
  return (
    <section class="plan-sec attempts" id="attempts" aria-labelledby="attempts-title" data-testid="attempts">
      {head(view.attempts.length)}
      <p class="attempts__summary">{view.summary}. Ranked by what the machines proved, best first.</p>
      {done.value ? (
        <Confirmation result={done.value} authorName={pickedAttempt?.author.name ?? null} repoId={repoId} />
      ) : pickedBy ? (
        <p class="attempts__picked" data-testid="attempts-picked" data-fresh="false">
          <Icon name="check-circle" size={16} /> Picked by {pickedBy.by.name}, {relative(pickedBy.at, minuteClock.value)}. The other open attempts were closed.
        </p>
      ) : anyPickable ? (
        <p class="attempts__fine">Picking one approves it as you, at the head shown, and closes the other open attempts as superseded.</p>
      ) : null}
      <ol class="attempts__list">
        {view.attempts.map((a) => (
          <AttemptRow key={a.changeId} a={a} view={view} owner={owners[a.author.id] ?? null} busy={busy.value} onPick={pick} />
        ))}
      </ol>
      {error.value ? (
        <p class="field__error" role="alert" data-testid="attempts-error">
          {error.value}
        </p>
      ) : null}
    </section>
  );
}
