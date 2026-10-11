/**
 * The decision on the consent (`/oauth/consent`) and device (`/device`) screens: who is asking,
 * who is approving, what it may do in plain words, which repositories, what it can never do, its
 * name and how long it lasts.
 *
 * Repositories are an explicit choice: specific repos (the default; nothing is pre-picked when
 * there is more than one), or "All repositories", which the human has to select on purpose.
 * Approval-class scopes are never offered. The person approving is named in the bar, with a way
 * to switch account, because they become accountable for the new agent.
 */
import type { Scope } from "@app/domain";
import { useComputed, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import { type ConsentDecision, type ConsentView, oauthApi } from "../api/oauth.js";
import {
  audiencePhrase,
  consentCopy,
  formatUserCode,
  repoPhrase,
  sessionLengthPhrase,
} from "../lib/consent-copy.js";
import { countdown, countdownWords } from "../lib/time.js";
import { useTick } from "../state/clock.js";
import { session, signOut } from "../state/session.js";
import { Icon } from "./Icon.js";
import { RepoPicker } from "./Integrations.js";
import { BrandMark } from "./Shell.js";
import { Avatar, Button, Segmented } from "./ui.js";
import "../styles/consent.css";

const SCOPE_TEXT: Record<string, { label: string; hint: string }> = {
  "change:create": {
    label: "Open Changes",
    hint: "Start Changes and push to their own forks. A person still reviews every one.",
  },
  "plan:create": { label: "Draft Plans", hint: "Propose Plans. Only a person can approve one." },
  "repo:read": { label: "Read", hint: "Clone and read code, Changes, walkthroughs and evidence." },
};

/** Most consequential first, matching the copy. */
const SCOPE_ORDER: Scope[] = ["change:create", "plan:create", "repo:read"];

/** The countdown turns urgent (words, carmine text, one polite announcement) at this point. */
const URGENT_MS = 60_000;

/** The focused frame every signing screen shares: a plain mark (no link out), one column. */
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
        {/* Not a link: a pending signing decision has nowhere to wander off to. */}
        <span class="brand">
          <BrandMark />
          <span class="brand__word">gittifacts</span>
        </span>
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

/**
 * A finished or failed state: one icon, one heading, what was recorded, one way forward. The
 * heading takes focus when it arrives (a live region that mounts with its text is often not
 * read) and names the tab.
 */
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
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · gittifacts`;
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <section class={`consent-outcome consent-outcome--${tone}`} data-testid="consent-outcome">
      <Icon name={icon} size={24} />
      <h1 class="consent-outcome__title" tabIndex={-1} ref={heading}>
        {title}
      </h1>
      {children ? <div class="consent-outcome__body">{children}</div> : null}
      {action ? <div class="consent-outcome__action">{action}</div> : null}
    </section>
  );
}

/** What a person granted, kept for the receipt on the outcome screen. */
export interface Granted {
  name: string;
  scopes: Scope[];
  /** Repo names, or "all". */
  repos: string[] | "all";
  endsAt: Date;
  approver: string | null;
}

/** The receipt: what was just signed, in the words the form used, and where it is recorded. */
export function ConsentReceipt({ granted }: { granted: Granted }) {
  const can = SCOPE_ORDER.filter((s) => granted.scopes.includes(s)).map(
    (s) => SCOPE_TEXT[s]?.label ?? s,
  );
  return (
    <>
      <dl class="consent-receipt" data-testid="consent-receipt">
        <div>
          <dt>Agent</dt>
          <dd class="consent-receipt__agent">
            <Avatar kind="agent" name={granted.name} size={20} />
            <span data-testid="consent-receipt-name">{granted.name}</span>
          </dd>
        </div>
        <div>
          <dt>Can</dt>
          <dd>{can.join(" · ")}</dd>
        </div>
        <div>
          <dt>On</dt>
          <dd>
            {granted.repos === "all"
              ? "All your repositories, and any you get later"
              : repoPhrase({ kind: "some", names: granted.repos })}
          </dd>
        </div>
        <div>
          <dt>Until</dt>
          <dd>{longDate(granted.endsAt)}</dd>
        </div>
        {granted.approver ? (
          <div>
            <dt>Accountable</dt>
            <dd>{granted.approver}</dd>
          </div>
        ) : null}
      </dl>
      <p class="consent-receipt__audit">
        <Icon name="scroll-text" size={14} /> Recorded in the audit log.
      </p>
    </>
  );
}

function longDate(d: Date): string {
  return d.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

/** "Quill Agent", or "Quill Agent 2" when an active session already has that name. */
export function suggestName(client: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(client.toLowerCase())) return client;
  for (let i = 2; ; i++) {
    const next = `${client} ${i}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

interface ConsentPanelProps {
  view: ConsentView;
  onApprove: (d: ConsentDecision, key: string, granted: Granted) => Promise<void>;
  onDeny: (key: string) => Promise<void>;
  /** Shown in place of the form once the countdown runs out: what happened and what to do. */
  expired: ComponentChildren;
}

export function ConsentPanel({ view, onApprove, onDeny, expired }: ConsentPanelProps) {
  const grantable = SCOPE_ORDER.filter((s) => view.grantableScopes.includes(s));
  const requested = view.requestedScopes.filter((s) => grantable.includes(s));
  const scopes = useSignal<Scope[]>(
    requested.length > 0 ? requested : grantable.filter((s) => s !== "plan:create"),
  );
  const repoMode = useSignal<"selected" | "all">("selected");
  const picked = useSignal<string[]>(
    view.repos.length === 1 && view.repos[0] ? [view.repos[0].id] : [],
  );
  const days = useSignal(String(view.defaultSessionDays));
  const name = useSignal(view.client.name);
  const nameEdited = useSignal(false);
  const busy = useSignal<"approve" | "deny" | null>(null);
  const error = useSignal<string | null>(null);
  // One key per intent, reused on retry (idempotency).
  const keys = useSignal({ approve: newIdempotencyKey(), deny: newIdempotencyKey() });
  const now = useTick(1000);
  const form = useRef<HTMLFormElement>(null);

  const s = session.value;
  const approver = s.status === "authed" ? (s.me.user?.name ?? s.me.principal.name) : null;

  // Two connections from one client should not become two identical squares: suggest a free name.
  useEffect(() => {
    let live = true;
    oauthApi
      .sessions()
      .then(({ sessions }) => {
        if (!live || nameEdited.value) return;
        const taken = sessions.filter((x) => x.status === "active").map((x) => x.name);
        name.value = suggestName(view.client.name, taken);
      })
      .catch(() => {
        /* the client's name is a fine default */
      });
    return () => {
      live = false;
    };
  }, [view.client.name]);

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
  const missing: { text: string; focus: string } | null =
    scopes.value.length === 0
      ? { text: "Pick at least one thing it may do.", focus: ".consent__scope input" }
      : repoMode.value === "selected" && picked.value.length === 0
        ? {
            text:
              view.repos.length === 0
                ? "You have no repositories to share yet."
                : "Pick at least one repository.",
            focus: ".repo-picker__list input",
          }
        : null;
  const endsAt = new Date(now.value + Number(days.value) * 86_400_000);
  const msLeft = Date.parse(view.expiresAt) - now.value;
  const device = view.flow === "device_code";

  // Time is up: the server would refuse an Allow now, so say so and say what to do instead.
  if (msLeft <= 0 && busy.value !== "approve") return <>{expired}</>;

  function toggleScope(sc: Scope, on: boolean) {
    scopes.value = on
      ? SCOPE_ORDER.filter((x) => x === sc || scopes.value.includes(x))
      : scopes.value.filter((x) => x !== sc);
  }
  function toggleRepo(id: string, on: boolean) {
    picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id);
  }
  /** The disabled Allow's reason is a button: it takes you to the choice that is missing. */
  function goToMissing() {
    const el = missing ? form.current?.querySelector<HTMLInputElement>(missing.focus) : null;
    el?.focus();
    el?.scrollIntoView({ block: "center" });
  }

  async function approve(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    if (missing) {
      goToMissing();
      return;
    }
    busy.value = "approve";
    error.value = null;
    const agentName = name.value.trim();
    try {
      await onApprove(
        {
          scopes: scopes.value,
          repoIds: repoMode.value === "all" ? null : picked.value,
          sessionDays: Number(days.value),
          ...(agentName ? { name: agentName } : {}),
        },
        keys.value.approve,
        {
          name: agentName || view.client.name,
          scopes: scopes.value,
          repos: repoMode.value === "all" ? "all" : names.value,
          endsAt,
          approver,
        },
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
    <form class="consent" ref={form} onSubmit={approve} aria-labelledby="consent-title">
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
                {/* Where the client's details live, not a verification: no padlock. */}
                <Icon name="globe" size={14} /> Client details from <b>{view.client.host}</b>
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

      <section class="consent__ask">
        <h1 id="consent-title" class="consent__title">
          {copy.value.lead}
        </h1>
        {/* Only the list is live: a toggle re-reads what changed, not the heading. */}
        <div aria-live="polite" aria-atomic="true">
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
        </div>
        <p class="consent__how">
          {audiencePhrase(view.audience.map((a) => a.label))},{" "}
          {sessionLengthPhrase(Number(days.value))}, as a new agent{" "}
          {approver ? `you, ${approver}, are` : "you are"} accountable for.
        </p>
      </section>

      <fieldset class="consent__group">
        <legend class="consent__legend">Repositories</legend>
        <RepoPicker
          name="consent-repos"
          repos={view.repos.map((r) => ({ ...r, fullName: r.name }))}
          selection={repoMode.value}
          picked={picked.value}
          onSelection={(v) => (repoMode.value = v)}
          onToggle={toggleRepo}
          allLabel="All repositories you can access"
          later="any you get access to later"
          none="You have no repositories to share yet. Create or claim one first."
          allNote={
            <p class="consent__broad" role="note">
              <Icon name="triangle-alert" size={16} />
              <span>
                <b>Every repository, now and later.</b> A new repository is reachable the day you
                get it, without asking you again. Prefer specific ones.
              </span>
            </p>
          }
        />
      </fieldset>

      <fieldset class="consent__group">
        <legend class="consent__legend">What it may do</legend>
        {grantable.map((sc) => {
          const hintId = `scope-hint-${sc.replace(":", "-")}`;
          return (
            <label key={sc} class="check consent__scope">
              <input
                type="checkbox"
                checked={scopes.value.includes(sc)}
                onChange={(e) => toggleScope(sc, e.currentTarget.checked)}
                aria-describedby={hintId}
              />
              <span>
                {SCOPE_TEXT[sc]?.label ?? sc}
                {view.requestedScopes.includes(sc) ? (
                  <span class="consent__asked">
                    <span class="sr-only"> (</span>asked for<span class="sr-only">)</span>
                  </span>
                ) : null}
              </span>
              <span class="check__hint" id={hintId} aria-hidden="true">
                {SCOPE_TEXT[sc]?.hint}
              </span>
            </label>
          );
        })}
      </fieldset>

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

      <div class="consent__group">
        <label class="consent__legend" for="consent-agent-name">
          Name this agent
        </label>
        <input
          id="consent-agent-name"
          class="input"
          name="agent_name"
          value={name.value}
          onInput={(e) => {
            name.value = e.currentTarget.value;
            nameEdited.value = true;
          }}
          maxLength={120}
          autoComplete="off"
          spellcheck={false}
          aria-describedby="consent-agent-name-hint"
          data-testid="consent-agent-name"
        />
        <p class="field__hint" id="consent-agent-name-hint">
          What people see wherever it acts: bylines, the agent band, the audit log.
        </p>
      </div>

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
          Ends {longDate(endsAt)}. Revoke it any time on the <a href="/agents">Agents</a> page.
        </p>
      </fieldset>

      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}

      <div class="consent-bar">
        <ConsentBarMeta expiresAt={view.expiresAt} now={now.value} />
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
          <button
            type="button"
            class="consent-bar__missing"
            id="consent-missing"
            onClick={goToMissing}
          >
            <Icon name="arrow-up-right" size={14} />
            {missing.text}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The bar's left side on every signing screen: who is approving (people are circles) with a way
 * to switch account, and the countdown, which turns to words and carmine in its last minute and
 * announces that once.
 */
export function ConsentBarMeta({ expiresAt, now }: { expiresAt: string; now: number }) {
  const s = session.value;
  const approver = s.status === "authed" ? (s.me.user?.name ?? s.me.principal.name) : null;
  const email = s.status === "authed" ? (s.me.user?.email ?? null) : null;
  const urgent = Date.parse(expiresAt) - now <= URGENT_MS;
  return (
    <div class="consent-bar__meta">
      {approver ? (
        <p class="consent-bar__who" data-testid="consent-approver">
          <Avatar kind="human" name={approver} size={20} />
          <span class="consent-bar__as">
            Approving as <b>{approver}</b>
            {email ? <span class="consent-bar__email"> {email}</span> : null}
          </span>
          <button
            type="button"
            class="consent-bar__switch"
            onClick={() =>
              void signOut(
                `/signin?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
              )
            }
          >
            Switch account
          </button>
        </p>
      ) : null}
      <p class={`consent-bar__time ${urgent ? "consent-bar__time--urgent" : ""}`}>
        <Icon name="timer" size={14} />
        {urgent ? (
          <span>
            {countdownWords(expiresAt, now)} to decide ·{" "}
            <span class="tnum">{countdown(expiresAt, now)}</span>
          </span>
        ) : (
          <span>
            Decide within <span class="tnum">{countdown(expiresAt, now)}</span>
          </span>
        )}
      </p>
      {/* Announced once, when a minute is left; the ticking digits stay quiet. */}
      <p class="sr-only" aria-live="polite">
        {urgent ? "1 minute left to decide." : ""}
      </p>
    </div>
  );
}
