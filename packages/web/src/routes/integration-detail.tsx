/**
 * /settings/integrations/developer/:integrationId — one integration's settings: credentials
 * (client id, secrets with rotation), webhook (URL, events, secret, ping), sign-in redirect URIs,
 * permissions, details, recent deliveries and delete.
 */
import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation, useRoute } from "preact-iso";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import {
  type IntegrationScope,
  type IntegrationView,
  integrationsApi,
  type SecretView,
} from "../api/integrations.js";
import { DeliveryRow } from "../components/Deliveries.js";
import { Icon } from "../components/Icon.js";
import {
  ConfirmAction,
  EventChecklist,
  IntegrationLogo,
  ScopeChecklist,
  SecretReveal,
  type SecretItem,
} from "../components/Integrations.js";
import { Page } from "../components/Shell.js";
import { Button, CopyButton, ErrorState, LinkButton, Loading } from "../components/ui.js";
import { hostOf, lines, redirectUrisProblem, sortScopes, urlProblem } from "../lib/integrations.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/integrations.css";

type Reveal = { title: string; items: SecretItem[] } | null;

function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="int-sec" aria-labelledby={`${id}-title`}>
      <div class="int-sec__head">
        <h2 id={`${id}-title`} class="int-sec__title">
          {title}
        </h2>
        {aside ? <div class="int-sec__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Inline result line under an action: what happened, or what failed and what to do. */
function Result({ r }: { r: Signal<{ ok: boolean; text: ComponentChildren } | null> }) {
  if (!r.value) return null;
  return (
    <p class={r.value.ok ? "int-result" : "field__error"} role={r.value.ok ? "status" : "alert"}>
      {r.value.ok ? <Icon name="check-circle" size={16} /> : null}
      <span>{r.value.text}</span>
    </p>
  );
}

function SecretRow({
  s,
  newest,
  canRevoke,
  onRevoke,
}: {
  s: SecretView;
  newest: boolean;
  canRevoke: boolean;
  onRevoke: () => Promise<void>;
}) {
  const now = minuteClock.value;
  return (
    <li class="secret-row">
      <div class="secret-row__main">
        <p>
          <code class="secret-row__prefix">{s.prefix}…</code>
          {newest ? <span class="int-tag">Newest</span> : null}
        </p>
        <p class="secret-row__when">
          Created {relative(s.createdAt, now)} ·{" "}
          {s.lastUsedAt ? `last used ${relative(s.lastUsedAt, now)}` : "never used"}
        </p>
      </div>
      {canRevoke ? (
        <ConfirmAction
          label="Revoke"
          confirmLabel="Revoke secret"
          busyLabel="Revoking…"
          consequence={<>Revoke {s.prefix}…? Anything still using it can't get tokens any more.</>}
          onConfirm={onRevoke}
        />
      ) : null}
    </li>
  );
}

function Credentials({ it, onChange }: { it: IntegrationView; onChange: (i: IntegrationView) => void }) {
  const reveal = useSignal<Reveal>(null);
  const busy = useSignal(false);
  const result = useSignal<{ ok: boolean; text: ComponentChildren } | null>(null);
  const key = useSignal(newIdempotencyKey());
  const confidential = it.clientType === "confidential";

  async function generate() {
    if (busy.value) return;
    busy.value = true;
    result.value = null;
    try {
      const r = await integrationsApi.createSecret(it.id, key.value);
      key.value = newIdempotencyKey();
      reveal.value = { title: "New client secret", items: [{ label: "Client secret", value: r.clientSecret, secret: true }] };
      onChange(r.integration);
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
    } finally {
      busy.value = false;
    }
  }

  async function revoke(s: SecretView) {
    result.value = null;
    try {
      const r = await integrationsApi.revokeSecret(it.id, s.id, newIdempotencyKey());
      result.value = { ok: true, text: `${s.prefix}… is revoked.` };
      onChange(r.integration);
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
      throw err;
    }
  }

  const secrets = [...it.secrets].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <Section id="credentials" title="Credentials">
      {reveal.value ? (
        <SecretReveal title={reveal.value.title} items={reveal.value.items} onDone={() => (reveal.value = null)} />
      ) : null}
      <dl class="kv int-kv">
        <dt>Client ID</dt>
        <dd class="int-kv__copy">
          <code>{it.clientId}</code>
          <CopyButton text={it.clientId} label="Copy" />
        </dd>
        <dt>Client type</dt>
        <dd>
          {confidential
            ? "Confidential: your server authenticates with a client secret."
            : "Public: no secret; it proves itself with PKCE."}
        </dd>
      </dl>
      {confidential ? (
        <>
          <h3 class="int-sub">Client secrets</h3>
          {secrets.length === 0 ? (
            <p class="ev-sub">No secret yet. Generate one to finish setting up the integration.</p>
          ) : (
            <ul class="secret-rows">
              {secrets.map((s, i) => (
                <SecretRow
                  key={s.id}
                  s={s}
                  newest={i === 0 && secrets.length > 1}
                  canRevoke={i > 0}
                  onRevoke={() => revoke(s)}
                />
              ))}
            </ul>
          )}
          <Result r={result} />
          <div class="int-actions">
            <Button icon="key" busy={busy.value} busyLabel="Generating…" onClick={generate}>
              Generate a new secret
            </Button>
          </div>
          <p class="field__hint">
            To rotate without downtime: generate a new secret, deploy it, then revoke the old one.
          </p>
        </>
      ) : (
        <Result r={result} />
      )}
    </Section>
  );
}

function Webhook({ it, onChange, base }: { it: IntegrationView; onChange: (i: IntegrationView) => void; base: string }) {
  const url = useSignal(it.webhook.url ?? "");
  const active = useSignal(it.webhook.active);
  const events = useSignal(it.webhook.events);
  const saving = useSignal(false);
  const pinging = useSignal(false);
  const reveal = useSignal<Reveal>(null);
  const result = useSignal<{ ok: boolean; text: ComponentChildren } | null>(null);
  const hooks = it.scopes.includes("webhooks");
  const dirty =
    url.value.trim() !== (it.webhook.url ?? "") ||
    active.value !== it.webhook.active ||
    events.value.join() !== it.webhook.events.join();

  async function save(e: Event) {
    e.preventDefault();
    if (saving.value || !dirty) return;
    const u = url.value.trim();
    const problem = u ? urlProblem(u, "The webhook URL") : null;
    if (problem) {
      result.value = { ok: false, text: problem };
      return;
    }
    saving.value = true;
    result.value = null;
    try {
      const r = await integrationsApi.update(
        it.id,
        { webhook: { url: u || null, events: events.value, active: active.value } },
        newIdempotencyKey(),
      );
      result.value = { ok: true, text: "Webhook saved." };
      onChange(r.integration);
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
    } finally {
      saving.value = false;
    }
  }

  async function rotate() {
    result.value = null;
    try {
      const r = await integrationsApi.rotateWebhookSecret(it.id, newIdempotencyKey());
      reveal.value = {
        title: "New webhook secret",
        items: [{ label: "Webhook secret", value: r.webhookSecret, secret: true, hint: "Deliveries are signed with it from now on." }],
      };
      onChange(r.integration);
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
      throw err;
    }
  }

  async function ping() {
    if (pinging.value) return;
    pinging.value = true;
    result.value = null;
    try {
      const { delivery } = await integrationsApi.ping(it.id, newIdempotencyKey());
      result.value = {
        ok: true,
        text: (
          <>
            Ping queued. <a href={`${base}/${encodeURIComponent(delivery.id)}`}>See the delivery</a>
          </>
        ),
      };
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
    } finally {
      pinging.value = false;
    }
  }

  return (
    <Section
      id="webhook"
      title="Webhook"
      aside={
        <span class={`int-state ${it.webhook.url && it.webhook.active ? "int-state--on" : ""}`}>
          {!it.webhook.url ? "Not set up" : it.webhook.active ? "Active" : "Paused"}
        </span>
      }
    >
      {reveal.value ? (
        <SecretReveal title={reveal.value.title} items={reveal.value.items} onDone={() => (reveal.value = null)} />
      ) : null}
      {!hooks ? (
        <p class="ev-sub">Add the Receive events permission below to send webhooks.</p>
      ) : (
        <form class="int-sec__form" onSubmit={save}>
          <label class="field">
            <span class="field__label">Payload URL</span>
            <input
              class="input"
              type="url"
              inputMode="url"
              autoCapitalize="off"
              spellcheck={false}
              value={url.value}
              onInput={(e) => (url.value = e.currentTarget.value)}
              placeholder="https://deploy.example/hooks/gittifacts"
            />
          </label>
          <label class="check">
            <input type="checkbox" checked={active.value} onChange={(e) => (active.value = e.currentTarget.checked)} />
            <span>Active</span>
            <span class="check__hint">Untick to pause. While paused, deliveries are cancelled, not queued.</span>
          </label>
          <EventChecklist value={events.value} onChange={(v) => (events.value = v)} />
          <SaveBar dirty={dirty} busy={saving.value} label="Save webhook" onDiscard={() => { url.value = it.webhook.url ?? ""; active.value = it.webhook.active; events.value = it.webhook.events; }} />
        </form>
      )}
      {hooks ? (
        <div class="int-webhook-secret">
          <p>
            <b>Secret</b>{" "}
            {it.webhook.secretSet ? "is set. Every delivery carries X-Gittifacts-Signature-256." : "is not set; deliveries are unsigned."}
          </p>
          <div class="int-actions">
            <Button icon="send" size="sm" busy={pinging.value} busyLabel="Sending…" disabled={!it.webhook.url} onClick={ping}>
              Send ping
            </Button>
            <ConfirmAction
              label="Generate new webhook secret"
              confirmLabel="Generate new secret"
              busyLabel="Generating…"
              consequence={<>The old secret stops working now. Update your receiver right after, or its signature checks fail.</>}
              onConfirm={rotate}
            />
          </div>
        </div>
      ) : null}
      <Result r={result} />
    </Section>
  );
}

/** Save and Discard appear once something changed, so the page carries one primary at a time. */
/** Sections with unsaved edits (by their save label), so leaving the page can say so. */
const unsaved = new Set<string>();

/**
 * Four independent forms on one page: leaving with edits in any of them asks first, both for a
 * full unload and for an in-app link (a breadcrumb, the sidebar).
 */
function useLeaveGuard() {
  useEffect(() => {
    const message = () =>
      `You have unsaved changes (${[...unsaved].map((l) => l.replace(/^Save /, "")).join(", ")}). Leave without saving?`;
    const onUnload = (e: BeforeUnloadEvent) => {
      if (unsaved.size > 0) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (unsaved.size === 0 || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.origin !== window.location.origin) return;
      if (a.pathname === window.location.pathname) return;
      if (!window.confirm(message())) {
        e.preventDefault();
        e.stopPropagation();
      } else unsaved.clear();
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
      unsaved.clear();
    };
  }, []);
}

function SaveBar({ dirty, busy, label, onDiscard }: { dirty: boolean; busy: boolean; label: string; onDiscard: () => void }) {
  useEffect(() => {
    if (dirty) unsaved.add(label);
    else unsaved.delete(label);
    return () => {
      unsaved.delete(label);
    };
  }, [dirty, label]);
  if (!dirty && !busy) return null;
  return (
    <div class="int-actions">
      <Button type="submit" variant="primary" size="sm" busy={busy} busyLabel="Saving…">
        {label}
      </Button>
      <Button size="sm" variant="quiet" disabled={busy} onClick={onDiscard}>
        Discard changes
      </Button>
    </div>
  );
}

/** One small form per concern, each with its own Save (PATCH sends only that part). */
function useSave(it: IntegrationView, onChange: (i: IntegrationView) => void) {
  const busy = useSignal(false);
  const result = useSignal<{ ok: boolean; text: ComponentChildren } | null>(null);
  async function save(patch: Parameters<typeof integrationsApi.update>[1], done: string) {
    if (busy.value) return;
    busy.value = true;
    result.value = null;
    try {
      const r = await integrationsApi.update(it.id, patch, newIdempotencyKey());
      result.value = { ok: true, text: done };
      onChange(r.integration);
    } catch (err) {
      result.value = { ok: false, text: inlineError(err) };
    } finally {
      busy.value = false;
    }
  }
  return { busy, result, save };
}

function SignIn({ it, onChange }: { it: IntegrationView; onChange: (i: IntegrationView) => void }) {
  const text = useSignal(it.redirectUris.join("\n"));
  const s = useSave(it, onChange);
  const uris = lines(text.value);
  const dirty = uris.join("\n") !== it.redirectUris.join("\n");
  return (
    <Section id="signin" title="Redirect URIs">
      <form
        class="int-sec__form"
        onSubmit={(e) => {
          e.preventDefault();
          const problem = redirectUrisProblem(uris);
          if (problem) s.result.value = { ok: false, text: problem };
          else void s.save({ redirectUris: uris }, "Redirect URIs saved.");
        }}
      >
        <label class="field">
          <span class="sr-only">Redirect URIs, one per line</span>
          <textarea class="textarea mono" rows={Math.max(2, uris.length + 1)} autoCapitalize="off" spellcheck={false} value={text.value} onInput={(e) => (text.value = e.currentTarget.value)} aria-describedby="redir-hint" />
          <span class="field__hint" id="redir-hint">
            One per line, matched exactly (path and trailing slash included). http:// only for localhost.
          </span>
        </label>
        <Result r={s.result} />
        <SaveBar dirty={dirty} busy={s.busy.value} label="Save redirect URIs" onDiscard={() => (text.value = it.redirectUris.join("\n"))} />
      </form>
    </Section>
  );
}

function Permissions({ it, onChange }: { it: IntegrationView; onChange: (i: IntegrationView) => void }) {
  const scopes = useSignal<IntegrationScope[]>(it.scopes);
  const s = useSave(it, onChange);
  const dirty = sortScopes(scopes.value).join() !== sortScopes(it.scopes).join();
  const widened = scopes.value.some((x) => !it.scopes.includes(x));
  return (
    <Section id="permissions" title="Permissions">
      <form
        class="int-sec__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (scopes.value.length === 0) s.result.value = { ok: false, text: "Pick at least one permission." };
          else void s.save({ scopes: scopes.value }, "Permissions saved.");
        }}
      >
        <ScopeChecklist
          value={scopes.value}
          onChange={(v) => (scopes.value = v)}
          explained={it.scopesExplained}
          legend="What it asks for when people install it"
        />
        <p class="field__hint">
          People see these in plain words on the install screen. It can never push, approve or merge,
          whatever it asks for.
        </p>
        <p class="int-sec__note" data-testid="permissions-existing">
          <Icon name="info" size={16} />
          <span>
            Existing installations keep what they granted. People see the new permissions and approve
            them when they next install or update it.
            {widened && it.installationCount > 0
              ? ` ${it.installationCount === 1 ? "1 installation keeps" : `${it.installationCount} installations keep`} the old permissions until ${it.installationCount === 1 ? "its owner approves" : "their owners approve"}.`
              : ""}
          </span>
        </p>
        <Result r={s.result} />
        <SaveBar dirty={dirty} busy={s.busy.value} label="Save permissions" onDiscard={() => (scopes.value = it.scopes)} />
      </form>
    </Section>
  );
}

