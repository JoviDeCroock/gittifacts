import type { Principal, Scope } from "@app/domain";
import { useSignal } from "@preact/signals";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import type { CreateAgentResponse } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Avatar, Button, CopyButton, ErrorState, Loading } from "../components/ui.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import "../styles/agents.css";

const SCOPES: { id: Scope; label: string; hint: string; humanOnly?: boolean; caution?: boolean }[] = [
  { id: "repo:read", label: "Read repositories", hint: "Clone, read changes, tours and evidence." },
  { id: "plan:create", label: "Draft plans", hint: "Propose plans. A person still approves them." },
  { id: "change:create", label: "Start changes", hint: "Open changes against approved plans and push to their forks." },
  { id: "change:review", label: "Review changes", hint: "Record review decisions on changes it did not author." },
  { id: "plan:approve", label: "Approve plans", hint: "Approving intent is a human act. Agents cannot hold this scope.", humanOnly: true },
  { id: "repo:admin", label: "Administer repositories", hint: "Create repos and turn Lane 0 on or off.", caution: true },
  { id: "policy:admin", label: "Edit policy", hint: "Propose policy changes. Each one still needs a person's Lane 2 review.", caution: true },
];

const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.id, s.label])) as Record<Scope, string>;

function TokenReveal({ created, onDone }: { created: CreateAgentResponse; onDone: () => void }) {
  return (
    <section class="token" aria-labelledby="token-title" role="status">
      <h2 id="token-title" class="token__title">
        <Icon name="key" size={18} /> Token for {created.principal.name}
      </h2>
      <p class="token__warn">
        <b>Copy it now.</b> This is the only time it is shown. If you lose it, revoke it and create a new one.
      </p>
      <div class="token__box">
        <code class="token__value">{created.token}</code>
        <CopyButton text={created.token} label="Copy token" />
      </div>
      <p class="token__use">
        The agent sends it as <code>Authorization: Bearer …</code> to the API and to <code>/mcp</code>.
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
      error.value = "Use 2 to 41 lowercase letters, digits or hyphens, starting with a letter or digit.";
      return;
    }
    if (scopes.value.length === 0) {
      error.value = "Pick at least one scope.";
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      const res = await api.createAgent({ name: name.value.trim(), scopes: scopes.value }, newIdempotencyKey());
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
        Add an agent
      </h2>
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
        <legend class="field__label">Scopes</legend>
        {SCOPES.map((s) => (
          <label key={s.id} class={`check ${s.humanOnly ? "is-disabled" : ""}`}>
            <input type="checkbox" checked={!s.humanOnly && scopes.value.includes(s.id)} disabled={s.humanOnly} onChange={(e) => toggle(s.id, e.currentTarget.checked)} />
            <span>
              {s.label} <code class="scopes__id">{s.id}</code>
              {s.caution ? <span class="scopes__caution"> broad</span> : null}
            </span>
            <span class="check__hint">{s.hint}</span>
          </label>
        ))}
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

function AgentRow({ p, onRevoked }: { p: Principal; onRevoked: (p: Principal, n: number) => void }) {
  const confirm = useSignal(false);
  const busy = useSignal(false);
  const result = useSignal<string | null>(null);
  const active = p.keys.filter((k) => k.revokedAt === null);
  const revoked = p.keys.length - active.length;
  const newest = [...p.keys].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];

  async function revoke() {
    busy.value = true;
    try {
      const { revoked: n } = await api.revokeTokens(p.id, newIdempotencyKey());
      result.value = n === 0 ? "No active tokens to revoke." : `${plural(n, "token")} revoked. The agent is locked out now.`;
      confirm.value = false;
      onRevoked(p, n);
    } catch (err) {
      result.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <li class="agent">
      <Avatar kind={p.kind} name={p.name} size={36} />
      <div class="agent__main">
        <p class="agent__name">
          {p.name} <span class="agent__kind">{p.kind === "agent" ? "agent" : "you"}</span>
        </p>
        <p class="agent__keys">
          {active.length > 0 ? (
            <span class="tone--ok">{plural(active.length, "active token")}</span>
          ) : (
            <span class="tone--neutral">No active token</span>
          )}
          {revoked > 0 ? <span> · {revoked} revoked</span> : null}
          {newest ? <span> · newest {relative(newest.createdAt, minuteClock.value)}</span> : null}
        </p>
        <ul class="agent__scopes" aria-label="Scopes">
          {p.scopes.map((s) => (
            <li key={s} title={s}>
              {SCOPE_LABEL[s] ?? s}
            </li>
          ))}
        </ul>
        {result.value ? (
          <p class="agent__result" role="status">
            {result.value}
          </p>
        ) : null}
      </div>
      {p.kind === "agent" ? (
        <div class="agent__actions">
          {confirm.value ? (
            <div class="agent__confirm" role="group" aria-label={`Revoke tokens for ${p.name}`}>
              <p>Revoke every token for {p.name}? It stops working immediately.</p>
              <div>
                <Button variant="secondary" size="sm" onClick={() => (confirm.value = false)} disabled={busy.value}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" busy={busy.value} busyLabel="Revoking…" onClick={revoke}>
                  Revoke tokens
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger-outline" size="sm" disabled={active.length === 0} onClick={() => ((confirm.value = true), (result.value = null))}>
              Revoke tokens
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function AgentsView() {
  const res = useResource(() => api.principals(), []);
  const created = useSignal<CreateAgentResponse | null>(null);
  const st = res.state.value;
  const me = principal.value;
  const list = st.status === "ok" ? st.data.principals : [];
  const agents = list.filter((p) => p.kind === "agent");
  const self = list.find((p) => p.id === me?.id);

  return (
    <Page
      title="Agents"
      wide
      meta={<span>Agents act through the API and MCP with their own token. You are accountable for every agent you add.</span>}
    >
      <div class="agents-layout">
        <div class="agents-main">
          {created.value ? <TokenReveal created={created.value} onDone={() => (created.value = null)} /> : null}
          {st.status === "loading" ? <Loading label="Loading agents" lines={6} /> : null}
          {st.status === "error" ? <ErrorState error={st.error} what="your agents" onRetry={res.reload} /> : null}
          {st.status === "ok" ? (
            <>
              <h2 class="agents__title">
                Your agents <span class="tnum agents__n">{agents.length}</span>
              </h2>
              {agents.length === 0 ? (
                <p class="ev-sub">No agents yet. Add one to give a coding agent its own identity and token.</p>
              ) : (
                <ul class="agents">
                  {agents.map((p) => (
                    <AgentRow key={p.id} p={p} onRevoked={() => res.reload()} />
                  ))}
                </ul>
              )}
              {self ? (
                <>
                  <h2 class="agents__title">You</h2>
                  <ul class="agents">
                    <AgentRow p={self} onRevoked={() => res.reload()} />
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
