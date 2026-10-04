/**
 * QA in a browser on the Change page (docs/research/agentic-qa.md §6): ask for a run, follow it,
 * then read each acceptance criterion's verdict with the screenshots of its steps and a replay.
 * "Couldn't test" is shown as exactly that, never as a pass. Polls while a run is in flight.
 */
import type { Change } from "@app/domain";
import type { QaCriterionResult, QaRun } from "@app/evidence";
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ApiError, artifactUrl, newIdempotencyKey } from "../api/client.js";
import { fetchQaRuns, type QaRunView, requestQa } from "../api/qa.js";
import { LANES } from "../lib/lanes.js";
import { durationLabel } from "../lib/time.js";
import { plural, shortSha } from "../lib/vocab.js";
import { Icon } from "./Icon.js";
import { Button } from "./ui.js";
import "../styles/qa.css";

const POLL_MS = 4_000;
const STALE_MS = 15 * 60_000;
const VERDICT = {
  pass: { label: "Pass", tone: "ok", icon: "check" },
  fail: { label: "Fail", tone: "danger", icon: "x" },
  "couldnt-test": { label: "Couldn't test", tone: "warn", icon: "help" },
} as const;
const CAN_ASK: ReadonlySet<Change["status"]> = new Set([
  "running",
  "failing",
  "awaiting-review",
  "approved",
  "queued",
]);

function useBlob(ref: string | undefined) {
  const url = useSignal<string | null>(null);
  useEffect(() => {
    let live = true;
    if (ref) {
      void artifactUrl(ref).then((u) => {
        if (live) url.value = u || null;
      });
    }
    return () => {
      live = false;
    };
  }, [ref, url]);
  return url.value;
}

