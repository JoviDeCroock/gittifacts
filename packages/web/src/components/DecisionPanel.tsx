/**
 * Review decision. Pessimistic: nothing changes on screen until the server confirms.
 * On a phone it lives in a sticky thumb-zone bar that expands upward; on desktop it sits
 * in the tour's right rail. Same states either way.
 */
import type { Change, Lane, Principal } from "@app/domain";
import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { ChangeSummary, PrincipalRef, ReviewDecisionKind, ShadowStats } from "../api/types.js";
import { LANES } from "../lib/lanes.js";
import { CHANGE_STATUS, plural, shortSha } from "../lib/vocab.js";
import { usePageCommands } from "../state/keys.js";
import { Icon } from "./Icon.js";
import { Button, LaneTag, LinkButton, StatusChip, Who } from "./ui.js";

const COPY: Record<
  ReviewDecisionKind,
  {
    title: string;
    confirm: string;
    busy: string;
    done: string;
    consequence: string;
    variant: "primary" | "secondary" | "danger";
  }
> = {
  approve: {
    title: "Approve this change",
    confirm: "Approve change",
    busy: "Signing approval…",
    done: "Approved. The change joins the merge queue.",
    consequence:
      "It merges through the queue, then rolls out 5% → 25% → 100% behind its own flag, with automatic revert if errors rise.",
    variant: "primary",
  },
  "request-changes": {
    title: "Request changes",
    confirm: "Send request",
    busy: "Sending…",
    done: "Sent. The author gets your comment and pushes a new head.",
    consequence:
      "The author agent receives your comment, pushes a new head, and the reviewer agent rewrites the walkthrough.",
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

/** What the author does after each choice, said before you choose (the rail's hint line). */
const AFTER: Record<ReviewDecisionKind, (author: string) => string> = {
  approve: (a) => `${a} is done: the merge queue lands it, then it rolls out behind its flag.`,
  "request-changes": (a) =>
    `${a} gets your comment, pushes a new head, and the walkthrough is rewritten.`,
  reject: (a) => `${a}'s change closes for good; it would have to start a new one.`,
};

const LANE_OPTS: (Lane | null)[] = [0, 1, 2, null];

/**
 * One Tab stop, arrows move and pick (radio keyboard behaviour). "No call" is the unset state:
 * a quiet text option at the end, never the teal of a choice.
 */
function LanePick({
  value,
  computed,
  onChange,
}: {
  value: Lane | null;
  computed: Lane | null;
  onChange: (l: Lane | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent, index: number) => {
    const n = LANE_OPTS.length;
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    onChange(LANE_OPTS[next] ?? null);
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div class="lane-pick" role="radiogroup" aria-label="Lane you would have picked" ref={ref}>
      {LANE_OPTS.map((l, i) => (
        <button
          key={String(l)}
          type="button"
          role="radio"
          aria-checked={value === l}
          tabIndex={value === l ? 0 : -1}
          class={`lane-pick__opt ${l === null ? "lane-pick__opt--skip" : ""}`}
          onClick={() => onChange(l)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {l === null ? (
            <span class="lane-pick__skip">No call</span>
          ) : (
            <>
              <LaneTag lane={l} size="sm" />
              <span class="lane-pick__name">{LANES[l].name}</span>
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
  /** The author as a principal (null when it could not be read): an agent's owner sees the boundary. */
  author: PrincipalRef | null;
  authorName: string;
  shadow: ShadowStats | null;
  lane0Enabled: boolean;
  layout: "bar" | "rail";
  /** The merge queue's resolved head when the resolution needs a fresh approval: what lands. */
  resolvedHead?: string | null;
  /**
   * The open sheet, when the page needs it too (the phone scrim closes it and makes the page
   * behind it inert). Setting it to null is the same as Back.
   */
  sheet?: Signal<ReviewDecisionKind | null>;
  onDecided: (change: Change) => void;
}

/** The same note the plan's signing panel shows: the boundary between a person and their agent. */
function OwnAgentNote({ author }: { author: PrincipalRef }) {
  return (
    <p class="decision__note" data-testid="decision-own-agent">
      <Icon name="bot" size={16} />
      <span>
        Your agent {author.name} wrote this change. You are allowed to approve it, but a teammate's
        eyes are the stronger check.
      </span>
    </p>
  );
}

/** Approving a resolution: the person approves what the resolver wrote, not only the agent's diff. */
const RESOLUTION_APPROVE = {
  title: "Approve the resolution",
  confirm: "Approve resolution",
  done: "Approved. The resolved change goes back into the merge queue.",
  consequence:
    "What lands is the resolver agent's version shown above, not the head the agent pushed. Approving lets the merge queue land it; it then rolls out behind its flag like any change.",
};

/** Why there is nothing to decide, for every status but awaiting-review. */
const STATUS_NOTE: Partial<Record<Change["status"], string>> = {
  "awaiting-push": "Nothing to decide until the author pushes and the checks pass.",
  running: "No decision until checks pass and the walkthrough is written.",
  failing: "Checks failed. The author has to push a fix before anyone can decide.",
  approved: "Approved. The merge queue lands it next.",
  queued: "Approved and waiting in the merge queue.",
  rejected: "Rejected. Nothing more to decide.",
  abandoned: "Closed before it merged. Nothing to decide.",
};

/**
 * After a decision: the next change waiting in this repo (never one you wrote), and for an
 * approval, where to watch it land. It rises in after the seal has drawn (tour.css).
 */
function NextUp({
  change,
  me,
  approved,
}: {
  change: Change;
  me: Principal | null;
  approved: boolean;
}) {
  const next = useSignal<{ first: ChangeSummary; left: number } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.changes(change.repoId, { status: "awaiting-review" }).then(
      (r) => {
        if (!live) return;
        const waiting = r.changes.filter(
          (c) => c.id !== change.id && c.status === "awaiting-review" && c.authorId !== me?.id,
        );
        next.value = waiting[0] ? { first: waiting[0], left: waiting.length } : null;
      },
      () => {
        if (live) next.value = null;
      },
    );
    return () => {
      live = false;
    };
  }, [change.id, change.repoId, me?.id]);
  const { route } = useLocation();
  // N (or the palette's "Next change to review") opens it, once the decision is made.
  usePageCommands(
    {
      "next-change": () => {
        if (next.value) route(`/changes/${encodeURIComponent(next.value.first.id)}`);
      },
    },
    { n: "next-change" },
  );
  if (next.value === undefined) return null;
  return (
    <div class="decision__next" data-testid="next-up">
      {next.value ? (
        <a
          class="next-up"
          href={`/changes/${encodeURIComponent(next.value.first.id)}`}
          aria-keyshortcuts="N"
        >
          <span class="next-up__label">
            Next · {plural(next.value.left, "change")} waiting{" "}
            <kbd class="kbd next-up__key" aria-hidden="true">
              N
            </kbd>
          </span>
          <span class="next-up__title">
            <LaneTag lane={next.value.first.lane} size="sm" />
            <span class="next-up__text">{next.value.first.title}</span>
          </span>
          <span class="next-up__by">
            <Who kind={next.value.first.authorKind} name={next.value.first.authorName} size={16} />
          </span>
          <Icon name="chevron-right" size={18} />
        </a>
      ) : (
        <p class="decision__fine">Nothing else in this repo waits for you.</p>
      )}
      {approved ? (
        <a class="decision__watch" href={`/repos/${encodeURIComponent(change.repoId)}/queue`}>
          <Icon name="git-merge" size={15} /> Watch it land in the merge queue
        </a>
      ) : null}
    </div>
  );
}

export function DecisionPanel({
  change,
  me,
  author,
  authorName,
  shadow,
  lane0Enabled,
  layout,
  resolvedHead = null,
  sheet,
  onDecided,
}: DecisionPanelProps) {
  const ownSheet = useSignal<ReviewDecisionKind | null>(null);
  const decision = sheet ?? ownSheet;
  const comment = useSignal("");
  const humanLane = useSignal<Lane | null>(null);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const done = useSignal<ReviewDecisionKind | null>(null);
  /** The choice under the pointer or focus: the rail says what the author does after it. */
  const hint = useSignal<ReviewDecisionKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** One key per decision attempt; a retry after a network error reuses it. */
  const intentKey = useRef<string | null>(null);
  /** The sheet that was open on the last render, so a close knows which choice to hand focus back to. */
  const wasOpen = useRef<ReviewDecisionKind | null>(null);

  // Focus follows the sheet. Opening lands on the title for Approve (its comment is optional, and on
  // a phone a focused field raises the keyboard over the sheet) and in the comment where one is
  // required. Closing (Back, Cancel, Escape, the scrim) resets the attempt and returns focus to the
  // choice that opened it. A layout effect: focus is in the sheet before the next keystroke, so an
  // Escape pressed right after A reaches the sheet's handler instead of the page.
  useLayoutEffect(() => {
    const d = decision.value;
    const was = wasOpen.current;
    wasOpen.current = d;
    if (d && d !== was) {
      const form = formRef.current;
      const target =
        d === "approve"
          ? form?.querySelector<HTMLElement>(".decision__title")
          : form?.querySelector<HTMLElement>("textarea");
      target?.focus({ preventScroll: layout === "bar" });
    } else if (!d && was && !done.value) {
      error.value = null;
      intentKey.current = null;
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-choice="${was}"]`)
        ?.focus({ preventScroll: true });
    }
  }, [decision.value, layout]);

  // Signed: focus the outcome, so "Approved…" is read first and Next up is the next Tab.
  useEffect(() => {
    if (done.value)
      rootRef.current
        ?.querySelector<HTMLElement>(".decision__done")
        ?.focus({ preventScroll: true });
  }, [done.value]);

  // A, or the palette's Approve/Request changes/Reject, open the same sheet the buttons do. Nothing signs
  // until the person confirms; the author's own change and a decided change ignore them.
  const open = (d: ReviewDecisionKind) => {
    if (change.status !== "awaiting-review" || done.value || busy.value) return;
    if (me && change.authorId === me.id) return;
    decision.value = d;
  };
  const close = () => {
    if (!busy.value) decision.value = null;
  };
  usePageCommands({
    approve: () => open("approve"),
    "request-changes": () => open("request-changes"),
    reject: () => open("reject"),
  });

  const shadowCandidate = change.computedLane === 0 && !lane0Enabled;
  const ownAgent =
    author !== null && author.kind === "agent" && me !== null && author.ownerId === me.id;

  if (done.value) {
    return (
      <div
        ref={rootRef}
        class={`decision decision--${layout} decision--done decision--done-${done.value}`}
        role="status"
        data-testid="decision-done"
        data-decision={done.value}
      >
        {done.value === "approve" ? (
          <svg class="seal" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
            <circle class="seal__ring" cx="20" cy="20" r="17" />
            <path class="seal__check" d="m12.5 20.5 5 5 10-11" />
          </svg>
        ) : (
          <Icon name={done.value === "reject" ? "ban" : "comment"} size={20} />
        )}
        <div>
          <p class="decision__done" tabIndex={-1}>
            {done.value === "approve" && resolvedHead
              ? RESOLUTION_APPROVE.done
              : COPY[done.value].done}
          </p>
          <p class="decision__fine">Signed as {me?.name ?? "you"} and recorded in the audit log.</p>
          <NextUp change={change} me={me} approved={done.value === "approve"} />
        </div>
      </div>
    );
  }

  if (change.status !== "awaiting-review") {
    const rolling = change.rolloutState !== null;
    return (
      <div class={`decision decision--${layout} decision--status`}>
        <StatusChip meta={CHANGE_STATUS[change.status]} />
        <span class="decision__fine">
          {change.status === "awaiting-push" && change.headSha
            ? "Changes requested. The author has your comment and pushes a new head next."
            : (STATUS_NOTE[change.status] ?? "This change is past review.")}
        </span>
        {rolling ? (
          <LinkButton
            href={`/changes/${change.id}/rollout`}
            size="sm"
            variant="secondary"
            icon="rocket"
          >
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
        <span class="decision__fine">
          You authored this change, so someone else has to review it.
        </span>
      </div>
    );
  }

  async function submit(e: Event) {
    e.preventDefault();
    const d = decision.value;
    if (!d || busy.value) return;
    if (d !== "approve" && !comment.value.trim()) {
      error.value =
        d === "reject"
          ? "Say why you are rejecting it. The author sees this."
          : "Tell the author what to change.";
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
      // The sheet has done its job: the page behind it is live again (no scrim, not inert).
      decision.value = null;
      onDecided(res.change);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  const d = decision.value;
  const resolving = resolvedHead !== null;
  const copy =
    d === "approve" && resolving ? { ...COPY.approve, ...RESOLUTION_APPROVE } : d ? COPY[d] : null;
  const choose = (k: ReviewDecisionKind) => ({
    "data-choice": k,
    onClick: () => (decision.value = k),
    onMouseEnter: () => (hint.value = k),
    onMouseLeave: () => (hint.value = null),
    onFocus: () => (hint.value = k),
    onBlur: () => (hint.value = null),
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the sheet from any control inside it
    <div
      ref={rootRef}
      class={`decision decision--${layout} ${d ? "is-open" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && d) {
          e.preventDefault();
          close();
        }
      }}
    >
      {d && copy ? (
        <form
          class="decision__form"
          onSubmit={submit}
          ref={formRef}
          aria-labelledby="decision-title"
          data-testid="decision-form"
        >
          <div class="decision__formhead">
            <h2 id="decision-title" class="decision__title" tabIndex={-1}>
              {copy.title}
            </h2>
            {/* On a phone, Back in the thumb zone is the one way out. */}
            {layout === "rail" ? (
              <button
                type="button"
                class="icon-btn"
                aria-label="Cancel"
                onClick={close}
                disabled={busy.value}
              >
                <Icon name="x" size={20} />
              </button>
            ) : null}
          </div>
          <p class="decision__consequence">{copy.consequence}</p>
          {ownAgent && author ? <OwnAgentNote author={author} /> : null}
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
                ? `The evidence alone says auto-merge. Your pick calibrates auto-merge for this repo${shadow ? ` (${shadow.agreed} of ${shadow.samples} agreed so far)` : ""}.`
                : "Optional. Disagreements help tune the classifier."}
            </p>
            <LanePick
              value={humanLane.value}
              computed={change.computedLane}
              onChange={(l) => (humanLane.value = l)}
            />
          </fieldset>
          {error.value ? (
            <p class="field__error" id="decision-error" role="alert">
              {error.value}
            </p>
          ) : null}
          <p class="decision__fine">
            <Icon name="signature" size={14} />
            <span>
              You sign as {me?.name ?? "yourself"} for head <code>{shortSha(change.headSha)}</code>
              {resolving ? (
                <>
                  {" "}
                  as resolved by the merge queue (<code>{shortSha(resolvedHead)}</code> lands)
                </>
              ) : null}
              .
            </span>
          </p>
          <div class="decision__confirm">
            <Button
              variant="secondary"
              onClick={close}
              disabled={busy.value}
              data-testid="decision-back"
            >
              Back
            </Button>
            <Button
              type="submit"
              variant={copy.variant === "secondary" ? "primary" : copy.variant}
              busy={busy.value}
              busyLabel={copy.busy}
              wide
              data-testid="decision-confirm"
            >
              {copy.confirm}
            </Button>
          </div>
        </form>
      ) : (
        <div class="decision__choices" role="group" aria-label="Decide on this change">
          {layout === "rail" ? (
            <h2 class="decision__title">
              {resolving ? "Your decision on the resolution" : "Your decision"}
            </h2>
          ) : null}
          {layout === "rail" && ownAgent && author ? <OwnAgentNote author={author} /> : null}
          <Button variant="secondary" class="decision__reject" {...choose("reject")}>
            Reject
          </Button>
          <Button
            variant="secondary"
            class="decision__changes"
            aria-label="Request changes"
            {...choose("request-changes")}
          >
            <span class="decision__long">Request changes</span>
            <span class="decision__short" aria-hidden="true">
              Changes
            </span>
          </Button>
          <Button
            variant="primary"
            class="decision__approve"
            icon="check"
            {...choose("approve")}
            data-testid="decision-approve"
          >
            {resolving && layout === "rail" ? "Approve resolution" : "Approve"}
          </Button>
          {layout === "rail" ? (
            <p class="decision__after" data-testid="decision-after">
              {hint.value ? AFTER[hint.value](authorName) : `${authorName} waits for your call.`}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
