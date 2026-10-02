/**
 * Review decision. Pessimistic: nothing changes on screen until the server confirms.
 * On a phone it lives in a sticky thumb-zone bar that expands upward; on desktop it sits
 * in the tour's right rail. Same states either way.
 */
import type { Change, Lane, Principal } from "@app/domain";
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { ReviewDecisionKind, ShadowStats } from "../api/types.js";
import { LANES } from "../lib/lanes.js";
import { CHANGE_STATUS, shortSha } from "../lib/vocab.js";
import { Icon } from "./Icon.js";
import { Button, LaneTag, LinkButton, StatusChip } from "./ui.js";

const COPY: Record<ReviewDecisionKind, { title: string; confirm: string; busy: string; done: string; consequence: string; variant: "primary" | "secondary" | "danger" }> = {
  approve: {
    title: "Approve this change",
    confirm: "Approve change",
    busy: "Signing approval…",
    done: "Approved. The change joins the merge queue.",
    consequence: "It merges through the queue, then rolls out 5% → 25% → 100% behind its own flag, with automatic revert if errors rise.",
    variant: "primary",
  },
  "request-changes": {
    title: "Request changes",
    confirm: "Send request",
    busy: "Sending…",
    done: "Sent. The author gets your comment and pushes a new head.",
    consequence: "The author agent receives your comment, pushes a new head, and the reviewer agent rewrites the tour.",
    variant: "secondary",
  },
  reject: {
    title: "Reject this change",
    confirm: "Reject change",
    busy: "Rejecting…",
    done: "Rejected. The change is closed.",
    consequence: "The change closes for good. The author has to start a new change to try again.",
    variant: "danger",
  },
};

function LanePick({ value, computed, onChange }: { value: Lane | null; computed: Lane | null; onChange: (l: Lane | null) => void }) {
  const opts: (Lane | null)[] = [0, 1, 2, null];
  return (
    <div class="lane-pick" role="radiogroup" aria-label="Lane you would have picked">
      {opts.map((l) => (
        <button
          key={String(l)}
          type="button"
          role="radio"
          aria-checked={value === l}
          class="lane-pick__opt"
          onClick={() => onChange(l)}
        >
          {l === null ? (
            <span class="lane-pick__skip">No call</span>
          ) : (
            <>
              <LaneTag lane={l} size="sm" />
              <span class="lane-pick__name">{LANES[l].short}</span>
              {computed === l ? <span class="lane-pick__computed">computed</span> : null}
            </>
          )}
        </button>
      ))}
    </div>
  );
}

interface DecisionPanelProps {
  change: Change;
  me: Principal | null;
  authorName: string;
  shadow: ShadowStats | null;
  lane0Enabled: boolean;
  layout: "bar" | "rail";
  onDecided: (change: Change) => void;
}

/** Why there is nothing to decide, for every status but awaiting-review. */
const STATUS_NOTE: Partial<Record<Change["status"], string>> = {
  "awaiting-push": "Nothing to decide until the author pushes and the checks pass.",
  running: "No decision until checks pass and the tour is written.",
  failing: "Checks failed. The author has to push a fix before anyone can decide.",
  approved: "Approved. The merge queue lands it next.",
  queued: "Approved and waiting in the merge queue.",
  rejected: "Rejected. Nothing more to decide.",
  abandoned: "Closed by its author. Nothing to decide.",
};