function About({ it, onChange }: { it: IntegrationView; onChange: (i: IntegrationView) => void }) {
  const name = useSignal(it.name);
  const description = useSignal(it.description ?? "");
  const homepage = useSignal(it.homepageUrl);
  const logo = useSignal(it.logoUrl ?? "");
  const s = useSave(it, onChange);
  const dirty =
    name.value.trim() !== it.name ||
    description.value.trim() !== (it.description ?? "") ||
    homepage.value.trim() !== it.homepageUrl ||
    logo.value.trim() !== (it.logoUrl ?? "");
  const bind = (sig: { value: string }) => ({
    value: sig.value,
    onInput: (e: Event) => (sig.value = (e.currentTarget as HTMLInputElement).value),
  });
  return (
    <Section id="about" title="Details people see">
      <form
        class="int-sec__form"
        onSubmit={(e) => {
          e.preventDefault();
          const problem =
            (name.value.trim().length < 2 ? "Use a name of 2 to 60 characters." : null) ??
            urlProblem(homepage.value.trim(), "The homepage") ??
            (logo.value.trim() ? urlProblem(logo.value.trim(), "The logo URL") : null);
          if (problem) {
            s.result.value = { ok: false, text: problem };
            return;
          }
          void s.save(
            {
              name: name.value.trim(),
              description: description.value.trim() || null,
              homepageUrl: homepage.value.trim(),
              logoUrl: logo.value.trim() || null,
            },
            "Details saved.",
          );
        }}
      >
        <label class="field">
          <span class="field__label">Name</span>
          <input class="input" {...bind(name)} />
        </label>
        <label class="field">
          <span class="field__label">
            Description <span class="int-form__opt">optional</span>
          </span>
          <textarea class="textarea" rows={2} {...bind(description)} />
        </label>
        <label class="field">
          <span class="field__label">Homepage URL</span>
          <input class="input" type="url" inputMode="url" autoCapitalize="off" spellcheck={false} {...bind(homepage)} />
        </label>
        <label class="field">
          <span class="field__label">
            Logo URL <span class="int-form__opt">optional</span>
          </span>
          <input class="input" type="url" inputMode="url" autoCapitalize="off" spellcheck={false} {...bind(logo)} />
        </label>
        <Result r={s.result} />
        <SaveBar dirty={dirty} busy={s.busy.value} label="Save details" onDiscard={() => { name.value = it.name; description.value = it.description ?? ""; homepage.value = it.homepageUrl; logo.value = it.logoUrl ?? ""; }} />
      </form>
    </Section>
  );
}

