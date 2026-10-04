/**
 * GitHub repos: the history check (backtest, spec §3.7): how many of the last merged PRs would
 * have auto-merged, what happened to those afterwards, the full reviews that merged fastest, and
 * whether Lane 0 can be turned on yet (calibration).
 */
import { useSignal } from "@preact/signals";
import { inlineError } from "../api/client.js";
import { type BacktestView, githubApi } from "../api/github.js";
import { useResource } from "../state/resource.js";
import { Icon } from "./Icon.js";
import { Button, Loading } from "./ui.js";

function Report({ b, repoUrl }: { b: BacktestView; repoUrl: string }) {
  const r = b.report;
  if (r === null) return null;
  const later = r.afterwards.reverted.length + r.afterwards.patched.length;
  return (
    <>
      <p class="bt__headline">
        <strong class="tnum">{r.wouldAutoMerge.percent}%</strong> of {r.graded} merged pull requests would have auto-merged
        with an approved Plan.
      </p>
      <p class="bt__line">
        {later === 0 ? "None of those was reverted or patched within 14 days." : `${later} of those ${later === 1 ? "was" : "were"} reverted or patched within 14 days.`}
      </p>
      {r.fastFullReviews.length > 0 ? (
        <>
          <p class="bt__line">Graded for a full review, yet merged fast:</p>
          <ul class="bt__fast">
            {r.fastFullReviews.map((f) => (
              <li key={f.number}>
                <a href={`${repoUrl}/pull/${f.number}`} target="_blank" rel="noopener noreferrer">
                  #{f.number}
                </a>{" "}
                {f.title} <span class="bt__dim">({f.hoursToMerge} h; {f.reasons.join(", ")})</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p class={`bt__cal ${r.calibration.eligible ? "bt__cal--ok" : ""}`}>
        <Icon name={r.calibration.eligible ? "check-circle" : "info"} size={16} />
        <span>{r.calibration.eligible ? "Calibrated: auto-merge can be turned on." : `Auto-merge stays off: ${r.calibration.reason}.`}</span>
      </p>
    </>
  );
}

export function BacktestCard({ repoId, repoUrl }: { repoId: string; repoUrl: string }) {
  const res = useResource(() => githubApi.latestBacktest(repoId), [repoId]);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const st = res.state.value;
  async function run() {
    busy.value = true;
    error.value = null;
    try {
      await githubApi.startBacktest(repoId);
      res.reload();
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }
  const b = st.status === "ok" ? st.data.backtest : null;
  return (
    <section class="side-block bt" aria-labelledby="bt-title">
      <h2 id="bt-title" class="side-block__title">
        History check
      </h2>
      {st.status === "loading" ? <Loading label="Loading the history check" lines={3} /> : null}
      {st.status === "ok" && b === null ? <p class="side-block__empty">Not run yet. It grades the last merged pull requests the way new ones are graded.</p> : null}
      {b?.status === "running" ? <p class="bt__line">Grading up to {b.maxPrs} merged pull requests…</p> : null}
      {b?.status === "failed" ? <p class="field__error">It stopped: {b.error ?? "unknown error"}</p> : null}
      {b?.status === "done" ? <Report b={b} repoUrl={repoUrl} /> : null}
      {error.value ? <p class="field__error" role="alert">{error.value}</p> : null}
      {b?.status !== "running" ? (
        <Button size="sm" variant="secondary" busy={busy.value} busyLabel="Starting…" onClick={run}>
          {b === null ? "Check the last 90 days" : "Run again"}
        </Button>
      ) : null}
    </section>
  );
}
