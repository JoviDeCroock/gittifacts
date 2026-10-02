/**
 * /settings/integrations/developer — the developer portal: integrations you registered, and the
 * form to register one. The client secret (and a generated webhook secret) is shown once.
 */
import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import {
  type ClientType,
  type CreatedIntegration,
  type IntegrationScope,
  type IntegrationView,
  integrationsApi,
  type WebhookEvent,
} from "../api/integrations.js";
import { Icon } from "../components/Icon.js";
import {
  EventChecklist,
  IntegrationLogo,
  ScopeChecklist,
  SecretReveal,
  type SecretItem,
} from "../components/Integrations.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, Loading } from "../components/ui.js";
import { DEPLOY_SCOPES, hostOf, lines, redirectUrisProblem, urlProblem } from "../lib/integrations.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import "../styles/integrations.css";

type Field = "name" | "homepageUrl" | "logoUrl" | "redirectUris" | "scopes" | "webhookUrl";
type Problems = Partial<Record<Field, string>>;

function FieldError({ id, msg }: { id: string; msg: string | undefined }) {
  return msg ? (
    <span class="field__error" id={id}>
      {msg}
    </span>
  ) : null;
}

const DEFAULT_EVENTS: WebhookEvent[] = [
  "push",
  "change.created",
  "change.updated",
  "change.merged",
  "installation.created",
  "installation.deleted",
];

