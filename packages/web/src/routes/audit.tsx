import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { Fragment } from "preact";
import { useEffect } from "preact/hooks";
import { api } from "../api/client.js";
import type { AuditEvent, AuditPage, PrincipalRef } from "../api/types.js";
import { Icon } from "../components/Icon.js";
import { Page } from "../components/Shell.js";
import { Button, EmptyState, ErrorState, Hash, Loading, Who } from "../components/ui.js";
import { actionLabel } from "../lib/audit-actions.js";
import { formatDateTime } from "../lib/time.js";
import { num } from "../lib/vocab.js";
import { useResource } from "../state/resource.js";
import "../styles/audit.css";

function subjectHref(subject: string): string | null {
  const [kind, id] = subject.split(":");
  if (!id) return null;
  switch (kind) {
    case "change":
      return `/changes/${id}`;
    case "plan":
      return `/plans/${id}`;
    case "repo":
      return `/repos/${id}`;
    case "principal":
      return "/agents";
    default:
      return null;
  }
}

function Subject({ subject }: { subject: string }) {
  const href = subjectHref(subject);
  const [kind, id] = subject.split(":");
  const body = (
    <>
      <span class="audit__kind">{kind}</span> {id ?? subject}
    </>
  );
  return href ? (
    <a href={href} class="audit__subject">
      {body}
    </a>
  ) : (
    <span class="audit__subject">{body}</span>
  );
}

function EventRow({ e, who, linksToPrev }: { e: AuditEvent; who: PrincipalRef | undefined; linksToPrev: boolean | null }) {
  return (
    <li class="audit__row">
      <span class="audit__seq tnum">#{num.format(e.seq)}</span>
      <time class="audit__time tnum" dateTime={e.at}>
        {formatDateTime(e.at)}
      </time>
      <span class="audit__who">
        {who ? (
          <Who kind={who.kind} name={who.name} size={20} compact />
        ) : e.principalId.startsWith("system:") ? (
          <Who kind="system" name={e.principalId.slice("system:".length)} size={20} compact />
        ) : (
          <span>{e.principalId}</span>
        )}
      </span>
      <span class="audit__what">
        <span class="audit__action" title={e.action}>
          {actionLabel(e.action)}
        </span>
        <Subject subject={e.subject} />
      </span>
      <details class="audit__hash">
        <summary>
          <Hash value={e.hash} head={8} tail={0} />
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

export function AuditView() {
  const { query, route } = useLocation();
  const subject = query.subject ?? "";
  const draft = useSignal(subject);
  const pages = useSignal<AuditPage[]>([]);
  const more = useSignal<"idle" | "loading" | "error">("idle");
  const res = useResource(() => api.audit({ subject: subject || undefined, limit: 30 }), [subject]);
  const st = res.state.value;

  useEffect(() => {
    draft.value = subject;
    pages.value = [];
  }, [subject, draft, pages]);

  const all: AuditPage[] = st.status === "ok" ? [st.data, ...pages.value] : [];
  const events = all.flatMap((p) => p.events);
  const principals: Record<string, PrincipalRef> = Object.assign({}, ...all.map((p) => p.principals ?? {}));
  const last = all[all.length - 1];
  const chain = all[0]?.chain;

  async function loadMore() {
    if (!last?.nextCursor) return;
    more.value = "loading";
    try {
      const next = await api.audit({ subject: subject || undefined, cursor: last.nextCursor, limit: 30 });
      pages.value = [...pages.value, next];
      more.value = "idle";
    } catch {
      more.value = "error";
    }
  }

  return (
    <Page title="Audit log" wide>
      {chain ? (
        <section class={`chain ${chain.verified ? "chain--ok" : "chain--bad"}`} aria-live="polite">
          <Icon name={chain.verified ? "shield-check" : "shield-alert"} size={22} />
          <div>
            <p class="chain__title">{chain.verified ? "Hash chain verified" : `Chain broken at event #${chain.brokenAt ?? "?"}`}</p>
            <p class="chain__line">
              {chain.verified
                ? "Every event commits to the hash of the one before it and carries a platform signature. Nothing has been edited or removed."
                : "An event no longer matches the hash its successor recorded. Treat everything after it as unverified and tell your platform admin."}
            </p>
          </div>
        </section>
      ) : null}

      <form
        class="audit-filter"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = draft.value.trim();
          route(v ? `/audit?subject=${encodeURIComponent(v)}` : "/audit");
        }}
      >
        <label class="field audit-filter__field">
          <span class="field__label">Filter by subject or action</span>
          <span class="audit-filter__row">
            <input class="input" type="search" placeholder="change:ljrqxulb08q0u2za3n6w or plan.approved" value={draft.value} onInput={(e) => (draft.value = e.currentTarget.value)} />
            <Button type="submit" variant="secondary" icon="search">
              Filter
            </Button>
          </span>
        </label>
      </form>

      {st.status === "loading" ? <Loading label="Loading audit events" lines={8} /> : null}
      {st.status === "error" ? <ErrorState error={st.error} what="the audit log" onRetry={res.reload} /> : null}
      {st.status === "ok" && events.length === 0 ? (
        <EmptyState
          icon="scroll-text"
          title={subject ? `No events match “${subject}”` : "No events yet"}
          action={
            subject ? (
              <Button variant="secondary" size="sm" onClick={() => route("/audit")}>
                Clear filter
              </Button>
            ) : undefined
          }
        >
          {subject ? <p>Subjects look like change:ID, plan:ID, repo:ID or principal:ID. Actions look like plan.approved.</p> : <p>Every approval, merge, rollout step and token change lands here.</p>}
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
          <ol class="audit" reversed>
            {events.map((e, i) => {
              const older = events[i + 1];
              // Only adjacent events can be checked here: a gap in the sequence is events you
              // can't see (other repositories) or a filter, not a broken link. The server checks
              // the whole chain and reports it in the banner above.
              const adjacent = older !== undefined && older.seq === e.seq - 1;
              const links = adjacent && !subject ? older.hash === e.prevHash : null;
              const hidden = older !== undefined && !subject ? e.seq - older.seq - 1 : 0;
              return (
                <Fragment key={e.seq}>
                  <EventRow e={e} who={principals[e.principalId]} linksToPrev={links} />
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
            <p class="audit__end">{subject ? "End of matching events." : "Genesis. The chain starts here."}</p>
          )}
        </>
      ) : null}
    </Page>
  );
}