function RecentDeliveries({ it, base }: { it: IntegrationView; base: string }) {
  const res = useResource(() => integrationsApi.deliveries(it.id, { limit: 5 }), [it.id]);
  const st = res.state.value;
  return (
    <Section id="recent" title="Recent deliveries">
      {st.status === "loading" ? <Loading label="Loading recent deliveries" lines={3} /> : null}
      {st.status === "error" ? <ErrorState error={st.error} what="recent deliveries" onRetry={res.reload} /> : null}
      {st.status === "ok" && st.data.deliveries.length === 0 ? (
        <p class="ev-sub">Nothing sent yet. Send a ping to test your endpoint.</p>
      ) : null}
      {st.status === "ok" && st.data.deliveries.length > 0 ? (
        <ul class="dlvs">
          {st.data.deliveries.map((d) => (
            <DeliveryRow key={d.id} d={d} href={`${base}/${encodeURIComponent(d.id)}`} />
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function DangerZone({ it }: { it: IntegrationView }) {
  const { route } = useLocation();
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const installs = it.installationCount;
  return (
    <Section id="danger" title="Delete integration">
      <p class="ev-sub">
        {installs === 0
          ? "Nobody has installed it. Deleting it frees nothing else."
          : `Installed on ${installs === 1 ? "1 account" : `${installs} accounts`}.`}
      </p>
      <ConfirmAction
        label="Delete integration"
        confirmLabel="Delete integration"
        busyLabel="Deleting…"
        icon="trash"
        consequence={
          <>
            Delete {it.name}?{" "}
            {installs > 0
              ? `It is uninstalled from ${installs === 1 ? "1 account" : `${installs} accounts`} now, their tokens stop working and no more webhooks are sent.`
              : "Its client ID and secrets stop working now."}{" "}
            This can't be undone.
          </>
        }
        onConfirm={async () => {
          error.value = null;
          try {
            await integrationsApi.remove(it.id, key.value);
            route(`/settings/integrations/developer?deleted=${encodeURIComponent(it.name)}`);
          } catch (err) {
            error.value = inlineError(err);
            throw err;
          }
        }}
      />
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </Section>
  );
}

export function IntegrationDetail() {
  const { params } = useRoute();
  const id = params.integrationId ?? "";
  const res = useResource(() => integrationsApi.get(id), [id]);
  const st = res.state.value;
  const it = st.status === "ok" ? st.data.integration : null;
  const now = minuteClock.value;
  useLeaveGuard();
  const base = `/settings/integrations/developer/${encodeURIComponent(id)}/deliveries`;
  const crumbs = [
    { href: "/settings/integrations", label: "Integrations" },
    { href: "/settings/integrations/developer", label: "Developer portal" },
  ];
  const onChange = (i: IntegrationView) => res.set({ integration: i });

  return (
    <Page
      title={it?.name ?? "Integration"}
      wide
      crumbs={crumbs}
      actions={it ? <LinkButton href={base} size="sm" icon="webhook">Delivery log</LinkButton> : null}
      meta={
        it ? (
          <span class="int-head-meta">
            <IntegrationLogo name={it.name} logoUrl={it.logoUrl} size={24} />
            by {it.developer.name} ·{" "}
            <a href={it.homepageUrl} target="_blank" rel="noopener noreferrer">
              {hostOf(it.homepageUrl, it.homepageUrl)}
            </a>
            {" · "}
            {it.installationCount === 0
              ? "Not installed yet"
              : `Installed on ${it.installationCount === 1 ? "1 account" : `${it.installationCount} accounts`}`}
            {` · Updated ${relative(it.updatedAt, now)}`}
          </span>
        ) : null
      }
    >
      {st.status === "loading" ? <Loading label="Loading the integration" lines={10} /> : null}
      {st.status === "error" ? <ErrorState error={st.error} what="this integration" onRetry={res.reload} /> : null}
      {it ? (
        <div class="int-detail">
          <div class="int-detail__main">
            <Credentials key={`c-${it.id}`} it={it} onChange={onChange} />
            <Webhook key={`w-${it.id}`} it={it} onChange={onChange} base={base} />
            <SignIn key={`s-${it.id}`} it={it} onChange={onChange} />
            <Permissions key={`p-${it.id}`} it={it} onChange={onChange} />
          </div>
          <div class="int-detail__side">
            <RecentDeliveries it={it} base={base} />
            <About key={`a-${it.id}`} it={it} onChange={onChange} />
            <DangerZone it={it} />
          </div>
        </div>
      ) : null}
    </Page>
  );
}