function RegisterForm({ onCreated }: { onCreated: (r: CreatedIntegration) => void }) {
  const name = useSignal("");
  const description = useSignal("");
  const homepageUrl = useSignal("");
  const logoUrl = useSignal("");
  const redirects = useSignal("");
  const clientType = useSignal<ClientType>("confidential");
  const scopes = useSignal<IntegrationScope[]>([...DEPLOY_SCOPES]);
  const webhookUrl = useSignal("");
  const events = useSignal<WebhookEvent[]>(DEFAULT_EVENTS);
  const webhookSecret = useSignal("");
  const problems = useSignal<Problems>({});
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const hooks = scopes.value.includes("webhooks");

  function check(): Problems {
    const p: Problems = {};
    const n = name.value.trim();
    if (n.length < 2 || n.length > 60) p.name = "Use 2 to 60 characters.";
    p.homepageUrl = urlProblem(homepageUrl.value.trim(), "The homepage") ?? undefined;
    if (logoUrl.value.trim()) p.logoUrl = urlProblem(logoUrl.value.trim(), "The logo URL") ?? undefined;
    p.redirectUris = redirectUrisProblem(lines(redirects.value)) ?? undefined;
    if (scopes.value.length === 0) p.scopes = "Pick at least one permission.";
    if (hooks && webhookUrl.value.trim()) {
      p.webhookUrl = urlProblem(webhookUrl.value.trim(), "The webhook URL") ?? undefined;
    }
    for (const k of Object.keys(p) as Field[]) if (!p[k]) delete p[k];
    return p;
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const p = check();
    problems.value = p;
    if (Object.keys(p).length > 0) {
      error.value = "Fix the highlighted fields.";
      return;
    }
    busy.value = true;
    error.value = null;
    const hookUrl = hooks ? webhookUrl.value.trim() || null : null;
    try {
      const res = await integrationsApi.create(
        {
          name: name.value.trim(),
          description: description.value.trim() || null,
          homepageUrl: homepageUrl.value.trim(),
          logoUrl: logoUrl.value.trim() || null,
          redirectUris: lines(redirects.value),
          clientType: clientType.value,
          scopes: scopes.value,
          ...(hookUrl
            ? {
                webhook: {
                  url: hookUrl,
                  events: events.value,
                  active: true,
                  ...(webhookSecret.value.trim() ? { secret: webhookSecret.value.trim() } : {}),
                },
              }
            : {}),
        },
        key.value,
      );
      key.value = newIdempotencyKey();
      name.value = description.value = homepageUrl.value = logoUrl.value = "";
      redirects.value = webhookUrl.value = webhookSecret.value = "";
      onCreated(res);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  const bind = (s: { value: string }) => ({
    value: s.value,
    onInput: (e: Event) => (s.value = (e.currentTarget as HTMLInputElement).value),
  });
  const pr = problems.value;

  return (
    <form class="int-form" onSubmit={submit} aria-labelledby="register-title" noValidate>
      <h2 id="register-title" class="int-form__title">
        Register an integration
      </h2>
      <p class="int-form__lede">
        People see the name, logo and homepage when they install it, and the permissions in plain
        words.
      </p>

      <fieldset class="int-form__group">
        <legend class="int-form__legend">About</legend>
        <label class="field">
          <span class="field__label">Name</span>
          <input class="input" {...bind(name)} placeholder="Acme Deploy" aria-invalid={pr.name ? "true" : undefined} aria-describedby="f-name-err" />
          <FieldError id="f-name-err" msg={pr.name} />
        </label>
        <label class="field">
          <span class="field__label">
            Description <span class="int-form__opt">optional</span>
          </span>
          <textarea class="textarea" rows={2} {...bind(description)} placeholder="Deploys every push to main and a preview per Change." />
        </label>
        <label class="field">
          <span class="field__label">Homepage URL</span>
          <input class="input" type="url" inputMode="url" autoCapitalize="off" spellcheck={false} {...bind(homepageUrl)} placeholder="https://deploy.example" aria-invalid={pr.homepageUrl ? "true" : undefined} aria-describedby="f-home-err" />
          <FieldError id="f-home-err" msg={pr.homepageUrl} />
        </label>
        <label class="field">
          <span class="field__label">
            Logo URL <span class="int-form__opt">optional</span>
          </span>
          <input class="input" type="url" inputMode="url" autoCapitalize="off" spellcheck={false} {...bind(logoUrl)} placeholder="https://deploy.example/logo.svg" aria-invalid={pr.logoUrl ? "true" : undefined} aria-describedby="f-logo-hint f-logo-err" />
          <span class="field__hint" id="f-logo-hint">A square image. Without one, people see its initials.</span>
          <FieldError id="f-logo-err" msg={pr.logoUrl} />
        </label>
      </fieldset>

      <fieldset class="int-form__group">
        <legend class="int-form__legend">Sign-in</legend>
        <label class="field">
          <span class="field__label">Redirect URIs</span>
          <textarea class="textarea mono" rows={3} autoCapitalize="off" spellcheck={false} {...bind(redirects)} placeholder="https://deploy.example/oauth/callback" aria-invalid={pr.redirectUris ? "true" : undefined} aria-describedby="f-redir-hint f-redir-err" />
          <span class="field__hint" id="f-redir-hint">
            One per line. The callback must match one exactly, including path and trailing slash.
            http:// only for localhost.
          </span>
          <FieldError id="f-redir-err" msg={pr.redirectUris} />
        </label>
        <div class="int-checks" role="radiogroup" aria-labelledby="f-client-label">
          <span class="field__label" id="f-client-label">Client type</span>
          <label class="check">
            <input type="radio" name="client-type" checked={clientType.value === "confidential"} onChange={() => (clientType.value = "confidential")} />
            <span>Confidential</span>
            <span class="check__hint">Your server keeps a client secret. Use this for a hosted platform.</span>
          </label>
          <label class="check">
            <input type="radio" name="client-type" checked={clientType.value === "public"} onChange={() => (clientType.value = "public")} />
            <span>Public</span>
            <span class="check__hint">No secret; proves itself with PKCE. For CLIs and apps that can't keep one.</span>
          </label>
        </div>
      </fieldset>

      <div class="int-form__group">
        <ScopeChecklist value={scopes.value} onChange={(v) => (scopes.value = v)} />
        <p class="field__hint">Deploy platforms need only the first four.</p>
        <FieldError id="f-scopes-err" msg={pr.scopes} />
      </div>

      <fieldset class="int-form__group" disabled={!hooks}>
        <legend class="int-form__legend">Webhook</legend>
        {!hooks ? <p class="field__hint">Needs the Receive events permission.</p> : null}
        <label class="field">
          <span class="field__label">
            Webhook URL <span class="int-form__opt">optional</span>
          </span>
          <input class="input" type="url" inputMode="url" autoCapitalize="off" spellcheck={false} {...bind(webhookUrl)} placeholder="https://deploy.example/hooks/gittifacts" aria-invalid={pr.webhookUrl ? "true" : undefined} aria-describedby="f-hook-err" />
          <FieldError id="f-hook-err" msg={pr.webhookUrl} />
        </label>
        <EventChecklist value={events.value} onChange={(v) => (events.value = v)} disabled={!hooks || !webhookUrl.value.trim()} />
        <label class="field">
          <span class="field__label">
            Webhook secret <span class="int-form__opt">optional</span>
          </span>
          <input class="input mono" type="password" autoComplete="new-password" {...bind(webhookSecret)} disabled={!hooks || !webhookUrl.value.trim()} aria-describedby="f-secret-hint" />
          <span class="field__hint" id="f-secret-hint">
            Leave it empty and we generate one and show it once. Every delivery is signed with it in
            X-Gittifacts-Signature-256.
          </span>
        </label>
      </fieldset>

      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <Button type="submit" variant="primary" icon="plus" busy={busy.value} busyLabel="Registering…">
        Register integration
      </Button>
    </form>
  );
}

function IntegrationRow({ it }: { it: IntegrationView }) {
  const now = minuteClock.value;
  const href = `/settings/integrations/developer/${encodeURIComponent(it.id)}`;
  return (
    <li class="dev-int">
      <a href={href} class="dev-int__link">
        <IntegrationLogo name={it.name} logoUrl={it.logoUrl} size={36} />
        <span class="dev-int__main">
          <span class="dev-int__name">{it.name}</span>
          <span class="dev-int__meta">
            <code>{it.clientId}</code> · {it.clientType === "public" ? "Public client" : "Confidential"} ·{" "}
            {hostOf(it.homepageUrl, it.homepageUrl)}
          </span>
          <span class="dev-int__meta">
            {it.installationCount === 0 ? "Not installed yet" : `Installed on ${plural(it.installationCount, "account")}`}{" "}
            · {it.webhook.url ? (it.webhook.active ? "Webhook on" : "Webhook paused") : "No webhook"} · created{" "}
            {relative(it.createdAt, now)}
          </span>
        </span>
        <Icon name="chevron-right" class="dev-int__chev" />
      </a>
    </li>
  );
}

function revealItems(r: CreatedIntegration): SecretItem[] {
  const items: SecretItem[] = [{ label: "Client ID", value: r.integration.clientId, secret: false }];
  if (r.clientSecret) {
    items.push({ label: "Client secret", value: r.clientSecret, secret: true, hint: "Send it from your server only, never from a browser or an app." });
  }
  if (r.webhookSecret) {
    items.push({ label: "Webhook secret", value: r.webhookSecret, secret: true, hint: "Verify X-Gittifacts-Signature-256 (HMAC-SHA256 of the raw body) with it." });
  }
  return items;
}

export function IntegrationsDeveloper() {
  const { route, query } = useLocation();
  const res = useResource(() => integrationsApi.list(), []);
  const created = useSignal<CreatedIntegration | null>(null);
  const st = res.state.value;

  return (
    <Page
      title="Developer portal"
      wide
      crumbs={[{ href: "/settings/integrations", label: "Integrations" }]}
      meta={
        <span>
          Register an integration so a deploy platform can clone the repositories people install it
          on, receive webhooks and report deployments. See the{" "}
          <a href="/docs/integrations">integration docs</a>.
        </span>
      }
    >
      {query.deleted ? (
        <p class="int-notice" role="status">
          <Icon name="check-circle" size={16} /> {query.deleted} is deleted. It was uninstalled
          everywhere and its tokens stopped working.
        </p>
      ) : null}
      {created.value ? (
        <SecretReveal
          title={`${created.value.integration.name} is registered`}
          items={revealItems(created.value)}
          doneLabel="I stored them, open settings"
          onDone={() => {
            const id = created.value?.integration.id ?? "";
            created.value = null;
            route(`/settings/integrations/developer/${encodeURIComponent(id)}`);
          }}
        >
          {created.value.clientSecret === null ? (
            <p class="field__hint">Public client: no secret. It signs in with PKCE.</p>
          ) : null}
        </SecretReveal>
      ) : null}
      <div class="dev-layout">
        <section class="dev-main" aria-labelledby="mine-title">
          <h2 id="mine-title" class="int-section__title">
            Your integrations
            {st.status === "ok" ? <span class="tnum int-n">{st.data.integrations.length}</span> : null}
          </h2>
          {st.status === "loading" ? <Loading label="Loading your integrations" lines={5} /> : null}
          {st.status === "error" ? (
            <ErrorState error={st.error} what="your integrations" onRetry={res.reload} />
          ) : null}
          {st.status === "ok" && st.data.integrations.length === 0 ? (
            <EmptyState icon="plug" title="You haven't registered an integration">
              <p>
                Register one to get a client ID and secret. Then send people to install it from
                your platform's "connect a git provider" flow.
              </p>
            </EmptyState>
          ) : null}
          {st.status === "ok" && st.data.integrations.length > 0 ? (
            <ul class="dev-ints">
              {st.data.integrations.map((it) => (
                <IntegrationRow key={it.id} it={it} />
              ))}
            </ul>
          ) : null}
        </section>
        <aside class="dev-side" id="register">
          <RegisterForm
            onCreated={(r) => {
              created.value = r;
              res.reload();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </aside>
      </div>
    </Page>
  );
}
