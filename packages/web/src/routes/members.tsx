import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import {
  type MemberAgent,
  type MembersView,
  membersApi,
  type RepoMember,
  type RepoRole,
  ROLE_COPY,
  ROLES,
} from "../api/members.js";
import { paletteRepos } from "../components/Palette.js";
import { Page } from "../components/Shell.js";
import { Avatar, Button, ErrorState, Loading } from "../components/ui.js";
import { relative } from "../lib/time.js";
import { plural } from "../lib/vocab.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import { AddMember, PendingInvites, RoleGuide } from "./members-form.js";
import "../styles/members.css";

const RANK: Record<RepoRole, number> = { reader: 1, reviewer: 2, maintainer: 3, owner: 4 };

/** "a reviewer", "an owner": roles in a sentence. */
function aRole(role: RepoRole): string {
  const word = ROLE_COPY[role].label.toLowerCase();
  return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

/** The agents a person runs, read-only: they act with this person's role here. */
function MemberAgents({ agents }: { agents: MemberAgent[] }) {
  if (agents.length === 0) return null;
  return (
    <p class="member__agents" data-testid="member-agents">
      <span class="member__agents-count">{plural(agents.length, "agent")} with this role:</span>
      {agents.map((a) => (
        <a key={a.principalId} class="member__agent" href="/agents">
          <Avatar kind="agent" name={a.name} id={a.principalId} size={18} />
          {a.name}
        </a>
      ))}
    </p>
  );
}

/** What removing (or leaving) takes away, agents included, so the confirmation can say it. */
function removeLine(m: RepoMember, isMe: boolean, repoName: string, agents: MemberAgent[]): string {
  const theirs =
    agents.length === 0
      ? ""
      : ` ${isMe ? "Your" : "Their"} ${plural(agents.length, "agent")} (${agents.map((a) => a.name).join(", ")}) ${agents.length === 1 ? "loses" : "lose"} access too.`;
  return isMe
    ? `Leave ${repoName}? You lose access at once, and only an owner can add you back.${theirs}`
    : `Remove ${m.name} from ${repoName}?${theirs}`;
}

function MemberRow({
  repoId,
  repoName,
  m,
  agents,
  view,
  isMe,
  now,
  onChanged,
  onLeft,
}: {
  repoId: string;
  repoName: string;
  m: RepoMember;
  agents: MemberAgent[];
  view: MembersView;
  isMe: boolean;
  now: number;
  onChanged: (message: string | null) => void;
  onLeft: () => void;
}) {
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const confirm = useSignal<"remove" | RepoRole | null>(null);
  const key = useSignal(newIdempotencyKey());

  async function run(fn: (k: string) => Promise<unknown>, after: () => void) {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await fn(key.value);
      key.value = newIdempotencyKey();
      confirm.value = null;
      after();
    } catch (err) {
      error.value = inlineError(err);
      onChanged(null); // re-read, so a refused role change shows the role that still holds
    } finally {
      busy.value = false;
    }
  }

  const setRole = (role: RepoRole) =>
    run(
      (k) => membersApi.add(repoId, { principalId: m.principalId, role }, k),
      () => onChanged(`${isMe ? "You are" : `${m.name} is`} now ${aRole(role)}.`),
    );
  const remove = () =>
    run(
      (k) => membersApi.remove(repoId, m.principalId, k),
      isMe ? onLeft : () => onChanged(`Removed ${m.name}.`),
    );
  // Only a step down for yourself needs a second look: you cannot undo it on your own.
  const pickRole = (role: RepoRole) => {
    if (role === m.role) return;
    if (isMe && RANK[role] < RANK[m.role]) confirm.value = role;
    else void setRole(role);
  };
  const roleId = `role-${m.principalId}`;
  const pending = confirm.value;

  return (
    <li class="member" data-testid="member" data-principal={m.principalId}>
      <Avatar kind="human" name={m.name} size={32} />
      <div class="member__who">
        <span class="member__name">
          {m.name}
          {isMe ? <span class="member__you"> (you)</span> : null}
        </span>
        <span class="member__meta">
          {m.email ? <span>{m.email}</span> : null}
          <span>
            Added <time dateTime={m.addedAt}>{relative(m.addedAt, now)}</time>
          </span>
        </span>
        <MemberAgents agents={agents} />
      </div>
      <div class="member__role">
        {view.canManage ? (
          <>
            <label class="sr-only" for={roleId}>
              Role of {m.name}
            </label>
            <select
              id={roleId}
              class="input member__select"
              value={pending !== null && pending !== "remove" ? pending : m.role}
              disabled={busy.value}
              onChange={(e) => pickRole(e.currentTarget.value as RepoRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_COPY[r].label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span class="member__role-label">{ROLE_COPY[m.role].label}</span>
        )}
      </div>
      <div class="member__act">
        {(view.canManage || isMe) && pending === null ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="member-remove"
            onClick={() => (confirm.value = "remove")}
          >
            {isMe ? "Leave…" : "Remove…"}
          </Button>
        ) : null}
      </div>
      {pending !== null ? (
        <fieldset
          class="member__confirm"
          aria-label={
            pending === "remove"
              ? isMe
                ? `Leave ${repoName}`
                : `Remove ${m.name}`
              : "Confirm your new role"
          }
          data-testid="member-confirm"
        >
          <p>
            {pending === "remove"
              ? removeLine(m, isMe, repoName, agents)
              : `Make yourself ${aRole(pending)}? You lose what ${aRole(m.role)} may do here${agents.length > 0 ? `, and so do your ${plural(agents.length, "agent")}` : ""}; only an owner can give it back.`}
          </p>
          <div class="member__confirm-buttons">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy.value}
              onClick={() => (confirm.value = null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={busy.value}
              busyLabel={pending === "remove" ? (isMe ? "Leaving…" : "Removing…") : "Saving…"}
              data-testid="member-confirm-act"
              onClick={() => void (pending === "remove" ? remove() : setRole(pending))}
            >
              {pending === "remove"
                ? isMe
                  ? `Leave ${repoName}`
                  : `Remove ${m.name}`
                : `Make me ${aRole(pending)}`}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {error.value ? (
        <p class="field__error member__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </li>
  );
}

/** "Maya Okafor", "Maya Okafor and Dev Patel": who to ask for a role. */
function names(list: string[]): string {
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export function MembersPage({ repoId }: { repoId: string }) {
  const { route } = useLocation();
  const res = useResource(
    () =>
      Promise.all([
        api.repo(repoId),
        membersApi.list(repoId),
        // The viewer's own agents fill in their row when the server does not list agents yet.
        api.principals().then(
          (r) => r.principals.filter((p) => p.kind === "agent"),
          () => [],
        ),
      ]),
    [repoId],
  );
  const notice = useSignal<string | null>(null);
  const st = res.state.value;
  const known = paletteRepos.value.find((r) => r.id === repoId)?.name;
  const crumbs = [
    { href: "/dashboard", label: "Dashboard" },
    ...(known ? [{ href: `/repos/${repoId}`, label: known }] : []),
  ];

  if (st.status === "loading") {
    return (
      <Page title="Members" crumbs={crumbs}>
        <Loading label="Loading members" lines={5} />
      </Page>
    );
  }
  if (st.status === "error") {
    return (
      <Page title="Members" crumbs={crumbs}>
        <ErrorState error={st.error} what="this repository's members" onRetry={res.reload} />
      </Page>
    );
  }
  const [detail, view, mine] = st.data;
  const me = principal.value?.id ?? null;
  const repoName = detail.repo.name;
  const owners = view.members.filter((m) => m.role === "owner").map((m) => m.name);
  const agentsOf = (m: RepoMember): MemberAgent[] =>
    m.agents ??
    (m.principalId === me ? mine.map((a) => ({ principalId: a.id, name: a.name })) : []);
  return (
    <Page
      title="Members"
      crumbs={[
        { href: "/dashboard", label: "Dashboard" },
        { href: `/repos/${repoId}`, label: repoName },
      ]}
      meta={
        <>
          <span>
            {repoName} ·{" "}
            {view.viewerRole ? `you are ${aRole(view.viewerRole)}` : "you are not a member"}
          </span>
          {view.canManage || owners.length === 0 ? null : (
            <span data-testid="members-owners">
              {owners.length === 1 ? "Owner" : "Owners"}: {names(owners)}
            </span>
          )}
        </>
      }
    >
      <div class="members">
        <section class="section" aria-labelledby="members-list">
          <h2 id="members-list" class="sr-only">
            People with access
          </h2>
          <p class="members__status" role="status">
            {notice.value}
          </p>
          <ul class="rows members__list">
            {view.members.map((m) => (
              <MemberRow
                key={m.principalId}
                repoId={repoId}
                repoName={repoName}
                m={m}
                agents={agentsOf(m)}
                view={view}
                isMe={m.principalId === me}
                now={minuteClock.value}
                onChanged={(message) => {
                  notice.value = message;
                  res.reload();
                }}
                onLeft={() => route("/dashboard")}
              />
            ))}
          </ul>
          <p class="members__note">
            Agents act with the role of the person who runs them, and never approve or review
            anything. Removing a person removes their agents' access too.
            {view.canManage
              ? null
              : ` Ask ${owners.length > 0 ? names(owners) : "an owner"} to change a role.`}
          </p>
        </section>
        {view.canManage ? (
          <PendingInvites
            repoId={repoId}
            invites={view.invites}
            now={minuteClock.value}
            onChanged={res.reload}
          />
        ) : null}
        {view.canManage ? (
          <AddMember
            repoId={repoId}
            onAdded={() => {
              notice.value = null;
              res.reload();
            }}
          />
        ) : null}
        <RoleGuide />
      </div>
    </Page>
  );
}
