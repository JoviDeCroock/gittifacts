/**
 * What a person can do to the merge queue from its page (agent-parity Q1): take an entry out or
 * change its priority (the author, its agent's owner or a reviewer), and freeze, thaw or resume
 * the whole queue (a repository owner). Each act opens inline first, names its consequence and
 * shows the agent twin where one exists; nothing acts on the first click.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import { type QueueEntryView, queueActs, type SettablePriority } from "../api/queue.js";
import { dequeueTwin, PRIORITY, PRIORITY_CHOICES, reprioritizeTwin } from "../lib/queue.js";
import { Icon } from "./Icon.js";
import { Button, CopyButton } from "./ui.js";

/** The agent's way to do the same thing, small and copyable (Mono Is Data: it is a call). */
export function AgentTwin({ call }: { call: string }) {
  return (
    <p class="q-twin">
      <span class="q-twin__label">Agent twin</span>
      <code class="q-twin__call">{call}</code>
      <CopyButton text={call} />
    </p>
  );
}

/** An act that opened inline: what happens, then Cancel and the named action. */
export function ActPanel({
  label,
  children,
  error,
}: {
  label: string;
  children: ComponentChildren;
  error: string | null;
}) {
  return (
    <fieldset class="q-act" aria-label={label}>
      {children}
      {error ? (
        <p class="field__error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

const PRIORITY_NOTE: Record<SettablePriority, string> = {
  normal: "Lands in the order it joined.",
  security: "Goes ahead of normal changes on its track.",
  incident: "Goes to the express track and may land while the queue is frozen.",
};

export function EntryActs({
  e,
  dependents,
  onActed,
}: {
  e: QueueEntryView;
  /** Titles of queued changes stacked on this one: they leave with it. */
  dependents: string[];
  onActed: (message: string) => void;
}) {
  const open = useSignal<"dequeue" | "priority" | null>(null);
  const pick = useSignal<SettablePriority>(e.priority === "revert" ? "normal" : e.priority);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const title = e.title ?? e.changeId;

  async function run(fn: (k: string) => Promise<unknown>, message: string) {
    busy.value = true;
    error.value = null;
    try {
      await fn(key.value);
      open.value = null;
      key.value = newIdempotencyKey();
      onActed(message);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }
  const toggle = (which: "dequeue" | "priority") => {
    open.value = open.value === which ? null : which;
    error.value = null;
    pick.value = e.priority === "revert" ? "normal" : e.priority;
  };

  return (
    <div class="q-acts" data-testid="queue-entry-acts">
      <div class="q-acts__buttons">
        {/* Reverts are prioritized automatically; the server ignores a class set by hand. */}
        {e.priority === "revert" ? null : (
          <Button
            size="sm"
            variant="secondary"
            icon="list-ordered"
            aria-expanded={open.value === "priority"}
            onClick={() => toggle("priority")}
          >
            Priority…
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon="archive"
          aria-expanded={open.value === "dequeue"}
          data-testid="queue-dequeue"
          onClick={() => toggle("dequeue")}
        >
          Dequeue…
        </Button>
      </div>
      {open.value === "dequeue" ? (
        <ActPanel label={`Dequeue ${title}`} error={error.value}>
          <p class="q-act__lede">
            Take <b>{title}</b> out of the merge queue?{" "}
            {dependents.length > 0
              ? `${dependents.join(", ")} ${dependents.length === 1 ? "is" : "are"} stacked on it and leave${dependents.length === 1 ? "s" : ""} too. `
              : ""}
            It keeps its approval and rejoins only when it is enqueued again.
          </p>
          <div class="q-act__buttons">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy.value}
              onClick={() => (open.value = null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={busy.value}
              busyLabel="Dequeuing…"
              data-testid="queue-dequeue-confirm"
              onClick={() =>
                run((k) => queueActs.dequeue(e.changeId, k), `Took “${title}” out of the queue.`)
              }
            >
              Dequeue
            </Button>
          </div>
          <AgentTwin call={dequeueTwin(e.changeId)} />
        </ActPanel>
      ) : null}
      {open.value === "priority" ? (
        <ActPanel label={`Priority of ${title}`} error={error.value}>
          <div class="q-act__choices" role="radiogroup" aria-label="Priority">
            {PRIORITY_CHOICES.map((p) => (
              <label key={p} class="check">
                <input
                  type="radio"
                  name={`prio-${e.changeId}`}
                  value={p}
                  checked={pick.value === p}
                  onChange={() => (pick.value = p)}
                />
                <span class="q-choice">
                  {p === "normal" ? "Normal" : PRIORITY[p].label}
                  {e.priority === p ? <span class="q-dim"> (now)</span> : null}
                </span>
                <span class="check__hint">{PRIORITY_NOTE[p]}</span>
              </label>
            ))}
          </div>
          <div class="q-act__buttons">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy.value}
              onClick={() => (open.value = null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              busy={busy.value}
              busyLabel="Saving…"
              disabled={pick.value === e.priority}
              onClick={() =>
                run(
                  (k) => queueActs.reprioritize(e.changeId, pick.value, k),
                  `“${title}” is now ${pick.value === "normal" ? "normal priority" : PRIORITY[pick.value].label.toLowerCase()}.`,
                )
              }
            >
              Set priority
            </Button>
          </div>
          <AgentTwin call={reprioritizeTwin(e.changeId, pick.value)} />
        </ActPanel>
      ) : null}
    </div>
  );
}

/** Said where an act has no agent twin, so the boundary is visible (the Twin Rule). */
function PersonOnly({ children }: { children: ComponentChildren }) {
  return (
    <p class="q-twin q-twin--person">
      <Icon name="lock" size={14} />
      <span>{children}</span>
    </p>
  );
}

/**
 * Freeze or thaw, with a reason that is signed into the audit log. Thawing clears every freeze
 * reason, the automatic ones too, so that case is named and the action turns danger.
 */
export function FreezeForm({
  repoId,
  freeze,
  automatic,
  onDone,
  onCancel,
}: {
  repoId: string;
  /** true: freeze; false: thaw. */
  freeze: boolean;
  /** Thawing would also clear a freeze the queue set itself (a failed check, a revert). */
  automatic: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const reason = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const id = `q-${freeze ? "freeze" : "thaw"}-reason`;
  const field = useRef<HTMLTextAreaElement>(null);
  // Opened on purpose: the reason is the next thing to write.
  useEffect(() => field.current?.focus(), []);

  async function submit(ev: Event) {
    ev.preventDefault();
    if (reason.value.trim() === "") {
      error.value = "Say why: the reason is signed into the audit log with your name.";
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      await queueActs.freeze(repoId, freeze, reason.value.trim(), key.value);
      onDone(
        freeze
          ? "Queue frozen. Only reverts and incident fixes land."
          : "Queue thawed. Changes land again.",
      );
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <form
      class="q-act q-act--queue"
      aria-label={freeze ? "Freeze the queue" : "Thaw the queue"}
      onSubmit={submit}
      data-testid={freeze ? "queue-freeze-form" : "queue-thaw-form"}
    >
      <p class="q-act__lede">
        {freeze
          ? "Only reverts and incident fixes land until someone thaws it. Everything else keeps speculating, so the queue picks up where it was."
          : automatic
            ? "Thawing clears the automatic freeze too: ordinary changes can land on a main the queue still considers bad."
            : "Changes land again in queue order."}
      </p>
      <div class="field">
        <label class="field__label" for={id}>
          Why
        </label>
        <textarea
          ref={field}
          id={id}
          class="textarea q-act__reason"
          rows={2}
          maxLength={2000}
          value={reason.value}
          onInput={(e) => (reason.value = e.currentTarget.value)}
          aria-invalid={error.value ? "true" : undefined}
        />
      </div>
      <div class="q-act__buttons">
        <Button size="sm" variant="secondary" disabled={busy.value} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={automatic && !freeze ? "danger" : "primary"}
          busy={busy.value}
          busyLabel={freeze ? "Freezing…" : "Thawing…"}
        >
          {freeze ? "Freeze the queue" : "Thaw the queue"}
        </Button>
      </div>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <PersonOnly>Only a person freezes or thaws the queue; agents have no twin for it.</PersonOnly>
    </form>
  );
}

/** Resume after a halt: the operator says they checked main; the queue rebuilds on it. */
export function ResumeAct({
  repoId,
  onDone,
}: {
  repoId: string;
  onDone: (message: string) => void;
}) {
  const open = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

  async function resume() {
    busy.value = true;
    error.value = null;
    try {
      await queueActs.resume(repoId);
      open.value = false;
      onDone("Queue resumed. It rebuilds its batches on main as it is now.");
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  if (!open.value) {
    return (
      <div class="q-banner__acts">
        <Button
          size="sm"
          variant="secondary"
          icon="redo"
          data-testid="queue-resume"
          onClick={() => (open.value = true)}
        >
          Resume the queue…
        </Button>
      </div>
    );
  }
  return (
    <ActPanel label="Resume the queue" error={error.value}>
      <p class="q-act__lede">
        Resume only once main is what it should be. The queue rebuilds every batch on main as it is
        now, and your name goes in the audit log.
      </p>
      <div class="q-act__buttons">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy.value}
          onClick={() => (open.value = false)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy.value}
          busyLabel="Resuming…"
          data-testid="queue-resume-confirm"
          onClick={resume}
        >
          Resume the queue
        </Button>
      </div>
      <PersonOnly>Only a person resumes a halted queue; agents have no twin for it.</PersonOnly>
    </ActPanel>
  );
}
