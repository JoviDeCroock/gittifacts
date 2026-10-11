/**
 * Agents: each agent's home. A row says what the agent is doing now and what it last did (to which
 * plan or change, read from the signed audit log, the same words as the dashboard's band), what it
 * may touch, its trail through the log, and Revoke. Other people's agents active in your
 * repositories are listed read-only, so every row of the band has a destination. Connecting is the
 * common path (MCP or the CLI); a hand-made token sits behind a disclosure.
 */
import type { Principal, Scope } from "@app/domain";
import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import { type AgentSession, oauthApi } from "../api/oauth.js";
import type { ChangeSummary, CreateAgentResponse } from "../api/types.js";
import { AgentMark } from "../components/AgentMark.js";
import { CopyLine } from "../components/CopyLine.js";
import { LastAct, ownerLine, StateWord } from "../components/Fleet.js";
import { Icon } from "../components/Icon.js";
import { RepoPicker } from "../components/Integrations.js";
import { McpSetup } from "../components/McpSetup.js";
import { Term } from "../components/Term.js";
import { Page } from "../components/Shell.js";
import { Avatar, Button, CopyButton, ErrorState, LinkButton, Loading, Segmented, SkeletonHead, SkeletonRows } from "../components/ui.js";
import { cliCommand } from "../lib/cli.js";
import { neverSentence } from "../lib/consent-copy.js";
import { type AgentActivity, fleetFrom, trailHref } from "../lib/fleet.js";
import { scopeWords } from "../lib/terms.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { prefersReducedMotion } from "../state/media.js";
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
  { id: "repo:read", label: "Read", hint: "Clone and read code, Changes, walkthroughs and evidence." },
];
const NEVER_LINE = neverSentence(["plan:approve", "change:review", "policy:admin", "repo:admin"], "Agents");
/** How long a hand-made token works. The platform's default is 90 days. */
const EXPIRY = ["7", "30", "90", "365"] as const;

const FLOW: Record<AgentSession["flow"], { label: string; icon: "route" | "monitor" | "key" }> = {
  authorization_code: { label: "MCP sign-in", icon: "route" },
  device_code: { label: "Device login", icon: "monitor" },
  manual: { label: "Token", icon: "key" },
};

function TokenReveal({ created, onDone }: { created: CreateAgentResponse; onDone: () => void }) {
  return (
    <section class="token" aria-labelledby="token-title" role="status" data-testid="agent-token">
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
        The agent sends it as <code>Authorization: Bearer …</code> to the API and to{" "}
        <code>/mcp</code>. Set up its MCP client with the token filled in:
      </p>
      <McpSetup token={created.token} idPrefix="token-mcp" />
      <Button variant="primary" onClick={onDone}>
        I stored the token
      </Button>
    </section>
  );
}

/** The common path: an MCP client or the CLI connects on its own and asks you to approve. */
function Connect() {
  return (
    <section class="connect" aria-labelledby="connect-title" data-testid="connect-agent">
      <h2 id="connect-title" class="connect__title">
        Connect an agent
      </h2>
      <p class="connect__lede">
        Add gittifacts to your agent's MCP client, or log in with the CLI. Either asks you to approve what it may do, then
        shows up here as its own agent.
      </p>
      <span class="connect__label">MCP client</span>
      <McpSetup />
      <span class="connect__label">CLI</span>
      <CopyLine text={cliCommand("login")} label="Copy the CLI login command" />
    </section>
  );
}

