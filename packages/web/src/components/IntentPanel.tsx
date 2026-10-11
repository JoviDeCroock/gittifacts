/**
 * "What should change?" on the repo page: the way a person starts work. They write the intent;
 * the panel hands back the prompt for their agent, which drafts the Plan (`create_plan`) for them
 * to approve, because nobody approves their own Plan. When another member can approve (a
 * maintainer or owner), the person may also draft the Plan themselves (POST /api/v1/plans).
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { useLocation } from "preact-iso";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import { membersApi } from "../api/members.js";
import { agentPrompt } from "../lib/start.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import { Icon } from "./Icon.js";
import { Term } from "./Term.js";
import { Button, CopyButton } from "./ui.js";
import "../styles/intent.css";

/** A title from the intent's first sentence, within the Plan's 3 to 200 characters. */
function titleFrom(intent: string): string {
  const first = intent.trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";
  const t = first.replace(/[.!?]+$/, "").trim();
  return t.length > 120 ? `${t.slice(0, 117).trimEnd()}…` : t;
}

export function IntentPanel({ repoId }: { repoId: string }) {
  const intent = useSignal("");
  const mode = useSignal<"agent" | "self">("agent");
  const title = useSignal("");
  const criteria = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const box = useRef<HTMLTextAreaElement>(null);
  const { route, url } = useLocation();
  const members = useResource(() => membersApi.list(repoId), [repoId]);
  const me = principal.value;
  const text = intent.value.trim();

  // The palette's "What should change?" lands on #intent: start typing at once.
  useEffect(() => {
    if (window.location.hash === "#intent") box.current?.focus({ preventScroll: true });
  }, [url]);

  const m = members.state.value.status === "ok" ? members.state.value.data : null;
  const canDraft =
    !!me &&
    me.scopes.includes("plan:create") &&
    (m?.viewerRole === "reviewer" || m?.viewerRole === "maintainer" || m?.viewerRole === "owner");
  const approver =
    m?.members.find(
      (x) => x.principalId !== me?.id && (x.role === "maintainer" || x.role === "owner"),
    ) ?? null;
  const selfOk = canDraft && approver !== null;

  async function draft(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const lines = criteria.value
      .split("\n")
      .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
      .filter(Boolean);
    const t = (title.value.trim() || titleFrom(text)).trim();
    if (text.length < 10)
      return void (error.value =
        "Say a little more about what should change (at least 10 characters).");
    if (t.length < 3) return void (error.value = "Give the Plan a title of at least 3 characters.");
    if (lines.length === 0)
      return void (error.value = "Add at least one way to tell it worked, one per line.");
    busy.value = true;
    error.value = null;
    try {
      const { plan } = await api.createPlan(
        { repoId, title: t, intent: text, acceptanceCriteria: lines },
        key.current,
      );
      route(`/plans/${encodeURIComponent(plan.id)}`);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  const prompt = agentPrompt(window.location.origin, repoId, text || "<what should change>");
  return (
    <section class="intent" id="intent" aria-labelledby="intent-title" data-testid="intent">
      <h2 id="intent-title" class="intent__title">
        What should change?
      </h2>
      <label class="field">
        <span class="sr-only">What should change</span>
        <textarea
          ref={box}
          class="textarea intent__box"
          rows={2}
          value={intent.value}
          onInput={(e) => (intent.value = e.currentTarget.value)}
          placeholder="Invoices show the tax line in the customer's currency."
          data-testid="intent-text"
        />
      </label>
      {mode.value === "agent" ? (
        <div class="intent__out" data-testid="intent-agent">
          <p class="intent__how">
            Paste this to your agent. It drafts the <Term id="plan">Plan</Term> and you approve it;
            then it builds a <Term id="change">Change</Term> with its proof.
          </p>
          <div class="intent__prompt">
            <code class="intent__code" data-testid="intent-prompt">
              {prompt}
            </code>
            {text ? <CopyButton text={prompt} label="Copy prompt" /> : null}
          </div>
          {selfOk ? (
            <button
              type="button"
              class="linklike intent__switch"
              onClick={() => (mode.value = "self")}
              data-testid="intent-self"
            >
              Draft the plan yourself
            </button>
          ) : null}
        </div>
      ) : (
        <form class="intent__out" onSubmit={draft} noValidate data-testid="intent-self-form">
          <p class="intent__how">
            <Icon name="user" size={15} /> You write the Plan; {approver?.name ?? "another member"}{" "}
            (or another maintainer) approves it. Nobody approves their own Plan.
          </p>
          <label class="field">
            <span class="field__label">Title</span>
            <input
              class="input"
              value={title.value}
              placeholder={titleFrom(text) || "Tax line in the customer's currency"}
              onInput={(e) => (title.value = e.currentTarget.value)}
              data-testid="intent-title-input"
            />
          </label>
          <label class="field">
            <span class="field__label">How to tell it worked</span>
            <textarea
              class="textarea"
              rows={3}
              value={criteria.value}
              onInput={(e) => (criteria.value = e.currentTarget.value)}
              placeholder="One per line"
              aria-describedby="intent-criteria-hint"
              data-testid="intent-criteria"
            />
            <span class="field__hint" id="intent-criteria-hint">
              One acceptance criterion per line.
            </span>
          </label>
          {error.value ? (
            <p class="field__error" role="alert">
              {error.value}
            </p>
          ) : null}
          <div class="intent__actions">
            <Button
              variant="secondary"
              onClick={() => ((mode.value = "agent"), (error.value = null))}
            >
              Back
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon="file-text"
              busy={busy.value}
              busyLabel="Drafting…"
              data-testid="intent-draft"
            >
              Draft the plan
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
