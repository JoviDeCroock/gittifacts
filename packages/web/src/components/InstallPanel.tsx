/**
 * The decision on `/integrations/install`: who is asking, what it may do in plain words (the
 * server's titles and descriptions), what it can never do, and which repositories. A sibling of
 * the agent consent panel: same frame, same "can" and "never" blocks, same thumb-zone bar.
 */
import { useSignal } from "@preact/signals";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import type { InstallDecision, InstallView } from "../api/integrations.js";
import { repoLine } from "../lib/integrations.js";
import { countdown } from "../lib/time.js";
import { useTick } from "../state/clock.js";
import { Icon } from "./Icon.js";
import { IntegrationLogo, RepoPicker } from "./Integrations.js";
import { Button } from "./ui.js";
import "../styles/consent.css";
import "../styles/integrations.css";

interface InstallPanelProps {
  view: InstallView;
  onApprove: (d: InstallDecision, key: string) => Promise<void>;
  onDeny: (key: string) => Promise<void>;
}

export function InstallPanel({ view, onApprove, onDeny }: InstallPanelProps) {
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
  const remaining = countdown(view.expiresAt, now.value);
  const missing =
    selection.value === "selected" && picked.value.length === 0
      ? view.repos.length === 0
        ? "You have no repositories to pick."
        : "Pick at least one repository."
      : null;
  const existingRepos = existing
    ? repoLine(
        existing.repoSelection,
        existing.repoIds.map((id) => view.repos.find((r) => r.id === id) ?? { name: id }),
      )
    : "";

  async function approve(e: Event) {
    e.preventDefault();
    if (busy.value || missing) return;
    busy.value = "approve";
    error.value = null;
    try {
      await onApprove(
        { repoSelection: selection.value, repoIds: selection.value === "all" ? [] : picked.value },
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
    <form class="consent int-install" onSubmit={approve} aria-labelledby="install-title">
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
            {existingRepos.slice(1)}. What you choose below replaces that.
          </span>
        </p>
      ) : null}

      <section class="consent__ask">
        <h1 id="install-title" class="consent__title">
          {it.name} wants to:
        </h1>
        <ul class="consent__can int-install__can">
          {view.scopes.map((s) => (
            <li key={s.scope}>
              <Icon name="check" size={16} />
              <span>
                <span class="int-install__scope">{s.title}</span>
                <span class="int-install__scope-desc">{s.description}</span>
              </span>
            </li>
          ))}
        </ul>
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
        <p class="consent-bar__time">
          <Icon name="timer" size={14} /> Decide within <span class="tnum">{remaining}</span>
        </p>
        <div class="consent-bar__actions">
          <Button
            variant="secondary"
            busy={busy.value === "deny"}
            busyLabel="Cancelling…"
            disabled={busy.value === "approve"}
            onClick={deny}
          >
            Cancel
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
            {existing ? "Update installation" : "Install & authorize"}
          </Button>
        </div>
        {missing ? (
          <p class="consent-bar__missing" id="install-missing">
            {missing}
          </p>
        ) : null}
      </div>
    </form>
  );
}