function Shot({ run, name, caption }: { run: QaRun; name: string | undefined; caption: string }) {
  const art = name === undefined ? undefined : run.artifacts.find((a) => a.name === name);
  const url = useBlob(art?.ref);
  if (art === undefined) return null;
  return (
    <figure class="qa-shot">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={caption} loading="lazy" decoding="async" width={320} height={200} />
        </a>
      ) : (
        <div class="qa-shot__none" aria-busy="true" />
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function stepLabel(s: QaCriterionResult["steps"][number]): string {
  const what = s.action.replace("expect_", "expect ").replace("_", " ");
  return [what, s.target, s.value === undefined ? undefined : `“${s.value}”`]
    .filter(Boolean)
    .join(" ");
}

function Criterion({ c, run }: { c: QaCriterionResult; run: QaRun }) {
  const v = VERDICT[c.verdict];
  return (
    <li class={`qa-crit qa-crit--${c.verdict}`} data-testid="qa-criterion" data-verdict={c.verdict}>
      <div class="qa-crit__head">
        <span class={`chip chip--${v.tone}`}>
          <Icon name={v.icon} size={14} />
          {v.label}
        </span>
        <p class="qa-crit__text">{c.text}</p>
      </div>
      <p class="qa-crit__why">{c.reason}</p>
      {c.steps.length > 0 || c.before ? (
        <fieldset class="qa-strip" aria-label={`Screenshots of “${c.text}”`}>
          <Shot run={run} name={c.before} caption="Before" />
          {c.steps.map((s, i) => (
            <Shot
              key={i}
              run={run}
              name={s.shot}
              caption={`${i + 1}. ${stepLabel(s)}${s.ok ? "" : " (failed)"}`}
            />
          ))}
        </fieldset>
      ) : null}
      {c.consoleErrors + c.networkErrors > 0 ? (
        <p class="qa-dim">
          {plural(c.consoleErrors, "console error")}, {plural(c.networkErrors, "failed request")}{" "}
          while testing it
        </p>
      ) : null}
    </li>
  );
}

function Replay({ run }: { run: QaRun }) {
  const gif = run.artifacts.find((a) => a.role === "recording");
  const url = useBlob(gif?.ref);
  const open = useSignal(false);
  if (gif === undefined) return null;
  return (
    <details
      class="disclosure qa-replay"
      onToggle={(e) => (open.value = (e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        Replay of every step <Icon name="chevron-down" size={16} class="disclosure__chev" />
      </summary>
      {open.value && url ? (
        <img src={url} alt="An animated replay of the QA run, one frame per step" loading="lazy" />
      ) : null}
    </details>
  );
}

function Summary({ run }: { run: QaRunView }) {
  const s = run.summary;
  const parts: string[] = [];
  if (s)
    parts.push(
      `${s.passed} passed`,
      ...(s.failed > 0 ? [`${s.failed} failed`] : []),
      ...(s.couldntTest > 0 ? [`${s.couldntTest} couldn't test`] : []),
    );
  const raised =
    run.laneBefore !== null && run.laneAfter !== null && run.laneAfter > run.laneBefore;
  return (
    <ul class="qa-facts">
      {parts.length > 0 ? <li>{parts.join(" · ")}</li> : null}
      {run.withdrawn.length > 0 ? (
        <li class="tone--danger" data-testid="qa-withdrawn">
          <Icon name="undo" size={14} /> Approval by {run.withdrawn.map((w) => w.name).join(", ")}{" "}
          withdrawn: QA failed. It needs a fresh approval.
        </li>
      ) : null}
      {raised ? (
        <li class="tone--danger">
          <Icon name="arrow-up-right" size={14} /> Lane raised to{" "}
          {LANES[run.laneAfter as 0 | 1 | 2].name}
        </li>
      ) : null}
      <li class="qa-dim">
        head <code>{shortSha(run.headSha)}</code>
        {run.wallMs !== null ? ` · ${durationLabel(run.wallMs)}` : ""}
        {run.costUsd !== null ? ` · $${run.costUsd.toFixed(4)} model` : ""}
        {run.requestedLogin ? ` · asked by @${run.requestedLogin}` : ""}
      </li>
    </ul>
  );
}

export function QaPanel({ change }: { change: Change }) {
  const runs = useSignal<QaRunView[] | null>(null);
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);
  const tick = useSignal(0);
  useEffect(() => {
    let live = true;
    void fetchQaRuns(change.id).then(
      (r) => {
        if (!live) return;
        runs.value = r;
        error.value = null;
      },
      (e: unknown) => {
        if (live) error.value = e instanceof Error ? e.message : String(e);
      },
    );
    return () => {
      live = false;
    };
  }, [change.id, tick.value, runs, error]);
  const latest = runs.value?.find((r) => r.headSha === change.headSha) ?? runs.value?.[0] ?? null;
  // A run with no result after 15 minutes lost its workflow: the platform lets you ask again.
  const flying =
    latest !== null &&
    (latest.status === "queued" || latest.status === "running") &&
    Date.now() - Date.parse(latest.createdAt) < STALE_MS;
  useEffect(() => {
    if (!flying) return;
    const t = setTimeout(() => (tick.value += 1), POLL_MS);
    return () => clearTimeout(t);
  }, [flying, tick.value, tick]);

  const ask = async (force: boolean) => {
    busy.value = true;
    try {
      await requestQa(change.id, force, newIdempotencyKey());
      error.value = null;
      tick.value += 1;
    } catch (e) {
      error.value =
        e instanceof ApiError ? `${e.message}${e.fix ? `. ${e.fix.explanation}` : ""}` : String(e);
    } finally {
      busy.value = false;
    }
  };
  // No button until the runs have loaded: before that, "Run QA" would not know to ask for a re-run.
  const canAsk = runs.value !== null && change.headSha !== null && CAN_ASK.has(change.status);
  const current = latest !== null && latest.headSha === change.headSha;
  const report = latest?.report ?? null;

  return (
    <section
      class="qa"
      id="qa"
      aria-labelledby="qa-title"
      data-testid="qa"
      data-status={latest?.status ?? "none"}
    >
      <h2 class="qa__title" id="qa-title">
        <Icon name="monitor" size={20} /> QA in a browser
      </h2>
      {latest === null ? (
        <p class="qa__lede">
          On request, an agent opens the app built from this head in a real browser, checks each
          acceptance criterion of the Plan, and keeps a screenshot of every step. A failure raises
          the lane; nothing lowers it.
        </p>
      ) : null}
      {latest !== null && !current ? (
        <p class="qa-dim">The last run tested an older head ({shortSha(latest.headSha)}).</p>
      ) : null}
      {flying ? (
        <p class="qa__progress" role="status">
          <Icon name="loader" class="spin" size={16} /> {latest?.progress ?? "Starting"}…
        </p>
      ) : null}
      {latest?.status === "failed" ? (
        <p class="qa__error" role="alert">
          <Icon name="triangle-alert" size={16} /> QA could not test this head:{" "}
          {latest.error ?? "unknown error"}
        </p>
      ) : null}
      {latest?.status === "done" ? <Summary run={latest} /> : null}
      {report !== null && latest?.status === "done" ? (
        <>
          <ol class="qa-crits">
            {report.criteria.map((c) => (
              <Criterion key={c.index} c={c} run={report} />
            ))}
          </ol>
          <Replay run={report} />
          {report.blockedOrigins.length > 0 ? (
            <p class="qa-dim">
              Blocked during QA (the app has no internet here):{" "}
              {report.blockedOrigins.slice(0, 4).join(", ")}
              {report.blockedOrigins.length > 4
                ? ` and ${report.blockedOrigins.length - 4} more`
                : ""}
            </p>
          ) : null}
        </>
      ) : null}
      {error.value ? (
        <p class="qa__error" role="alert">
          {error.value}
        </p>
      ) : null}
      {canAsk && !flying ? (
        <div class="qa__actions">
          <Button
            variant={latest === null || !current ? "primary" : "secondary"}
            icon="monitor"
            busy={busy.value}
            busyLabel="Asking…"
            data-testid="qa-run"
            onClick={() => void ask(current)}
          >
            {latest === null || !current ? "Run QA" : "Run QA again"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