/** For agents that can't sign in: a name, repositories, scopes and an end date, then a token. */
function CreateAgent({ onCreated }: { onCreated: (r: CreateAgentResponse) => void }) {
  const name = useSignal("");
  const scopes = useSignal<Scope[]>(["repo:read", "change:create"]);
  const selection = useSignal<"all" | "selected">("selected");
  const picked = useSignal<string[]>([]);
  const days = useSignal<(typeof EXPIRY)[number]>("90");
  const busy = useSignal(false);
  const error = useSignal<{ field: "name" | "repos" | "scopes" | null; text: string } | null>(null);
  // With one repository there is nothing to choose: it is picked (as on the consent screen).
  const repos = useResource(
    () =>
      api.repos().then((r) => {
        if (r.repos.length === 1 && r.repos[0] && picked.value.length === 0) picked.value = [r.repos[0].id];
        return r;
      }),
    [],
  );
  const list = repos.state.value.status === "ok" ? repos.state.value.data.repos.map((r) => ({ id: r.id, name: r.name, fullName: r.name })) : [];
  // Until the list arrives there is nothing to pick (and the one repo isn't picked yet): submit waits.
  const reposLoading = repos.state.value.status === "loading";
  // A repository picked (or all of them) answers the error about repositories.
  const answered = () => {
    if (error.value?.field === "repos") error.value = null;
  };

  function toggle(s: Scope, on: boolean) {
    scopes.value = on ? [...scopes.value, s] : scopes.value.filter((x) => x !== s);
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value || reposLoading) return;
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name.value.trim())) {
      error.value = { field: "name", text: "Use 2 to 41 lowercase letters, digits or hyphens, starting with a letter or digit." };
      return;
    }
    if (selection.value === "selected" && picked.value.length === 0) {
      error.value = { field: "repos", text: "Pick at least one repository, or choose all of them." };
      return;
    }
    if (scopes.value.length === 0) {
      error.value = { field: "scopes", text: "Pick at least one thing it may do." };
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      const res = await api.createAgent(
        {
          name: name.value.trim(),
          scopes: scopes.value,
          ...(selection.value === "selected" ? { repoIds: picked.value } : {}),
          expiresInDays: Number(days.value),
        },
        newIdempotencyKey(),
      );
      name.value = "";
      picked.value = [];
      onCreated(res);
    } catch (err) {
      error.value = { field: null, text: inlineError(err) };
    } finally {
      busy.value = false;
    }
  }

  return (
    <form class="create-agent" onSubmit={submit} aria-label="Add an agent by hand" data-testid="create-agent">
      <p class="create-agent__lede">
        For agents that can't sign in. You get a token to paste into the agent; it works until you revoke it or it ends.
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
          aria-invalid={error.value?.field === "name" ? "true" : undefined}
        />
        <span class="field__hint" id="name-hint">
          Lowercase letters, digits and hyphens. It appears on every change the agent authors.
        </span>
      </label>
      <fieldset class="scopes" aria-invalid={error.value?.field === "repos" ? "true" : undefined}>
        <legend class="field__label">Repositories</legend>
        {repos.state.value.status === "loading" ? (
          <Loading label="Loading your repositories" lines={2} />
        ) : (
          <RepoPicker
            name="agent-repos"
            repos={list}
            selection={selection.value}
            picked={picked.value}
            onSelection={(v) => {
              selection.value = v;
              answered();
            }}
            onToggle={(id, on) => {
              picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id);
              if (on) answered();
            }}
            allLabel="All repositories you can access"
            later="any you get access to later"
            none="You have no repositories yet. Create or claim one first, or give it all of them."
          />
        )}
      </fieldset>
      <fieldset class="scopes" aria-invalid={error.value?.field === "scopes" ? "true" : undefined}>
        <legend class="field__label">
          What it may do (its <Term id="scopes">scopes</Term>)
        </legend>
        {SCOPES.map((s) => (
          <label key={s.id} class="check">
            <input type="checkbox" checked={scopes.value.includes(s.id)} onChange={(e) => toggle(s.id, e.currentTarget.checked)} />
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
      <div class="field">
        <span class="field__label" id="expiry-label">
          Token ends after
        </span>
        <Segmented
          label="Token ends after"
          value={days.value}
          options={EXPIRY.map((d) => ({ id: d, label: d === "365" ? "1 year" : `${d} days` }))}
          onChange={(v) => (days.value = v)}
        />
      </div>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value.text}
        </p>
      ) : null}
      <Button type="submit" variant="primary" icon="plus" busy={busy.value || reposLoading} busyLabel={reposLoading ? "Loading repositories…" : "Creating…"}>
        Create agent and token
      </Button>
    </form>
  );
}

const CAN: Partial<Record<Scope, string>> = { "change:create": "open Changes", "plan:create": "draft Plans", "repo:read": "read code" };
const OPEN = new Set(["awaiting-push", "running", "failing", "awaiting-review", "approved", "queued"]);

