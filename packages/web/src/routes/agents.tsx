import type { Principal, Scope } from "@app/domain";
import { useSignal } from "@preact/signals";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import { type AgentSession, oauthApi } from "../api/oauth.js";
import type { CreateAgentResponse } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Avatar, Button, CopyButton, ErrorState, Loading } from "../components/ui.js";
import { cliCommand } from "../lib/cli.js";
import { neverSentence, sessionLine } from "../lib/consent-copy.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import "../styles/agents.css";

/** What an agent may be given. Approval-class scopes are never offered: humans approve intent. */
const SCOPES: { id: Scope; label: string; hint: string }[] = [
  {
    id: "change:create",
    label: "Open Changes",
    hint: "Start Changes and push to their forks. A person still reviews them.",
  },
  {
    id: "plan:create",
    label: "Draft Plans",
    hint: "Propose Plans. Only a person can approve one.",
  },
  { id: "repo:read", label: "Read", hint: "Clone and read code, Changes, tours and evidence." },
];
const NEVER_LINE = neverSentence(
  ["plan:approve", "change:review", "policy:admin", "repo:admin"],
  "Agents",
);

const FLOW: Record<AgentSession["flow"], { label: string; icon: "route" | "monitor" | "key" }> = {
  authorization_code: { label: "MCP sign-in", icon: "route" },
  device_code: { label: "Device login", icon: "monitor" },
  manual: { label: "Token", icon: "key" },
};

function TokenReveal({ created, onDone }: { created: CreateAgentResponse; onDone: () => void }) {
  return (
    <section class="token" aria-labelledby="token-title" role="status">
      <h2 id="token-title" class="token__title">
        <Icon name="key" size={18} /> Token for {created.principal.name}
      </h2>
      <p class="token__warn">
        <b>Copy it now.</b> This is the only time it is shown. If you lose it, revoke it and create
        a new one.
      </p>
      <div class="token__box">
        <code class="token__value">{created.token}</code>
        <CopyButton text={created.token} label="Copy token" />
      </div>
      <p class="token__use">
        The agent sends it as <code>Authorization: Bearer …</code> to the API and to{" "}
        <code>/mcp</code>.
      </p>
      <Button variant="primary" onClick={onDone}>
        I stored the token
      </Button>
    </section>
  );
}

function CreateAgent({ onCreated }: { onCreated: (r: CreateAgentResponse) => void }) {
  const name = useSignal("");
  const scopes = useSignal<Scope[]>(["repo:read", "change:create"]);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

  function toggle(s: Scope, on: boolean) {
    scopes.value = on ? [...scopes.value, s] : scopes.value.filter((x) => x !== s);
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name.value.trim())) {
      error.value =
        "Use 2 to 41 lowercase letters, digits or hyphens, starting with a letter or digit.";
      return;
    }
    if (scopes.value.length === 0) {
      error.value = "Pick at least one scope.";
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      const res = await api.createAgent(
        { name: name.value.trim(), scopes: scopes.value },
        newIdempotencyKey(),
      );
      name.value = "";
      onCreated(res);
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <form class="create-agent" onSubmit={submit} aria-labelledby="create-title">
      <h2 id="create-title" class="create-agent__title">
        Add an agent by hand
      </h2>
      <p class="create-agent__lede">
        For agents that can't sign in. MCP clients and the CLI connect on their own and ask you to
        approve; each connection shows up on the left.
      </p>
      <label class="field">
        <span class="field__label">Name</span>
        <input
          class="input"
          value={name.value}
          onInput={(e) => (name.value = e.currentTarget.value)}
          placeholder="fleet-coder-08"
          autoCapitalize="off"
          autoCorrect="off"
          spellcheck={false}
          aria-describedby="name-hint"
          aria-invalid={error.value?.startsWith("Use") ? "true" : undefined}
        />
        <span class="field__hint" id="name-hint">
          Lowercase letters, digits and hyphens. It appears on every change the agent authors.
        </span>
      </label>
      <fieldset class="scopes">
        <legend class="field__label">What it may do</legend>
        {SCOPES.map((s) => (
          <label key={s.id} class="check">
            <input
              type="checkbox"
              checked={scopes.value.includes(s.id)}
              onChange={(e) => toggle(s.id, e.currentTarget.checked)}
            />
            <span>
              {s.label} <code class="scopes__id">{s.id}</code>
            </span>
            <span class="check__hint">{s.hint}</span>
          </label>
        ))}
        <p class="scopes__never">
          <Icon name="shield-check" size={14} /> {NEVER_LINE}
        </p>
      </fieldset>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
      <Button type="submit" variant="primary" icon="plus" busy={busy.value} busyLabel="Creating…">
        Create agent and token
      </Button>
    </form>
  );
}

function canLine(s: AgentSession): string {
  return sessionLine(
    s.scopes,
    s.repoIds === null ? { kind: "all" } : { kind: "some", names: s.repos.map((r) => r.name) },
  );
}

function whenLine(s: AgentSession, now: number): string {
  const parts = [`Created ${relative(s.createdAt, now)}`];
  parts.push(s.lastUsedAt ? `last used ${relative(s.lastUsedAt, now)}` : "never used");
  if (s.status === "revoked" && s.revokedAt) parts.push(`revoked ${relative(s.revokedAt, now)}`);
  else if (s.expiresAt)
    parts.push(`${Date.parse(s.expiresAt) > now ? "ends" : "ended"} ${relative(s.expiresAt, now)}`);
  else parts.push("no end date");
  return parts.join(" · ");
}

