/**
 * The decision on the consent (`/oauth/consent`) and device (`/device`) screens: who is asking,
 * what it may do in plain words, what it can never do, which repositories, for how long.
 *
 * Repositories are an explicit choice: specific repos (the default; nothing is pre-picked when
 * there is more than one), or "All repositories", which the human has to select on purpose.
 * Approval-class scopes are never offered.
 */
import type { Scope } from "@app/domain";
import { useComputed, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import type { ConsentDecision, ConsentView } from "../api/oauth.js";
import {
  audiencePhrase,
  consentCopy,
  formatUserCode,
  sessionLengthPhrase,
} from "../lib/consent-copy.js";
import { countdown } from "../lib/time.js";
import { useTick } from "../state/clock.js";
import { Icon } from "./Icon.js";
import { BrandMark } from "./Shell.js";
import { Avatar, Button, Segmented } from "./ui.js";
import "../styles/consent.css";

const SCOPE_TEXT: Record<string, { label: string; hint: string }> = {
  "change:create": {
    label: "Open Changes",
    hint: "Start Changes and push to their own forks. A person still reviews every one.",
  },
  "plan:create": { label: "Draft Plans", hint: "Propose Plans. Only a person can approve one." },
  "repo:read": { label: "Read", hint: "Clone and read code, Changes, tours and evidence." },
};

/** Most consequential first, matching the copy. */
const SCOPE_ORDER: Scope[] = ["change:create", "plan:create", "repo:read"];

/** The focused frame both screens share: brand, one column, no navigation to wander off to. */
export function ConsentFrame({
  children,
  wide,
  class: cls,
}: {
  children: ComponentChildren;
  wide?: boolean;
  class?: string;
}) {
  return (
    <div class="consent-frame">
      <header class="consent-frame__brand">
        <a href="/" class="brand" aria-label="gittifacts home">
          <BrandMark />
          <span class="brand__word">gittifacts</span>
        </a>
      </header>
      <main
        id="main"
        class={`consent-frame__main ${wide ? "consent-frame__main--wide" : ""} ${cls ?? ""}`}
      >
        {children}
      </main>
    </div>
  );
}

/** A finished or failed state: one icon, one sentence, one way forward. */
export function ConsentOutcome({
  tone,
  title,
  children,
  action,
}: {
  tone: "ok" | "neutral" | "danger";
  title: string;
  children?: ComponentChildren;
  action?: ComponentChildren;
}) {
  const icon = tone === "ok" ? "check-circle" : tone === "danger" ? "triangle-alert" : "info";
  return (
    <section class={`consent-outcome consent-outcome--${tone}`} role="status" aria-live="polite">
      <Icon name={icon} size={24} />
      <h1 class="consent-outcome__title">{title}</h1>
      {children ? <div class="consent-outcome__body">{children}</div> : null}
      {action ? <div class="consent-outcome__action">{action}</div> : null}
    </section>
  );
}

interface ConsentPanelProps {
  view: ConsentView;
  onApprove: (d: ConsentDecision, key: string) => Promise<void>;
  onDeny: (key: string) => Promise<void>;
}

export function ConsentPanel({ view, onApprove, onDeny }: ConsentPanelProps) {
  const grantable = SCOPE_ORDER.filter((s) => view.grantableScopes.includes(s));
  const requested = view.requestedScopes.filter((s) => grantable.includes(s));
  const scopes = useSignal<Scope[]>(
    requested.length > 0 ? requested : grantable.filter((s) => s !== "plan:create"),
  );
  const repoMode = useSignal<"some" | "all">("some");
  const picked = useSignal<string[]>(
    view.repos.length === 1 && view.repos[0] ? [view.repos[0].id] : [],
  );
  const days = useSignal(String(view.defaultSessionDays));
  const busy = useSignal<"approve" | "deny" | null>(null);
  const error = useSignal<string | null>(null);
  // One key per intent, reused on retry (idempotency).
  const keys = useSignal({ approve: newIdempotencyKey(), deny: newIdempotencyKey() });
  const now = useTick(1000);

  const names = useComputed(() =>
    picked.value.map((id) => view.repos.find((r) => r.id === id)?.name ?? id),
  );
  const copy = useComputed(() =>
    consentCopy({
      clientName: view.client.name,
      scopes: scopes.value,
      repos: repoMode.value === "all" ? { kind: "all" } : { kind: "some", names: names.value },
      never: view.neverScopes,
    }),
  );
  const missing =
    scopes.value.length === 0
      ? "Pick at least one thing it may do."
      : repoMode.value === "some" && picked.value.length === 0
        ? "Pick at least one repository."
        : null;
  const endsAt = new Date(now.value + Number(days.value) * 86_400_000);
  const remaining = countdown(view.expiresAt, now.value);
  const device = view.flow === "device_code";

  function toggleScope(s: Scope, on: boolean) {
    scopes.value = on
      ? SCOPE_ORDER.filter((x) => x === s || scopes.value.includes(x))
      : scopes.value.filter((x) => x !== s);
  }
  function toggleRepo(id: string, on: boolean) {
    picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id);
  }

  async function approve(e: Event) {
    e.preventDefault();
    if (busy.value || missing) {
      if (missing) error.value = missing;
      return;
    }
    busy.value = "approve";
    error.value = null;
    try {
      await onApprove(
        {
          scopes: scopes.value,
          repoIds: repoMode.value === "all" ? null : picked.value,
          sessionDays: Number(days.value),
        },
        keys.value.approve,
      );
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = null;
    }
  }

  async function deny() {
    if (busy.value) return;
    busy.value = "deny";
    error.value = null;
    try {
      await onDeny(keys.value.deny);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = null;
    }
  }

  return (
    <form class="consent" onSubmit={approve} aria-labelledby="consent-title">
      <section class="consent__who">
        <Avatar kind="agent" name={view.client.name} size={44} />
        <div class="consent__who-text">
          <p class="consent__client">{view.client.name}</p>
          <p class="consent__vouch">
            {view.client.kind === "first-party" ? (
              <>
                <Icon name="badge-check" size={14} /> The gittifacts command-line tool
              </>
            ) : (
              <>
                <Icon name="lock" size={14} /> Identified by <b>{view.client.host}</b>
              </>
            )}
          </p>
          {view.redirectHost ? (
            <p class="consent__return">Sends you back to {view.redirectHost} when you decide</p>
          ) : null}
        </div>
      </section>

      {device ? (
        <p class="consent__code">
          <span>Code</span>
          <code class="consent__code-value">{formatUserCode(view.id)}</code>
          <span class="consent__code-hint">Check it matches the code on your terminal.</span>
        </p>
      ) : null}

      <section class="consent__ask" aria-live="polite">
        <h1 id="consent-title" class="consent__title">
          {copy.value.lead}
        </h1>
        {copy.value.can.length > 0 ? (
          <ul class="consent__can">
            {copy.value.can.map((line) => (
              <li key={line}>
                <Icon name="check" size={16} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="consent__empty">{copy.value.summary}</p>
        )}
        <p class="consent__how">
          {audiencePhrase(view.audience.map((a) => a.label))},{" "}
          {sessionLengthPhrase(Number(days.value))}, as a new agent you are accountable for.
        </p>
      </section>

      <section class="consent__never" aria-labelledby="never-title">
        <h2 id="never-title" class="consent__never-title">
          <Icon name="shield-check" size={16} /> It can never
        </h2>
        <ul>
          {copy.value.never.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p class="consent__never-why">
          Humans approve intent. No agent holds these, whatever it asks for.
        </p>
      </section>

      <fieldset class="consent__group">
        <legend class="consent__legend">Repositories</legend>
        <Segmented
          label="Which repositories"
          value={repoMode.value}
          options={[
            { id: "some", label: "Choose repositories" },
            { id: "all", label: "All repositories" },
          ]}
          onChange={(v) => {
            repoMode.value = v;
          }}
        />
        {repoMode.value === "some" ? (
          view.repos.length === 0 ? (
            <p class="field__hint">You have no repositories to share yet.</p>
          ) : (
            <ul class="consent__repos">
              {view.repos.map((r) => (
                <li key={r.id}>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={picked.value.includes(r.id)}
                      onChange={(e) => toggleRepo(r.id, e.currentTarget.checked)}
                    />
                    <span class="consent__repo-name">{r.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p class="consent__broad" role="note">
            <Icon name="triangle-alert" size={16} />
            Every repository you can access today, and any you get later. Prefer specific ones.
          </p>
        )}
      </fieldset>

      <fieldset class="consent__group">
        <legend class="consent__legend">What it may do</legend>
        {grantable.map((s) => (
          <label key={s} class="check consent__scope">
            <input
              type="checkbox"
              checked={scopes.value.includes(s)}
              onChange={(e) => toggleScope(s, e.currentTarget.checked)}
            />
            <span>
              {SCOPE_TEXT[s]?.label ?? s}
              {view.requestedScopes.includes(s) ? (
                <span class="consent__asked">asked for</span>
              ) : null}
            </span>
            <span class="check__hint">{SCOPE_TEXT[s]?.hint}</span>
          </label>
        ))}
      </fieldset>

      <fieldset class="consent__group">
        <legend class="consent__legend">Session length</legend>
        <Segmented
          label="Session length"
          value={days.value}
          options={view.sessionDayChoices.map((d) => ({
            id: String(d),
            label: d === 1 ? "1 day" : `${d} days`,
          }))}
          onChange={(v) => {
            days.value = v;
          }}
        />
        <p class="field__hint">
          Ends{" "}
          {endsAt.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}.
          Revoke it any time on the <a href="/agents">Agents</a> page.
        </p>
      </fieldset>

      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}

      <div class="consent-bar">
        <p class="consent-bar__time">
          <Icon name="timer" size={14} /> Decide within <span class="tnum">{remaining}</span>
        </p>
        <div class="consent-bar__actions">
          <Button
            variant="secondary"
            busy={busy.value === "deny"}
            busyLabel="Denying…"
            disabled={busy.value === "approve"}
            onClick={deny}
          >
            Deny
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon="check"
            busy={busy.value === "approve"}
            busyLabel="Approving…"
            disabled={busy.value === "deny" || missing !== null}
            aria-describedby={missing ? "consent-missing" : undefined}
          >
            Allow {view.client.name}
          </Button>
        </div>
        {missing ? (
          <p class="consent-bar__missing" id="consent-missing">
            {missing}
          </p>
        ) : null}
      </div>
    </form>
  );
}