/** "Can open Changes and read code in" + the repositories, as links. */
function CanLine({ s }: { s: AgentSession }) {
  const can = (["change:create", "plan:create", "repo:read"] as Scope[]).filter((x) => s.scopes.includes(x)).map((x) => CAN[x]);
  if (can.length === 0) return <p class="agent__can">Can do nothing</p>;
  const verbs = can.length === 1 ? can[0] : `${can.slice(0, -1).join(", ")} and ${can[can.length - 1]}`;
  return (
    <p class="agent__can">
      Can {verbs} in{" "}
      {s.repoIds === null ? (
        "every repository you can access"
      ) : (
        <span class="agent__repos">
          {s.repos.map((r, i) => (
            <Fragment key={r.id}>
              {i > 0 ? (i === s.repos.length - 1 ? " and " : ", ") : null}
              <a href={`/repos/${encodeURIComponent(r.id)}`}>{r.name}</a>
            </Fragment>
          ))}
        </span>
      )}
    </p>
  );
}

/** Created, last active (its newest audit event counts, not only its last token use), and the end. */
function whenLine(s: AgentSession, a: AgentActivity | undefined, now: number): string {
  const parts = [`Created ${relative(s.createdAt, Math.max(now, Date.parse(s.createdAt)))}`];
  const used = [s.lastUsedAt, a?.last.at].filter((t): t is string => !!t).sort().pop();
  parts.push(used ? `last active ${relative(used, now)}` : "never used");
  // Just revoked: the minute clock may lag the server's stamp; never say "in under a minute".
  if (s.status === "revoked" && s.revokedAt) parts.push(`revoked ${relative(s.revokedAt, Math.max(now, Date.parse(s.revokedAt)))}`);
  else if (s.expiresAt) parts.push(`${Date.parse(s.expiresAt) > now ? "ends" : "ended"} ${relative(s.expiresAt, now)}`);
  else parts.push("no end date");
  return parts.join(" · ");
}

/** What the agent is doing now and what it last did, linked to it; the band's words. */
function NowLine({ a, now }: { a: AgentActivity | undefined; now: number }) {
  if (!a) return <p class="agent__now agent__now--none">Nothing recorded this week</p>;
  return (
    <p class="agent__now">
      <StateWord a={a} />
      {a.last.href ? (
        <a class="agent__last" href={a.last.href}>
          <LastAct a={a} now={now} />
        </a>
      ) : (
        <span class="agent__last">
          <LastAct a={a} now={now} />
        </span>
      )}
    </p>
  );
}

/** After a revoke: the work it leaves open, so a person can pick it up or close it. */
async function openWork(s: AgentSession): Promise<ChangeSummary[]> {
  const ids = s.repoIds ?? (await api.repos()).repos.map((r) => r.id);
  const lists = await Promise.all(ids.map((id) => api.changes(id).then((r) => r.changes, () => [] as ChangeSummary[])));
  return lists.flat().filter((c) => c.authorId === s.principalId && OPEN.has(c.status));
}

