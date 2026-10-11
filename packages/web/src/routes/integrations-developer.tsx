/**
 * /settings/integrations/developer — the developer portal: integrations you registered, and the
 * form to register one. The client secret (and a generated webhook secret) is shown once.
 */
import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
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
  type SecretItem,
  SecretReveal,
} from "../components/Integrations.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, LinkButton, Loading } from "../components/ui.js";
import {
  DEPLOY_SCOPES,
  hostOf,
  lines,
  redirectUrisProblem,
  urlProblem,
} from "../lib/integrations.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { prefersReducedMotion } from "../state/media.js";
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

/** Where each problem lives, in the form's order: the summary links there and focus goes to the first. */
const FIELD_ORDER: { field: Field; id: string; label: string }[] = [
  { field: "name", id: "f-name", label: "Name" },
  { field: "homepageUrl", id: "f-home", label: "Homepage URL" },
  { field: "logoUrl", id: "f-logo", label: "Logo URL" },
  { field: "redirectUris", id: "f-redir", label: "Redirect URIs" },
  { field: "scopes", id: "f-scopes", label: "Permissions" },
  { field: "webhookUrl", id: "f-hook", label: "Webhook URL" },
];

function focusField(id: string) {
  const el = document.getElementById(id);
  const target = el?.matches("input, textarea")
    ? el
    : el?.querySelector<HTMLElement>("input, textarea");
  target?.focus();
  target?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** One numbered step of the form: what it is for on the left, its fields on the right. */
function Step({
  n,
  title,
  lede,
  children,
  disabled,
}: {
  n: number;
  title: string;
  lede: string;
  children: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <fieldset class="int-step" disabled={disabled}>
      <legend class="sr-only">
        Step {n}: {title}
      </legend>
      <div class="int-step__head" aria-hidden="true">
        <span class="int-step__n tnum">{n}</span>
        <span class="int-step__title">{title}</span>
        <span class="int-step__lede">{lede}</span>
      </div>
      <div class="int-step__body">{children}</div>
    </fieldset>
  );
}

function RegisterForm({
  onCreated,
  onCancel,
}: {
  onCreated: (r: CreatedIntegration) => void;
  onCancel: () => void;
}) {
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
    if (logoUrl.value.trim())
      p.logoUrl = urlProblem(logoUrl.value.trim(), "The logo URL") ?? undefined;
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
    const first = FIELD_ORDER.find((f) => p[f.field]);
    if (first) {
      error.value = null;
      // Straight to the first problem (it scrolls into view); the summary lists the rest.
      focusField(first.id);
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

  const listed = FIELD_ORDER.filter((f) => pr[f.field]);
  const inv = (f: Field) => (pr[f] ? ("true" as const) : undefined);

  return (
    <form class="int-form" onSubmit={submit} aria-label="Register an integration" noValidate>
      {listed.length > 0 ? (
        <div class="int-form__problems" role="alert" data-testid="register-problems">
          <p>
            <b>
              {listed.length === 1 ? "One field needs a fix" : `${listed.length} fields need a fix`}
            </b>
          </p>
          <ul>
            {listed.map((f) => (
              <li key={f.field}>
                <a
                  href={`#${f.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    focusField(f.id);
                  }}
                >
                  {f.label}
                </a>
                : {pr[f.field]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Step n={1} title="About" lede="What people see when they install it.">
        <label class="field">
          <span class="field__label">Name</span>
          <input
            id="f-name"
            class="input"
            {...bind(name)}
            autoComplete="off"
            spellcheck={false}
            placeholder="Acme Deploy"
            aria-invalid={inv("name")}
            aria-describedby="f-name-err"
          />
          <FieldError id="f-name-err" msg={pr.name} />
        </label>
        <label class="field">
          <span class="field__label">
            Description <span class="int-form__opt">optional</span>
          </span>
          <textarea
            class="textarea"
            rows={2}
            {...bind(description)}
            placeholder="Deploys every push to main and a preview per Change."
          />
        </label>
        <label class="field">
          <span class="field__label">Homepage URL</span>
          <input
            id="f-home"
            class="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            {...bind(homepageUrl)}
            placeholder="https://deploy.example"
            aria-invalid={inv("homepageUrl")}
            aria-describedby="f-home-err"
          />
          <FieldError id="f-home-err" msg={pr.homepageUrl} />
        </label>
        <label class="field">
          <span class="field__label">
            Logo URL <span class="int-form__opt">optional</span>
          </span>
          <input
            id="f-logo"
            class="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            {...bind(logoUrl)}
            placeholder="https://deploy.example/logo.svg"
            aria-invalid={inv("logoUrl")}
            aria-describedby="f-logo-hint f-logo-err"
          />
          <span class="field__hint" id="f-logo-hint">
            A square image. Without one, people see its initials.
          </span>
          <FieldError id="f-logo-err" msg={pr.logoUrl} />
        </label>
      </Step>

      <Step
        n={2}
        title="Sign-in"
        lede="Where people return after they approve, and how your app proves itself."
      >
        <label class="field">
          <span class="field__label">Redirect URIs</span>
          <textarea
            id="f-redir"
            class="textarea mono"
            rows={3}
            autoCapitalize="off"
            spellcheck={false}
            {...bind(redirects)}
            placeholder="https://deploy.example/oauth/callback"
            aria-invalid={inv("redirectUris")}
            aria-describedby="f-redir-hint f-redir-err"
          />
          <span class="field__hint" id="f-redir-hint">
            One per line. The callback must match one exactly, including path and trailing slash.
            http:// only for localhost.
          </span>
          <FieldError id="f-redir-err" msg={pr.redirectUris} />
        </label>
        <div class="int-checks" role="radiogroup" aria-labelledby="f-client-label">
          <span class="field__label" id="f-client-label">
            Client type
          </span>
          <label class="check">
            <input
              type="radio"
              name="client-type"
              checked={clientType.value === "confidential"}
              onChange={() => (clientType.value = "confidential")}
            />
            <span>Confidential</span>
            <span class="check__hint">
              Your server keeps a client secret. Use this for a hosted platform.
            </span>
          </label>
          <label class="check">
            <input
              type="radio"
              name="client-type"
              checked={clientType.value === "public"}
              onChange={() => (clientType.value = "public")}
            />
            <span>Public</span>
            <span class="check__hint">
              No secret; proves itself with PKCE. For CLIs and apps that can't keep one.
            </span>
          </label>
        </div>
      </Step>

      <Step
        n={3}
        title="Permissions"
        lede="What it asks for when people install it. Deploy platforms need only the first four."
      >
        <div id="f-scopes">
          <ScopeChecklist value={scopes.value} onChange={(v) => (scopes.value = v)} />
        </div>
        <FieldError id="f-scopes-err" msg={pr.scopes} />
      </Step>

      <Step
        n={4}
        title="Webhook"
        lede={
          hooks
            ? "Where events go, and the secret that signs them."
            : "Needs the Receive events permission."
        }
        disabled={!hooks}
      >
        <label class="field">
          <span class="field__label">
            Webhook URL <span class="int-form__opt">optional</span>
          </span>
          <input
            id="f-hook"
            class="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            {...bind(webhookUrl)}
            placeholder="https://deploy.example/hooks/gittifacts"
            aria-invalid={inv("webhookUrl")}
            aria-describedby="f-hook-err"
          />
          <FieldError id="f-hook-err" msg={pr.webhookUrl} />
        </label>
        <EventChecklist
          value={events.value}
          onChange={(v) => (events.value = v)}
          disabled={!hooks || !webhookUrl.value.trim()}
        />
        <label class="field">
          <span class="field__label">
            Webhook secret <span class="int-form__opt">optional</span>
          </span>
          <input
            class="input mono"
            type="password"
            autoComplete="new-password"
            {...bind(webhookSecret)}
            disabled={!hooks || !webhookUrl.value.trim()}
            aria-describedby="f-secret-hint"
          />
          <span class="field__hint" id="f-secret-hint">
            Leave it empty and we generate one and show it once. Every delivery is signed with it in
            X-Gittifacts-Signature-256.
          </span>
        </label>
      </Step>

      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <div class="int-form__actions">
        <Button
          type="submit"
          variant="primary"
          icon="plus"
          busy={busy.value}
          busyLabel="Registering…"
        >
          Register integration
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy.value}>
          Cancel
        </Button>
      </div>
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
            by {it.developer.name} · {hostOf(it.homepageUrl, it.homepageUrl)}
          </span>
          <span class="dev-int__meta">
            <code>{it.clientId}</code> ·{" "}
            {it.clientType === "public" ? "Public client" : "Confidential"}
          </span>
          <span class="dev-int__meta">
            {it.installationCount === 0
              ? "Not installed yet"
              : `Installed on ${plural(it.installationCount, "account")}`}{" "}
            ·{" "}
            {it.webhook.url ? (it.webhook.active ? "Webhook on" : "Webhook paused") : "No webhook"}{" "}
            · created {relative(it.createdAt, now)}
          </span>
        </span>
        <Icon name="chevron-right" class="dev-int__chev" />
      </a>
    </li>
  );
}

function revealItems(r: CreatedIntegration): SecretItem[] {
  const items: SecretItem[] = [
    { label: "Client ID", value: r.integration.clientId, secret: false },
  ];
  if (r.clientSecret) {
    items.push({
      label: "Client secret",
      value: r.clientSecret,
      secret: true,
      hint: "Send it from your server only, never from a browser or an app.",
    });
  }
  if (r.webhookSecret) {
    items.push({
      label: "Webhook secret",
      value: r.webhookSecret,
      secret: true,
      hint: "Verify X-Gittifacts-Signature-256 (HMAC-SHA256 of the raw body) with it.",
    });
  }
  return items;
}

const PATH = "/settings/integrations/developer";

export function IntegrationsDeveloper() {
  const { route, query } = useLocation();
  const res = useResource(() => integrationsApi.list(), []);
  const created = useSignal<CreatedIntegration | null>(null);
  const st = res.state.value;
  // Registering is its own task in the main column (`?register`), not a rail beside the list.
  const registering = query.register !== undefined;
  const open = () => route(`${PATH}?register`);

  return (
    <Page
      title={registering ? "Register an integration" : "Developer portal"}
      wide={!registering}
      crumbs={[
        { href: "/settings/integrations", label: "Integrations" },
        ...(registering ? [{ href: PATH, label: "Developer portal" }] : []),
      ]}
      actions={
        registering ? undefined : (
          <LinkButton
            href={`${PATH}?register`}
            variant="primary"
            icon="plus"
            data-testid="register-open"
          >
            Register an integration
          </LinkButton>
        )
      }
      meta={
        registering ? (
          <span>
            People see the name, logo and homepage when they install it, and the permissions in
            plain words. You get a client ID and secret at the end.
          </span>
        ) : (
          <span>
            Register an integration so a deploy platform can clone the repositories people install
            it on, receive webhooks and report deployments. See the{" "}
            <a href="/docs/integrations">integration docs</a>.
          </span>
        )
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
            route(`${PATH}/${encodeURIComponent(id)}`);
          }}
        >
          {created.value.clientSecret === null ? (
            <p class="field__hint">Public client: no secret. It signs in with PKCE.</p>
          ) : null}
        </SecretReveal>
      ) : null}
      {registering ? (
        <RegisterForm
          onCancel={() => route(PATH)}
          onCreated={(r) => {
            created.value = r;
            res.reload();
            route(PATH);
            window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
          }}
        />
      ) : (
        <section class="dev-main" aria-labelledby="mine-title">
          <h2 id="mine-title" class="int-section__title">
            Your integrations
            {st.status === "ok" ? (
              <span class="tnum int-n">{st.data.integrations.length}</span>
            ) : null}
          </h2>
          {st.status === "loading" ? <Loading label="Loading your integrations" lines={5} /> : null}
          {st.status === "error" ? (
            <ErrorState error={st.error} what="your integrations" onRetry={res.reload} />
          ) : null}
          {st.status === "ok" && st.data.integrations.length === 0 ? (
            <EmptyState icon="plug" title="You haven't registered an integration">
              <p>
                Register one to get a client ID and secret. Then send people to install it from your
                platform's "connect a git provider" flow.
              </p>
              <Button variant="primary" icon="plus" onClick={open}>
                Register an integration
              </Button>
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
      )}
    </Page>
  );
}