export function DecisionPanel({ change, me, authorName, shadow, lane0Enabled, layout, onDecided }: DecisionPanelProps) {
  const decision = useSignal<ReviewDecisionKind | null>(null);
  const comment = useSignal("");
  const humanLane = useSignal<Lane | null>(null);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const done = useSignal<ReviewDecisionKind | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** One key per decision attempt; a retry after a network error reuses it. */
  const intentKey = useRef<string | null>(null);

  useEffect(() => {
    if (decision.value && layout === "bar") formRef.current?.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: true });
  }, [decision.value, layout]);

  const shadowCandidate = change.computedLane === 0 && !lane0Enabled;

  if (done.value) {
    return (
      <div class={`decision decision--${layout} decision--done decision--done-${done.value}`} role="status">
        {done.value === "approve" ? (
          <svg class="seal" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
            <circle class="seal__ring" cx="20" cy="20" r="17" />
            <path class="seal__check" d="m12.5 20.5 5 5 10-11" />
          </svg>
        ) : (
          <Icon name={done.value === "reject" ? "ban" : "comment"} size={20} />
        )}
        <div>
          <p class="decision__done">{COPY[done.value].done}</p>
          <p class="decision__fine">Signed as {me?.name ?? "you"} and recorded in the audit log.</p>
        </div>
      </div>
    );
  }

  if (change.status !== "awaiting-review") {
    const rolling = change.rolloutState !== null;
    return (
      <div class={`decision decision--${layout} decision--status`}>
        <StatusChip meta={CHANGE_STATUS[change.status]} />
        <span class="decision__fine">{STATUS_NOTE[change.status] ?? "This change is past review."}</span>
        {rolling ? (
          <LinkButton href={`/changes/${change.id}/rollout`} size="sm" variant="secondary" icon="rocket">
            Rollout
          </LinkButton>
        ) : null}
      </div>
    );
  }

  if (me && change.authorId === me.id) {
    return (
      <div class={`decision decision--${layout} decision--status`}>
        <Icon name="lock" size={18} />
        <span class="decision__fine">You authored this change, so someone else has to review it.</span>
      </div>
    );
  }

  async function submit(e: Event) {
    e.preventDefault();
    const d = decision.value;
    if (!d || busy.value) return;
    if (d !== "approve" && !comment.value.trim()) {
      error.value = d === "reject" ? "Say why you are rejecting it. The author sees this." : "Tell the author what to change.";
      return;
    }
    busy.value = true;
    error.value = null;
    intentKey.current ??= newIdempotencyKey();
    try {
      const res = await api.review(
        change.id,
        {
          decision: d,
          ...(humanLane.value !== null ? { humanLane: humanLane.value } : {}),
          ...(comment.value.trim() ? { comment: comment.value.trim() } : {}),
        },
        intentKey.current,
      );
      done.value = d;
      onDecided(res.change);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  const d = decision.value;
  return (
    <div class={`decision decision--${layout} ${d ? "is-open" : ""}`}>
      {d ? (
        <form class="decision__form" onSubmit={submit} ref={formRef} aria-labelledby="decision-title">
          <div class="decision__formhead">
            <h2 id="decision-title" class="decision__title">
              {COPY[d].title}
            </h2>
            <button type="button" class="icon-btn" aria-label="Cancel" onClick={() => ((decision.value = null), (error.value = null), (intentKey.current = null))}>
              <Icon name="x" size={20} />
            </button>
          </div>
          <p class="decision__consequence">{COPY[d].consequence}</p>
          <label class="field">
            <span class="field__label">
              Comment for {authorName}
              {d === "approve" ? <span class="field__hint"> (optional)</span> : null}
            </span>
            <textarea
              class="textarea"
              rows={layout === "bar" ? 2 : 3}
              value={comment.value}
              onInput={(e) => (comment.value = e.currentTarget.value)}
              aria-invalid={error.value && d !== "approve" ? "true" : undefined}
              aria-describedby={error.value ? "decision-error" : undefined}
            />
          </label>
          <fieldset class="decision__lane">
            <legend class="field__label">Which lane would you have picked?</legend>
            <p class="field__hint">
              {shadowCandidate
                ? `Evidence computed Lane 0. Your call trains shadow mode${shadow ? ` (${shadow.agreed} of ${shadow.samples} agreed so far)` : ""}.`
                : "Optional. Disagreements help tune the classifier."}
            </p>
            <LanePick value={humanLane.value} computed={change.computedLane} onChange={(l) => (humanLane.value = l)} />
          </fieldset>
          {error.value ? (
            <p class="field__error" id="decision-error" role="alert">
              {error.value}
            </p>
          ) : null}
          <p class="decision__fine">
            <Icon name="signature" size={14} /> You sign as {me?.name ?? "yourself"} for head <code>{shortSha(change.headSha)}</code>.
          </p>
          <div class="decision__confirm">
            <Button variant="secondary" onClick={() => ((decision.value = null), (error.value = null), (intentKey.current = null))} disabled={busy.value}>
              Back
            </Button>
            <Button type="submit" variant={COPY[d].variant === "secondary" ? "primary" : COPY[d].variant} busy={busy.value} busyLabel={COPY[d].busy} wide>
              {COPY[d].confirm}
            </Button>
          </div>
        </form>
      ) : (
        <div class="decision__choices" role="group" aria-label="Decide on this change">
          {layout === "rail" ? <h2 class="decision__title">Your decision</h2> : null}
          <Button variant="secondary" class="decision__reject" onClick={() => (decision.value = "reject")}>
            Reject
          </Button>
          <Button variant="secondary" class="decision__changes" onClick={() => (decision.value = "request-changes")}>
            Request changes
          </Button>
          <Button variant="primary" class="decision__approve" icon="check" onClick={() => (decision.value = "approve")}>
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}
