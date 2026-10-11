/**
 * The audit log: every signed event, newest first, readable without opening each row. Events name
 * their subject by title (the plan or change, its repo) and their actor with its accountable
 * person. Filters are plain fields (who, action, subject) kept in the URL as
 * `?actor=&action=&subject=`, so a trail is a link: the Agents page and the band link here.
 */
import { signal, useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { Fragment } from "preact";
import { useEffect } from "preact/hooks";
import { api } from "../api/client.js";
import type { AuditEvent, AuditPage, AuditSubjectRef, PrincipalRef } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, Hash, SkeletonRows, Who } from "../components/ui.js";
import { actionLabel } from "../lib/audit-actions.js";
import { subjectHref as screenOf } from "../lib/fleet.js";
import { formatDateTime } from "../lib/time.js";
import { num, plural } from "../lib/vocab.js";
import { useResource } from "../state/resource.js";
import "../styles/audit.css";

/** Who and what this session has seen, so the pickers keep their options while a filter is on. */
const seenPrincipals = signal<Record<string, PrincipalRef>>({});
const seenActions = signal<string[]>([]);

function remember(page: AuditPage): void {
  const p = page.principals ?? {};
  if (Object.keys(p).some((id) => !seenPrincipals.peek()[id])) seenPrincipals.value = { ...seenPrincipals.peek(), ...p };
  const actions = page.events.map((e) => e.action).filter((a) => !seenActions.peek().includes(a));
  if (actions.length > 0) seenActions.value = [...new Set([...seenActions.peek(), ...actions])];
}

export interface AuditFilter {
  actor: string;
  action: string;
  subject: string;
}

