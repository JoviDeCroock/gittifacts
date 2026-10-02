/**
 * Pieces shared by the integration screens: the logo square (falls back to a monogram), the
 * shown-once secret panel, and the inline confirmation that names its consequence.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import type { IntegrationScope, WebhookEvent } from "../api/integrations.js";
import { ALL_EVENTS, EVENT_CATALOG, SCOPE_CATALOG, sortScopes } from "../lib/integrations.js";
import { Icon } from "./Icon.js";
import { Button, CopyButton } from "./ui.js";

function monogram(name: string): string {
  const words = name.replace(/[()]/g, "").trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Squares mean apps and agents; an integration is an app. Broken logos fall back to initials. */
export function IntegrationLogo({
  name,
  logoUrl,
  size = 40,
}: {
  name: string;
  logoUrl: string | null;
  size?: number;
}) {
  const broken = useSignal(false);
  const style = { width: `${size}px`, height: `${size}px` };
  if (logoUrl && !broken.value) {
    return (
      <img
        class="int-logo int-logo--img"
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        style={style}
        loading="lazy"
        referrerpolicy="no-referrer"
        onError={() => (broken.value = true)}
      />
    );
  }
  return (
    <span class="int-logo" style={{ ...style, fontSize: `${Math.round(size * 0.38)}px` }} aria-hidden="true">
      {monogram(name)}
    </span>
  );
}

export interface SecretItem {
  label: string;
  value: string;
  /** Mono value that is not secret (client id) can be shown again; secrets can't. */
  secret: boolean;
  hint?: string;
}

/** Credentials the server returns once. Copy now, or rotate later. */
export function SecretReveal({
  title,
  items,
  children,
  onDone,
  doneLabel = "I stored it",
}: {
  title: string;
  items: SecretItem[];
  children?: ComponentChildren;
  onDone: () => void;
  doneLabel?: string;
}) {
  const anySecret = items.some((i) => i.secret);
  return (
    <section class="secret-reveal" aria-labelledby="secret-reveal-title" role="status">
      <h2 id="secret-reveal-title" class="secret-reveal__title">
        <Icon name="key" size={18} /> {title}
      </h2>
      {anySecret ? (
        <p class="secret-reveal__warn">
          <b>Copy the secret now. You won't see it again.</b> We store only a hash. If you lose it,
          generate a new one and revoke this one.
        </p>
      ) : null}
      <dl class="secret-reveal__items">
        {items.map((it) => (
          <div key={it.label} class="secret-reveal__item">
            <dt>{it.label}</dt>
            <dd>
              <div class="secret-box">
                <code class="secret-box__value">{it.value}</code>
                <CopyButton text={it.value} label="Copy" />
              </div>
              {it.hint ? <p class="field__hint">{it.hint}</p> : null}
            </dd>
          </div>
        ))}
      </dl>
      {children}
      <Button variant="primary" onClick={onDone}>
        {doneLabel}
      </Button>
    </section>
  );
}

