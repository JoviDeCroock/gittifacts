/**
 * The decision on `/integrations/install`: who is asking, what it may do in plain words (the
 * server's titles and descriptions), what it can never do, and which repositories. A sibling of
 * the agent consent panel: same frame, same "can" and "never" blocks, same thumb-zone bar.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import type { InstallDecision, InstallView, ScopeExplained } from "../api/integrations.js";
import { repoLine } from "../lib/integrations.js";
import { useTick } from "../state/clock.js";
import { ConsentBarMeta } from "./ConsentPanel.js";
import { Icon } from "./Icon.js";
import { IntegrationLogo, RepoPicker } from "./Integrations.js";
import { Button } from "./ui.js";
import "../styles/consent.css";
import "../styles/integrations.css";

/** What a person granted, for the receipt on the outcome screen. */
export interface InstallGranted {
  scopes: ScopeExplained[];
  /** Full repo names, or "all". */
  repos: string[] | "all";
}

interface InstallPanelProps {
  view: InstallView;
  onApprove: (d: InstallDecision, key: string, granted: InstallGranted) => Promise<void>;
  onDeny: (key: string) => Promise<void>;
  /** Shown in place of the form once the countdown runs out. */
  expired: ComponentChildren;
}

export function InstallPanel({ view, onApprove, onDeny, expired }: InstallPanelProps) {
  const it = view.integration;
  const existing = view.existing;
  const selection = useSignal<"all" | "selected">(existing?.repoSelection ?? "selected");
  const picked = useSignal<string[]>(
    existing?.repoIds ?? (view.repos.length === 1 && view.repos[0] ? [view.repos[0].id] : []),
  );
  const busy = useSignal<"approve" | "deny" | null>(null);
  const error = useSignal<string | null>(null);
  // One key per intent, reused on retry (idempotency).
  const keys = useSignal({ approve: newIdempotencyKey(), deny: newIdempotencyKey() });
  const now = useTick(1000);
  const form = useRef<HTMLFormElement>(null);
  // An update shows what it adds to (and drops from) what the installation granted.
  const before = existing?.scopes ?? null;
  const removed = before ? before.filter((x) => !view.scopes.some((s) => s.scope === x)) : [];
  const missing =
    selection.value === "selected" && picked.value.length === 0
      ? view.repos.length === 0
        ? "You have no repositories to pick."
        : "Pick at least one repository."
      : null;
  const existingRepos = existing
    ? repoLine(
        existing.repoSelection,
        existing.repoIds.map((id) => ({ name: view.repos.find((r) => r.id === id)?.fullName ?? id })),
      )
    : "";

  if (Date.parse(view.expiresAt) <= now.value && busy.value !== "approve") return <>{expired}</>;

  function goToMissing() {
    const el = form.current?.querySelector<HTMLInputElement>(".repo-picker__list input");
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
    try {
      await onApprove(
        { repoSelection: selection.value, repoIds: selection.value === "all" ? [] : picked.value },
        keys.value.approve,
        {
          scopes: view.scopes,
          repos:
            selection.value === "all"
              ? "all"
              : picked.value.map((id) => view.repos.find((r) => r.id === id)?.fullName ?? id),
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
    <form class="consent int-install" ref={form} onSubmit={approve} aria-labelledby="install-title">
      <section class="consent__who">
        <IntegrationLogo name={it.name} logoUrl={it.logoUrl} size={44} />
        <div class="consent__who-text">
          <p class="consent__client">{it.name}</p>
          <p class="consent__vouch">
            by <b>{it.developer.name}</b> ·{" "}
            <a href={it.homepageUrl} target="_blank" rel="noopener noreferrer">
              {it.homepageHost}
            </a>
          </p>
          <p class="consent__return">You'll be sent back to {view.redirectHost}</p>
        </div>
      </section>
      {it.description ? <p class="int-install__desc">{it.description}</p> : null}

      {existing ? (
        <p class="int-install__existing" role="note">
          <Icon name="info" size={16} />
          <span>
            Already installed on your account, on {existingRepos.charAt(0).toLowerCase()}
            {existingRepos.slice(1)}. What you approve below replaces that
            {before ? "; new permissions are marked." : "."}
          </span>
        </p>
      ) : null}

      <section class="consent__ask">
        <h1 id="install-title" class="consent__title">
          {it.name} wants to:
        </h1>
        <ul class="consent__can int-install__can">
          {view.scopes.map((s) => {
            const fresh = before !== null && !before.includes(s.scope);
            return (
              <li key={s.scope} data-new={fresh ? "" : undefined}>
                <Icon name={fresh ? "plus" : "check"} size={16} />
                <span>
                  <span class="int-install__scope">
                    {s.title}
                    {before ? (
                      <span class={`int-install__delta ${fresh ? "int-install__delta--new" : ""}`}>
                        <span class="sr-only"> (</span>
                        {fresh ? "new" : "already granted"}
                        <span class="sr-only">)</span>
                      </span>
                    ) : null}
                  </span>
                  <span class="int-install__scope-desc">{s.description}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {removed.length > 0 ? (
          <p class="int-install__removed">
            No longer asks for: {removed.join(", ")}. Updating removes {removed.length === 1 ? "it" : "them"}.
          </p>
        ) : null}
      </section>

      <section class="consent__never" aria-labelledby="never-title">
        <h2 id="never-title" class="consent__never-title">
          <Icon name="shield-check" size={16} /> It can never
        </h2>
        <ul>
          {view.never.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p class="consent__never-why">
          Integrations read code and report what they deployed. People approve intent.
        </p>
      </section>

      <fieldset class="consent__group">
        <legend class="consent__legend">Repositories</legend>
        <RepoPicker
          repos={view.repos}
          selection={selection.value}
          picked={picked.value}
          onSelection={(s) => (selection.value = s)}
          onToggle={(id, on) => {
            picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id);
          }}
        />
        <p class="field__hint">
          Uninstall it or change its repositories any time on the{" "}
          <a href="/settings/integrations">Integrations</a> page.
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
            busyLabel={existing ? "Updating…" : "Installing…"}
            disabled={busy.value === "deny" || missing !== null}
            aria-describedby={missing ? "install-missing" : undefined}
          >
            {existing ? `Update ${it.name}` : `Install ${it.name}`}
          </Button>
        </div>
        {missing ? (
          <button type="button" class="consent-bar__missing" id="install-missing" onClick={goToMissing}>
            <Icon name="arrow-up-right" size={14} />
            {missing}
          </button>
        ) : null}
      </div>
    </form>
  );
}