function SessionRow({ s, onRevoked }: { s: AgentSession; onRevoked: (s: AgentSession) => void }) {
  const confirm = useSignal(false);
  const busy = useSignal(false);
  const result = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const flow = FLOW[s.flow];
  const now = minuteClock.value;

  async function revoke() {
    busy.value = true;
    try {
      const { session } = await oauthApi.revokeSession(s.principalId, key.value);
      result.value = `Revoked. ${s.name} is locked out now.`;
      confirm.value = false;
      onRevoked(session);
    } catch (err) {
      result.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <li class={`agent agent--${s.status}`}>
      <Avatar kind="agent" name={s.name} size={36} />
      <div class="agent__main">
        <p class="agent__name">
          {s.name}
          <span class={`agent__status agent__status--${s.status}`}>
            {s.status === "active" ? "Active" : s.status === "expired" ? "Ended" : "Revoked"}
          </span>
        </p>
        <p class="agent__via">
          <Icon name={flow.icon} size={14} /> {flow.label}
          {s.client && s.client.name !== s.name ? <span> · {s.client.name}</span> : null}
          {s.client?.id.startsWith("https://") ? (
            <span class="agent__host"> · {new URL(s.client.id).host}</span>
          ) : null}
        </p>
        <p class="agent__can">{canLine(s)}</p>
        <p class="agent__keys">{whenLine(s, now)}</p>
        {result.value ? (
          <p class="agent__result" role="status">
            {result.value}
          </p>
        ) : null}
      </div>
      {s.status === "active" ? (
        <div class="agent__actions">
          {confirm.value ? (
            <fieldset class="agent__confirm" aria-label={`Revoke ${s.name}`}>
              <p>Revoke {s.name}? Every token it holds stops working immediately.</p>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => (confirm.value = false)}
                  disabled={busy.value}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  busy={busy.value}
                  busyLabel="Revoking…"
                  onClick={revoke}
                >
                  Revoke access
                </Button>
              </div>
            </fieldset>
          ) : (
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => {
                confirm.value = true;
                result.value = null;
              }}
            >
              Revoke
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function SelfRow({ p }: { p: Principal }) {
  return (
    <li class="agent">
      <Avatar kind={p.kind} name={p.name} size={36} />
      <div class="agent__main">
        <p class="agent__name">
          {p.name} <span class="agent__kind">you</span>
        </p>
        <p class="agent__keys">
          You approve Plans and review Changes. You can delegate only what you hold.
        </p>
        <ul class="agent__scopes" aria-label="Scopes">
          {p.scopes.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
    </li>
  );
}

export function AgentsView() {
  const res = useResource(() => oauthApi.sessions(), []);
  const created = useSignal<CreateAgentResponse | null>(null);
  const showEnded = useSignal(false);
  const notice = useSignal<string | null>(null);
  const st = res.state.value;
  const me = principal.value;
  const sessions = st.status === "ok" ? st.data.sessions : [];
  const active = sessions.filter((s) => s.status === "active");
  const ended = sessions.filter((s) => s.status !== "active");

  function replace(updated: AgentSession) {
    if (st.status !== "ok") return;
    notice.value = `${updated.name} is revoked. Every token it held stopped working; it is listed under Ended and revoked.`;
    res.set({
      sessions: st.data.sessions.map((s) => (s.principalId === updated.principalId ? updated : s)),
    });
  }

  return (
    <Page
      title="Agents"
      wide
      meta={
        <span>
          Every connected MCP client, CLI login and hand-made token is its own agent, owned by you.
          Revoke one and it stops working at once.
        </span>
      }
    >
      <div class="agents-layout">
        <div class="agents-main">
          {created.value ? (
            <TokenReveal created={created.value} onDone={() => (created.value = null)} />
          ) : null}
          {st.status === "loading" ? <Loading label="Loading agent sessions" lines={6} /> : null}
          {st.status === "error" ? (
            <ErrorState error={st.error} what="your agent sessions" onRetry={res.reload} />
          ) : null}
          {notice.value ? (
            <p class="agents__notice" role="status">
              <Icon name="check-circle" size={16} /> {notice.value}
            </p>
          ) : null}
          {st.status === "ok" ? (
            <>
              <h2 class="agents__title">
                Active sessions <span class="tnum agents__n">{active.length}</span>
              </h2>
              {active.length === 0 ? (
                <p class="ev-sub">
                  No agent can act for you right now. Connect an MCP client to <code>/mcp</code>,
                  run <code>{cliCommand("login")}</code>, or add one by hand.
                </p>
              ) : (
                <ul class="agents">
                  {active.map((s) => (
                    <SessionRow key={s.principalId} s={s} onRevoked={replace} />
                  ))}
                </ul>
              )}
              {ended.length > 0 ? (
                <details
                  class="disclosure agents__ended"
                  open={showEnded.value}
                  onToggle={(e) => (showEnded.value = e.currentTarget.open)}
                >
                  <summary>
                    <Icon name="chevron-down" class="disclosure__chev" />
                    Ended and revoked{" "}
                    <span class="tnum agents__n">{plural(ended.length, "session")}</span>
                  </summary>
                  <ul class="agents">
                    {ended.map((s) => (
                      <SessionRow key={s.principalId} s={s} onRevoked={replace} />
                    ))}
                  </ul>
                </details>
              ) : null}
              {me ? (
                <>
                  <h2 class="agents__title">You</h2>
                  <ul class="agents">
                    <SelfRow p={me} />
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
        </div>
        <aside class="agents-side">
          <CreateAgent
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
