/**
 * /settings/integrations — integrations you installed (deploy platforms and other apps): what
 * each can do in plain words, on which repositories, and one-click uninstall.
 */
import { useSignal } from "@preact/signals";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import { type InstallationView, integrationsApi } from "../api/integrations.js";
import { Icon } from "../components/Icon.js";
import { ConfirmAction, IntegrationLogo, RepoPicker } from "../components/Integrations.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, LinkButton, Loading } from "../components/ui.js";
import { hostOf, repoLine } from "../lib/integrations.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/integrations.css";

function RepoEditor({
  inst,
  onSaved,
  onCancel,
}: {
  inst: InstallationView;
  onSaved: (i: InstallationView) => void;
  onCancel: () => void;
}) {
  const selection = useSignal(inst.repoSelection);
  const picked = useSignal(inst.repos.map((r) => r.id));
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const missing = selection.value === "selected" && picked.value.length === 0;

  async function save(e: Event) {
    e.preventDefault();
    if (busy.value || missing) return;
    busy.value = true;
    error.value = null;
    try {
      const { installation } = await integrationsApi.updateInstallation(
        inst.id,
        { repoSelection: selection.value, repoIds: selection.value === "all" ? [] : picked.value },
        key.value,
      );
      onSaved(installation);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <form
      class="inst__editor"
      onSubmit={save}
      aria-label={`Repositories for ${inst.integration.name}`}
    >
      <RepoPicker
        name={`repos-${inst.id}`}
        repos={inst.eligibleRepos}
        selection={selection.value}
        picked={picked.value}
        onSelection={(s) => (selection.value = s)}
        onToggle={(id, on) => {
          picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id);
        }}
      />
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <div class="inst__editor-actions">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy.value}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          busy={busy.value}
          busyLabel="Saving…"
          disabled={missing}
        >
          Save repositories
        </Button>
      </div>
      {missing ? <p class="field__hint">Pick at least one repository.</p> : null}
    </form>
  );
}

function InstallationRow({
  inst,
  onUninstalled,
  onUpdated,
}: {
  inst: InstallationView;
  onUninstalled: (i: InstallationView) => void;
  onUpdated: (i: InstallationView) => void;
}) {
  const editing = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const now = minuteClock.value;
  const it = inst.integration;
  const host = hostOf(it.homepageUrl, it.homepageUrl);

  return (
    <li class="inst">
      <IntegrationLogo name={it.name} logoUrl={it.logoUrl} size={40} />
      <div class="inst__main">
        <h3 class="inst__name">{it.name}</h3>
        <p class="inst__by">
          by {it.developer.name} ·{" "}
          <a href={it.homepageUrl} target="_blank" rel="noopener noreferrer">
            {host}
          </a>
        </p>
        <ul class="inst__can" aria-label={`What ${it.name} can do`}>
          {inst.scopes.map((s) => (
            <li key={s.scope}>
              <Icon name="check" size={14} />
              {s.title}
            </li>
          ))}
        </ul>
        <details class="disclosure inst__more">
          <summary>
            <Icon name="chevron-down" class="disclosure__chev" size={16} />
            What these allow
          </summary>
          <dl class="inst__explain">
            {inst.scopes.map((s) => (
              <div key={s.scope}>
                <dt>{s.title}</dt>
                <dd>{s.description}</dd>
              </div>
            ))}
          </dl>
        </details>
        <p class="inst__repos">
          <Icon name="layers" size={16} />
          <span>
            {inst.repoSelection === "all"
              ? "All repositories you own or maintain"
              : repoLine("selected", inst.repos)}
          </span>
          {!editing.value ? (
            <button type="button" class="inst__change" onClick={() => (editing.value = true)}>
              Change repositories
            </button>
          ) : null}
        </p>
        {editing.value ? (
          <RepoEditor
            inst={inst}
            onCancel={() => (editing.value = false)}
            onSaved={(i) => {
              editing.value = false;
              onUpdated(i);
            }}
          />
        ) : null}
        <p class="inst__when">
          Installed {relative(inst.createdAt, now)} by {inst.installedBy.name} ·{" "}
          {inst.lastUsedAt ? `last used ${relative(inst.lastUsedAt, now)}` : "not used yet"}
        </p>
        {error.value ? (
          <p class="field__error" role="alert">
            {error.value}
          </p>
        ) : null}
      </div>
      <div class="inst__actions">
        <ConfirmAction
          label="Uninstall"
          confirmLabel="Uninstall now"
          busyLabel="Uninstalling…"
          consequence={
            <>Uninstall {it.name}? Its tokens stop working now and it receives no more events.</>
          }
          onConfirm={async () => {
            error.value = null;
            try {
              const { installation } = await integrationsApi.uninstall(inst.id, key.value);
              onUninstalled(installation);
            } catch (err) {
              error.value = inlineError(err);
              throw err;
            }
          }}
        />
      </div>
    </li>
  );
}

export function InstalledIntegrations() {
  const res = useResource(() => integrationsApi.installations(), []);
  const notice = useSignal<string | null>(null);
  const st = res.state.value;

  function replace(updated: InstallationView, message: string) {
    if (st.status !== "ok") return;
    notice.value = message;
    res.set({
      installations:
        updated.status === "deleted"
          ? st.data.installations.filter((i) => i.id !== updated.id)
          : st.data.installations.map((i) => (i.id === updated.id ? updated : i)),
    });
  }

  return (
    <Page
      title="Integrations"
      actions={
        <LinkButton
          href="/settings/integrations/developer"
          variant="secondary"
          size="sm"
          icon="plug"
        >
          Developer portal
        </LinkButton>
      }
      meta={
        <span>
          Deploy platforms and other apps you installed on your repositories. They can read code and
          report what they deployed; they can never push, approve or merge.
        </span>
      }
    >
      {notice.value ? (
        <p class="int-notice" role="status">
          <Icon name="check-circle" size={16} /> {notice.value}
        </p>
      ) : null}
      {st.status === "loading" ? (
        <Loading label="Loading installed integrations" lines={6} />
      ) : null}
      {st.status === "error" ? (
        <ErrorState error={st.error} what="your integrations" onRetry={res.reload} />
      ) : null}
      {st.status === "ok" ? (
        st.data.installations.length === 0 ? (
          <EmptyState icon="plug" title="No integrations installed">
            <p>
              To deploy from gittifacts, start on the platform's side: pick gittifacts as the git
              provider there, and you'll be asked here which repositories it may see.
            </p>
            <p>
              Building one yourself? Register it in the{" "}
              <a href="/settings/integrations/developer">developer portal</a>.
            </p>
          </EmptyState>
        ) : (
          <>
            <h2 class="int-section__title">
              Installed <span class="tnum int-n">{st.data.installations.length}</span>
            </h2>
            <ul class="insts">
              {st.data.installations.map((i) => (
                <InstallationRow
                  key={i.id}
                  inst={i}
                  onUninstalled={(u) =>
                    replace(
                      u,
                      `${u.integration.name} is uninstalled. Its tokens stopped working and it receives no more events.`,
                    )
                  }
                  onUpdated={(u) =>
                    replace(
                      u,
                      `${u.integration.name} now sees ${u.repoSelection === "all" ? "all repositories you own or maintain" : repoLine("selected", u.repos)}.`,
                    )
                  }
                />
              ))}
            </ul>
          </>
        )
      ) : null}
      <p class="int-foot">
        <Icon name="shield-check" size={16} />
        <span>
          Integrations never see your agents' push tokens and can't connect to unclaimed repos.
          Every install, uninstall and deployment report is in the <a href="/audit">audit log</a>.
        </span>
      </p>
    </Page>
  );
}