/** A destructive action behind an inline confirmation that says what happens. */
export function ConfirmAction({
  label,
  confirmLabel,
  busyLabel,
  consequence,
  onConfirm,
  size = "sm",
  icon,
}: {
  label: string;
  confirmLabel: string;
  busyLabel: string;
  consequence: ComponentChildren;
  /** Throw to keep the confirmation open (after showing the error). */
  onConfirm: () => Promise<void>;
  size?: "sm" | "md";
  icon?: "trash" | "plug" | "x";
}) {
  const open = useSignal(false);
  const busy = useSignal(false);
  if (!open.value) {
    return (
      <Button variant="danger-outline" size={size} icon={icon} onClick={() => (open.value = true)}>
        {label}
      </Button>
    );
  }
  return (
    <fieldset class="confirm" aria-label={confirmLabel}>
      <p class="confirm__text">{consequence}</p>
      <div class="confirm__actions">
        <Button variant="secondary" size={size} disabled={busy.value} onClick={() => (open.value = false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          size={size}
          busy={busy.value}
          busyLabel={busyLabel}
          onClick={async () => {
            busy.value = true;
            try {
              await onConfirm();
              open.value = false;
            } catch {
              // The caller shows what failed; the confirmation stays open for a retry.
            } finally {
              busy.value = false;
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </fieldset>
  );
}

export interface PickerRepo {
  id: string;
  name: string;
  fullName: string;
}

/**
 * "All repositories you own" or "Only selected repositories" with a checklist. Used on the
 * install screen and when changing an installation's repositories.
 */
export function RepoPicker({
  repos,
  selection,
  picked,
  onSelection,
  onToggle,
  name = "repo-selection",
}: {
  repos: PickerRepo[];
  selection: "all" | "selected";
  picked: string[];
  onSelection: (s: "all" | "selected") => void;
  onToggle: (id: string, on: boolean) => void;
  name?: string;
}) {
  return (
    <div class="repo-picker">
      <label class="check repo-picker__mode">
        <input
          type="radio"
          name={name}
          checked={selection === "all"}
          onChange={() => onSelection("all")}
        />
        <span>All repositories you own</span>
        <span class="check__hint">
          {repos.length === 0
            ? "None yet. Repositories you claim later are included."
            : `${repos.length === 1 ? "1 repository" : `${repos.length} repositories`} today, and any you claim later.`}
        </span>
      </label>
      <label class="check repo-picker__mode">
        <input
          type="radio"
          name={name}
          checked={selection === "selected"}
          onChange={() => onSelection("selected")}
        />
        <span>Only selected repositories</span>
        <span class="check__hint">Recommended. It sees nothing else.</span>
      </label>
      {repos.length === 0 ? (
        <p class="repo-picker__none" role="note">
          <Icon name="info" size={16} />
          <span>
            You don't own any claimed repositories yet. Only claimed repositories you own can be
            connected to an integration; unclaimed projects can't.
          </span>
        </p>
      ) : selection === "selected" ? (
        <ul class="repo-picker__list" aria-label="Repositories">
          {repos.map((r) => (
            <li key={r.id}>
              <label class="check">
                <input
                  type="checkbox"
                  checked={picked.includes(r.id)}
                  onChange={(e) => onToggle(r.id, e.currentTarget.checked)}
                />
                <span class="repo-picker__name">{r.fullName}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Permissions with the server's plain words; the raw scope id is secondary. */
export function ScopeChecklist({
  value,
  onChange,
  legend = "Permissions",
}: {
  value: IntegrationScope[];
  onChange: (next: IntegrationScope[]) => void;
  legend?: string;
}) {
  return (
    <fieldset class="int-checks">
      <legend class="field__label">{legend}</legend>
      {SCOPE_CATALOG.map((s) => (
        <label key={s.scope} class="check">
          <input
            type="checkbox"
            checked={value.includes(s.scope)}
            onChange={(e) =>
              onChange(
                sortScopes(
                  e.currentTarget.checked ? [...value, s.scope] : value.filter((x) => x !== s.scope),
                ),
              )
            }
          />
          <span>
            {s.title} <code class="int-checks__id">{s.scope}</code>
          </span>
          <span class="check__hint">{s.description}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function EventChecklist({
  value,
  onChange,
  disabled,
}: {
  value: WebhookEvent[];
  onChange: (next: WebhookEvent[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset class="int-checks int-checks--events" disabled={disabled}>
      <legend class="field__label">Events</legend>
      {EVENT_CATALOG.map((e) => (
        <label key={e.event} class="check">
          <input
            type="checkbox"
            checked={value.includes(e.event)}
            onChange={(ev) =>
              onChange(
                ALL_EVENTS.filter((x) =>
                  x === e.event ? ev.currentTarget.checked : value.includes(x),
                ),
              )
            }
          />
          <code class="int-checks__event">{e.event}</code>
          <span class="check__hint">{e.hint}</span>
        </label>
      ))}
      <p class="field__hint">ping is always sent when you ask for one.</p>
    </fieldset>
  );
}