function LeftOpen({ work }: { work: ChangeSummary[] | "loading" | "error" }) {
  if (work === "loading") return <Loading label="Looking for its open changes" lines={1} />;
  if (work === "error") return <p class="agent__left">Couldn't list its open changes. Check its repositories.</p>;
  if (work.length === 0) return <p class="agent__left">It has no open changes.</p>;
  return (
    <div class="agent__left" data-testid="agent-left-open">
      <p>
        It leaves {plural(work.length, "open change")}. They stay open until someone closes or finishes them:
      </p>
      <ul>
        {work.map((c) => (
          <li key={c.id}>
            <a href={`/changes/${encodeURIComponent(c.id)}`}>{c.title}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionRow({ s, a, onRevoked }: { s: AgentSession; a: AgentActivity | undefined; onRevoked: (s: AgentSession) => void }) {
  const confirm = useSignal(false);
  const busy = useSignal(false);
  const result = useSignal<string | null>(null);
  const work = useSignal<ChangeSummary[] | "loading" | "error" | null>(null);
  const key = useSignal(newIdempotencyKey());
  const flow = FLOW[s.flow];
  const now = minuteClock.value;

  async function revoke() {
    busy.value = true;
    try {
      const { session } = await oauthApi.revokeSession(s.principalId, key.value);
      // Honest about what stops when: the platform refuses its tokens now, but a push token it
      // already minted for a fork keeps working until it expires (at most an hour).
      result.value = `${s.name} is revoked: the API and MCP refuse it from now on. A push token it already holds keeps working for up to an hour.`;
      confirm.value = false;
      onRevoked(session);
      work.value = "loading";
      work.value = await openWork(s).catch(() => "error" as const);
    } catch (err) {
      result.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <li class={`agent agent--${s.status}`} id={`agent-${s.principalId}`} data-testid="agent-row" data-agent={s.principalId}>
      <AgentMark name={s.name} id={s.principalId} size={36} />
      <div class="agent__main">
        <p class="agent__name">
          {s.name}
          {s.status !== "active" ? (
            <span class={`agent__status agent__status--${s.status}`} data-testid="agent-status" data-status={s.status}>
              {s.status === "expired" ? "Ended" : "Revoked"}
            </span>
          ) : (
            <span class="sr-only" data-testid="agent-status" data-status={s.status}>
              , active
            </span>
          )}
        </p>
        {s.status === "active" ? <NowLine a={a} now={now} /> : null}
        <p class="agent__via">
          <Icon name={flow.icon} size={14} /> {flow.label}
          {s.client && s.client.name !== s.name ? <span> · {s.client.name}</span> : null}
          {s.client?.id.startsWith("https://") ? <span class="agent__host"> · {new URL(s.client.id).host}</span> : null}
        </p>
        <CanLine s={s} />
        <p class="agent__keys">{whenLine(s, a, now)}</p>
        {result.value ? (
          <p class="agent__result" role="status">
            {result.value}
          </p>
        ) : null}
        {work.value ? <LeftOpen work={work.value} /> : null}
      </div>
      <div class="agent__actions">
        <LinkButton variant="quiet" size="sm" icon="scroll-text" href={trailHref(s.principalId)} data-testid="agent-trail" aria-label={`Trail of ${s.name} in the audit log`}>
          Trail
        </LinkButton>
        {s.status !== "active" ? null : confirm.value ? (
          <fieldset class="agent__confirm" aria-label={`Revoke ${s.name}`}>
            <p>
              Revoke {s.name}? The API and MCP refuse its tokens at once; a push token it already holds works for up to an hour.
              Its open changes stay open.
            </p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => (confirm.value = false)} disabled={busy.value}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" busy={busy.value} busyLabel="Revoking…" onClick={revoke} data-testid="agent-revoke-confirm">
                Revoke access
              </Button>
            </div>
          </fieldset>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            class="agent__revoke"
            data-testid="agent-revoke"
            onClick={() => {
              confirm.value = true;
              result.value = null;
            }}
          >
            Revoke…
          </Button>
        )}
      </div>
    </li>
  );
}

/** Someone else's agent, active in a repository you can see: read-only, its trail one click away. */
function OtherRow({ a }: { a: AgentActivity }) {
  const now = minuteClock.value;
  return (
    <li class="agent agent--other" id={`agent-${a.agent.id}`} data-testid="agent-other" data-agent={a.agent.id}>
      <AgentMark name={a.agent.name} id={a.agent.id} size={36} />
      <div class="agent__main">
        <p class="agent__name">
          {a.agent.name} <span class="agent__kind">{ownerLine(a.agent, null)}</span>
        </p>
        <NowLine a={a} now={now} />
      </div>
      <div class="agent__actions">
        <LinkButton variant="quiet" size="sm" icon="scroll-text" href={trailHref(a.agent.id)} data-testid="agent-trail" aria-label={`Trail of ${a.agent.name} in the audit log`}>
          Trail
        </LinkButton>
      </div>
    </li>
  );
}

function SelfRow({ p }: { p: Principal }) {
  return (
    <li class="agent">
      <Avatar kind={p.kind} name={p.name} id={p.id} size={36} />
      <div class="agent__main">
        <p class="agent__name">
          {p.name} <span class="agent__kind">you</span>
        </p>
        <p class="agent__keys">
          You approve Plans and review Changes. You can delegate only what you hold.
        </p>
        <ul class="agent__scopes" aria-label="What you may do">
          {p.scopes.map((s) => (
            <li key={s}>
              {scopeWords(s)} <code class="agent__scope-id">{s}</code>
            </li>
          ))}
        </ul>
      </div>
      <div class="agent__actions">
        <LinkButton variant="quiet" size="sm" icon="scroll-text" href={trailHref(p.id)} aria-label="Your trail in the audit log">
          Trail
        </LinkButton>
      </div>
    </li>
  );
}

export function AgentsView() {
  const res = useResource(() => oauthApi.sessions(), []);
  // The same audit read as the dashboard's band, so the page and the band say the same thing.
  const audit = useResource(() => api.audit({ limit: 100 }), []);
  const created = useSignal<CreateAgentResponse | null>(null);
  const showEnded = useSignal(false);
  const byHand = useSignal(false);
  const st = res.state.value;
  const au = audit.state.value;
  const me = principal.value;
  const sessions = st.status === "ok" ? st.data.sessions : [];
  // A row revoked here stays in place until the next visit, so its result and the work it
  // leaves open stay on screen; then it moves under Ended and revoked.
  const justRevoked = useSignal<string[]>([]);
  const here = (s: AgentSession) => s.status === "active" || justRevoked.value.includes(s.principalId);
  const active = sessions.filter(here);
  const ended = sessions.filter((s) => !here(s));
  const fleet = au.status === "ok" ? fleetFrom(au.data, minuteClock.value) : [];
  const activity = new Map(fleet.map((a) => [a.agent.id, a]));
  const mine = new Set(sessions.map((s) => s.principalId));
  // Agents of other people, seen in your repositories this week (the band lists them too).
  const others = fleet.filter((a) => !mine.has(a.agent.id) && a.agent.ownerId !== me?.id);
  const settled = st.status !== "loading" && au.status !== "loading";

  function replace(updated: AgentSession) {
    if (st.status !== "ok") return;
    justRevoked.value = [...justRevoked.value, updated.principalId];
    res.set({ sessions: st.data.sessions.map((s) => (s.principalId === updated.principalId ? updated : s)) });
  }

  return (
    <Page
      title="Agents"
      wide
      meta={
        <span>
          Every connected MCP client, CLI login and hand-made token is its own agent, owned by you. Each row is what it is doing,
          what it may touch and its trail.
        </span>
      }
    >
      <div class="agents-layout">
        <div class="agents-main">
          {created.value ? <TokenReveal created={created.value} onDone={() => (created.value = null)} /> : null}
          {!settled ? (
            <div role="status" aria-live="polite">
              <span class="sr-only">Loading your agents</span>
              <SkeletonHead />
              <SkeletonRows count={3} />
            </div>
          ) : null}
          {st.status === "error" ? <ErrorState error={st.error} what="your agents" onRetry={res.reload} /> : null}
          {settled && st.status === "ok" ? (
            <>
              <h2 class="agents__title">
                Your agents <span class="tnum agents__n">{active.filter((s) => s.status === "active").length}</span>
              </h2>
              {active.length === 0 ? (
                <p class="ev-sub">No agent can act for you right now. Connect one, or add one by hand.</p>
              ) : (
                <ul class="agents" data-testid="agents-mine">
                  {active.map((s) => (
                    <SessionRow key={s.principalId} s={s} a={activity.get(s.principalId)} onRevoked={replace} />
                  ))}
                </ul>
              )}
              {ended.length > 0 ? (
                <details class="disclosure agents__ended" open={showEnded.value} onToggle={(e) => (showEnded.value = e.currentTarget.open)}>
                  <summary>
                    <Icon name="chevron-down" class="disclosure__chev" />
                    Ended and revoked <span class="tnum agents__n">{plural(ended.length, "agent")}</span>
                  </summary>
                  <ul class="agents">
                    {ended.map((s) => (
                      <SessionRow key={s.principalId} s={s} a={activity.get(s.principalId)} onRevoked={replace} />
                    ))}
                  </ul>
                </details>
              ) : null}
              {others.length > 0 ? (
                <section aria-labelledby="others-title" data-testid="agents-others">
                  <h2 class="agents__title" id="others-title">
                    Other people's agents <span class="tnum agents__n">{others.length}</span>
                  </h2>
                  <p class="agents__lede">Active this week in repositories you can see. Only their owner can revoke them.</p>
                  <ul class="agents">
                    {others.map((a) => (
                      <OtherRow key={a.agent.id} a={a} />
                    ))}
                  </ul>
                </section>
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
          <Connect />
          <details class="disclosure by-hand" open={byHand.value} onToggle={(e) => (byHand.value = e.currentTarget.open)}>
            <summary data-testid="create-agent-open">
              <Icon name="chevron-down" class="disclosure__chev" />
              Add one by hand…
            </summary>
            <CreateAgent
              onCreated={(r) => {
                created.value = r;
                byHand.value = false;
                res.reload();
                window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
              }}
            />
          </details>
        </aside>
      </div>
    </Page>
  );
}