/** `/audit?actor=…&action=…&subject=…`, empty fields left out. */
export function auditHref(f: Partial<AuditFilter>): string {
  const q = new URLSearchParams();
  for (const k of ["actor", "action", "subject"] as const) {
    const v = f[k]?.trim();
    if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `/audit?${s}` : "/audit";
}

function subjectHref(subject: string): string | null {
  const [kind, id] = subject.split(":", 2);
  if (kind === "principal" && id) return `/agents#agent-${encodeURIComponent(id)}`;
  return screenOf(subject);
}

/** The subject by name ("Per-tenant invoice number sequences in billing-api"), its id kept as Meta. */
function Subject({ subject, named: r }: { subject: string; named: AuditSubjectRef | undefined }) {
  const href = subjectHref(subject);
  const [kind, id] = subject.split(":", 2);
  const body = r ? (
    <span class="audit__title">{r.title}</span>
  ) : (
    <>
      <span class="audit__kind">{kind}</span> {id ?? subject}
    </>
  );
  return (
    <span class="audit__subject-cell">
      {href ? (
        <a href={href} class="audit__subject" title={subject}>
          {body}
        </a>
      ) : (
        <span class="audit__subject" title={subject}>
          {body}
        </span>
      )}
      {r?.repoName && r.repoName !== r.title ? <span class="audit__in">in {r.repoName}</span> : null}
      <a class="audit__only" href={auditHref({ subject })} aria-label={`Only events on ${r?.title ?? subject}`} title="Only events on this">
        <Icon name="search" size={14} />
      </a>
    </span>
  );
}

/** The server's one-liner when it says more than the label (a reason, a sha, a count). */
export function auditDetail(e: { action: string; summary?: string }): string | null {
  const summary = e.summary?.trim();
  if (!summary) return null;
  const label = actionLabel(e.action).toLowerCase();
  const plain = summary.toLowerCase();
  return plain === label || plain === e.action.replace(/[._-]+/g, " ").toLowerCase() ? null : summary;
}

function Actor({ id, who }: { id: string; who: PrincipalRef | undefined }) {
  const system = id.startsWith("system:");
  const kind = who?.kind ?? (system ? "system" : null);
  const name = who?.name ?? (system ? id.slice("system:".length) : id);
  if (kind === null) return <span class="audit__who">{id}</span>;
  return (
    <span class="audit__who">
      <a class="audit__who-link" href={auditHref({ actor: id })} title={`Only ${name}'s events`}>
        <Who kind={kind} name={name} id={id} owner={who?.ownerName} size={20} compact />
      </a>
      {kind === "agent" ? <span class="audit__owner">{who?.ownerName ? `agent of ${who.ownerName}` : "agent"}</span> : null}
    </span>
  );
}

function EventRow({ e, who, named, linksToPrev }: { e: AuditEvent & { summary?: string }; who: PrincipalRef | undefined; named: AuditSubjectRef | undefined; linksToPrev: boolean | null }) {
  const detail = auditDetail(e);
  return (
    <li class="audit__row" data-testid="audit-event" data-actor={e.principalId} data-action={e.action}>
      <span class="audit__seq tnum">#{num.format(e.seq)}</span>
      <time class="audit__time tnum" dateTime={e.at}>
        {formatDateTime(e.at)}
      </time>
      <Actor id={e.principalId} who={who} />
      <span class="audit__what">
        <span class="audit__action" title={e.action}>
          {actionLabel(e.action)}
        </span>
        <Subject subject={e.subject} named={named} />
        {detail ? <span class="audit__detail">{detail}</span> : null}
      </span>
      <details class="audit__hash">
        <summary aria-label={`Hash and signature of event ${e.seq}`}>
          <span class="audit__hash-short">
            <Hash value={e.hash} head={8} tail={0} />
          </span>
          {linksToPrev === false ? (
            <span class="tone--danger audit__break">
              <Icon name="triangle-alert" size={14} /> link broken
            </span>
          ) : null}
          <Icon name="chevron-down" size={14} class="disclosure__chev" />
        </summary>
        <dl class="audit__hashes">
          <dt>hash</dt>
          <dd>
            <Hash value={e.hash} full />
          </dd>
          <dt>prev</dt>
          <dd>
            <Hash value={e.prevHash} full />
          </dd>
          <dt>payload</dt>
          <dd>
            <Hash value={e.payloadHash} full />
          </dd>
          <dt>signature</dt>
          <dd>
            <Hash value={e.signature} head={16} tail={8} />
          </dd>
          <dt>key</dt>
          <dd>
            <Hash value={e.keyId} full />
          </dd>
        </dl>
      </details>
    </li>
  );
}

const KIND_GROUP: { kind: PrincipalRef["kind"]; label: string }[] = [
  { kind: "human", label: "People" },
  { kind: "agent", label: "Agents" },
  { kind: "system", label: "Platform" },
];

/** Who, action and subject as plain fields. Pickers apply at once; the subject on Enter. */
function Filters({ f, onApply }: { f: AuditFilter; onApply: (f: AuditFilter) => void }) {
  const draft = useSignal(f.subject);
  useEffect(() => {
    draft.value = f.subject;
  }, [f.subject, draft]);
  const people = Object.values(seenPrincipals.value);
  if (f.actor && !seenPrincipals.value[f.actor]) people.push({ id: f.actor, kind: "system", name: f.actor, ownerId: null });
  const actions = [...new Set([...seenActions.value, ...(f.action ? [f.action] : [])])].sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
  const any = f.actor || f.action || f.subject;
  return (
    <form
      class="audit-filter"
      role="search"
      aria-label="Filter the audit log"
      data-testid="audit-filter"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({ ...f, subject: draft.value.trim() });
      }}
    >
      <label class="field">
        <span class="field__label">Who</span>
        <span class="select">
          <select class="input" value={f.actor} onChange={(e) => onApply({ ...f, actor: e.currentTarget.value })} data-testid="audit-filter-actor">
          <option value="">Everyone</option>
          {KIND_GROUP.map((g) => {
            const list = people.filter((p) => p.kind === g.kind).sort((a, b) => a.name.localeCompare(b.name));
            return list.length === 0 ? null : (
              <optgroup key={g.kind} label={g.label}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.kind === "agent" && p.ownerName ? `${p.name} (agent of ${p.ownerName})` : p.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
          <Icon name="chevron-down" size={16} class="select__chev" />
        </span>
      </label>
      <label class="field">
        <span class="field__label">Action</span>
        <span class="select">
          <select class="input" value={f.action} onChange={(e) => onApply({ ...f, action: e.currentTarget.value })} data-testid="audit-filter-action">
          <option value="">Any action</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
          <Icon name="chevron-down" size={16} class="select__chev" />
        </span>
      </label>
      <label class="field audit-filter__subject">
        <span class="field__label">Subject</span>
        <span class="audit-filter__row">
          <input
            class="input"
            type="search"
            placeholder="change:… or plan:…"
            value={draft.value}
            onInput={(e) => (draft.value = e.currentTarget.value)}
            aria-describedby="subject-hint"
            data-testid="audit-filter-subject"
          />
          <Button type="submit" variant="secondary" icon="search">
            Filter
          </Button>
        </span>
        <span class="field__hint" id="subject-hint">
          Or use the search mark beside any subject below.
        </span>
      </label>
      {any ? (
        <a class="audit-filter__clear" href="/audit" data-testid="audit-filter-clear">
          <Icon name="x" size={14} /> Clear filters
        </a>
      ) : null}
    </form>
  );
}

/** Verified: one line, the explanation a click away. Broken: the whole warning, always open. */
function Chain({ chain, count }: { chain: AuditPage["chain"]; count: number }) {
  // Reads verify in batches (security M9): not verified, no break found, more to check.
  const pending = !chain.verified && chain.brokenAt === undefined && chain.complete === false;
  if (pending) {
    return (
      <section class="chain chain--pending" aria-live="polite" data-testid="audit-chain" data-verified="partial">
        <Icon name="timer" size={22} />
        <div>
          <p class="chain__title">
            Verified through event #{chain.verifiedThrough ?? 0} of #{chain.headSeq ?? "?"}
          </p>
          <p class="chain__line">
            Newer events are checked a batch at a time. Reload to continue; until then treat events after this one as not yet
            verified.
          </p>
        </div>
      </section>
    );
  }
  if (!chain.verified) {
    return (
      <section class="chain chain--bad" aria-live="polite" data-testid="audit-chain" data-verified="false">
        <Icon name="shield-alert" size={22} />
        <div>
          <p class="chain__title">Chain broken at event #{chain.brokenAt ?? "?"}</p>
          <p class="chain__line">
            An event no longer matches the hash its successor recorded. Treat everything after it as unverified and tell your
            platform admin.
          </p>
        </div>
      </section>
    );
  }
  return (
    <details class="chain chain--ok" data-testid="audit-chain" data-verified="true">
      <summary class="chain__summary">
        <Icon name="shield-check" size={18} />
        <span class="chain__title">Hash chain verified</span>
        <span class="chain__count tnum">· {plural(count, "event")} shown</span>
        <Icon name="chevron-down" size={14} class="disclosure__chev" />
      </summary>
      <p class="chain__line">
        Every event commits to the hash of the one before it and carries a platform signature. Nothing has been edited or
        removed.
      </p>
    </details>
  );
}

export function AuditView() {
  const { query, route } = useLocation();
  const f: AuditFilter = { actor: query.actor ?? "", action: query.action ?? "", subject: query.subject ?? "" };
  const filtered = !!(f.actor || f.action || f.subject);
  const pages = useSignal<AuditPage[]>([]);
  // Open from 900px (the summary is hidden there); on phones folded unless a filter is on.
  const filtersOpen = useSignal(filtered || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 900px)").matches);
  const more = useSignal<"idle" | "loading" | "error">("idle");
  const ask = (cursor?: string) =>
    api.audit({ actor: f.actor || undefined, action: f.action || undefined, subject: f.subject || undefined, cursor, limit: 30 });
  const res = useResource(() => ask().then((p) => (remember(p), p)), [f.actor, f.action, f.subject]);
  const st = res.state.value;
  // Widening past 900px unfolds them (the fold's summary isn't shown there).
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 900px)");
    const on = () => {
      if (mq.matches) filtersOpen.value = true;
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [filtersOpen]);
  // You and your agents are always in the Who picker, even before they show up in a page.
  useEffect(() => {
    api.principals().then(
      ({ principals: list }) => {
        const me = list.find((p) => p.ownerId === null);
        const refs = Object.fromEntries(list.map((p) => [p.id, { id: p.id, kind: p.kind, name: p.name, ownerId: p.ownerId, ownerName: p.ownerId ? (me?.name ?? null) : null }]));
        seenPrincipals.value = { ...refs, ...seenPrincipals.peek() };
      },
      () => {},
    );
  }, []);

  useEffect(() => {
    pages.value = [];
  }, [f.actor, f.action, f.subject, pages]);

  const all: AuditPage[] = st.status === "ok" ? [st.data, ...pages.value] : [];
  const events = all.flatMap((p) => p.events);
  const principals: Record<string, PrincipalRef> = Object.assign({}, ...all.map((p) => p.principals ?? {}));
  const subjects: Record<string, AuditSubjectRef> = Object.assign({}, ...all.map((p) => p.subjects ?? {}));
  const last = all[all.length - 1];
  const chain = all[0]?.chain;

  async function loadMore() {
    if (!last?.nextCursor) return;
    more.value = "loading";
    try {
      const next = await ask(last.nextCursor);
      remember(next);
      pages.value = [...pages.value, next];
      more.value = "idle";
    } catch {
      more.value = "error";
    }
  }

  return (
    <Page title="Audit log" wide>
      {chain ? <Chain chain={chain} count={events.length} /> : <div class="chain-space" aria-hidden="true" />}
      <details class="disclosure audit-filter-fold" open={filtersOpen.value} onToggle={(e) => (filtersOpen.value = e.currentTarget.open)}>
        <summary data-testid="audit-filter-open">
          <Icon name="chevron-down" class="disclosure__chev" />
          Filter
          <span class="audit-filter-fold__now">
            · {filtered ? [f.actor && (principals[f.actor]?.name ?? seenPrincipals.value[f.actor]?.name ?? f.actor), f.action && actionLabel(f.action), f.subject].filter(Boolean).join(" · ") : "everything"}
          </span>
        </summary>
        <Filters f={f} onApply={(next) => route(auditHref(next))} />
      </details>

      {st.status === "loading" ? (
        <div class="loading" role="status" aria-live="polite">
          <span class="sr-only">Loading audit events</span>
          <SkeletonRows count={8} shape="table" mark="circle" />
        </div>
      ) : null}
      {st.status === "error" ? <ErrorState error={st.error} what="the audit log" onRetry={res.reload} /> : null}
      {st.status === "ok" && events.length === 0 ? (
        <EmptyState
          icon="scroll-text"
          title={filtered ? "No events match these filters" : "No events yet"}
          action={
            filtered ? (
              <Button variant="secondary" size="sm" onClick={() => route("/audit")}>
                Clear filters
              </Button>
            ) : undefined
          }
        >
          {filtered ? <p>Filters match exactly: one person or agent, one action, one subject such as change:ID or plan:ID.</p> : <p>Every approval, merge, rollout step and token change lands here.</p>}
        </EmptyState>
      ) : null}
      {events.length > 0 ? (
        <>
          <div class="audit__cols" aria-hidden="true">
            <span>Event</span>
            <span>Time</span>
            <span>Who</span>
            <span>What</span>
            <span>Hash</span>
          </div>
          <ol class="audit" reversed data-testid="audit-events">
            {events.map((e, i) => {
              const older = events[i + 1];
              // Only adjacent events can be checked here: a gap in the sequence is events you
              // can't see (other repositories) or a filter, not a broken link. The server checks
              // the whole chain and reports it in the banner above.
              const adjacent = older !== undefined && older.seq === e.seq - 1;
              const links = adjacent && !filtered ? older.hash === e.prevHash : null;
              const hidden = older !== undefined && !filtered ? e.seq - older.seq - 1 : 0;
              return (
                <Fragment key={e.seq}>
                  <EventRow e={e} who={principals[e.principalId]} named={subjects[e.subject]} linksToPrev={links} />
                  {hidden > 0 ? (
                    <li class="audit__gap">
                      {hidden === 1 ? `#${num.format(e.seq - 1)}` : `#${num.format(e.seq - hidden)} to #${num.format(e.seq - 1)}`} {hidden === 1 ? "is" : "are"} in repositories you can't see
                    </li>
                  ) : null}
                </Fragment>
              );
            })}
          </ol>
          {last?.nextCursor ? (
            <div class="audit__more">
              <Button variant="secondary" busy={more.value === "loading"} busyLabel="Loading older events…" onClick={loadMore}>
                Load older events
              </Button>
              {more.value === "error" ? (
                <p class="field__error" role="alert">
                  Couldn't load older events. Retry.
                </p>
              ) : null}
            </div>
          ) : (
            <p class="audit__end">{filtered ? "End of matching events." : "Genesis. The chain starts here."}</p>
          )}
        </>
      ) : null}
    </Page>
  );
}
