import { useSignal } from "@preact/signals";
import { useLocation } from "preact-iso";
import { api, inlineError, newIdempotencyKey } from "../api/client.js";
import {
  type MembersView,
  membersApi,
  type RepoMember,
  type RepoRole,
  ROLE_COPY,
  ROLES,
} from "../api/members.js";
import { Page } from "../components/Shell.js";
import { Avatar, Button, ErrorState, Loading } from "../components/ui.js";
import { relative } from "../lib/time.js";
import { minuteClock } from "../state/clock.js";
import { useResource } from "../state/resource.js";
import { principal } from "../state/session.js";
import { AddMember, RoleGuide } from "./members-form.js";
import "../styles/members.css";

function MemberRow({
  repoId,
  m,
  view,
  isMe,
  now,
  onChanged,
  onLeft,
}: {
  repoId: string;
  m: RepoMember;
  view: MembersView;
  isMe: boolean;
  now: number;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);

  async function run(fn: () => Promise<unknown>, after: () => void) {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await fn();
      after();
    } catch (err) {
      error.value = inlineError(err);
      onChanged(); // re-read, so a refused role change shows the role that still holds
    } finally {
      busy.value = false;
    }
  }

  const setRole = (role: RepoRole) =>
    run(
      () => membersApi.add(repoId, { principalId: m.principalId, role }, newIdempotencyKey()),
      onChanged,
    );
  const remove = () =>
    run(
      () => membersApi.remove(repoId, m.principalId, newIdempotencyKey()),
      isMe ? onLeft : onChanged,
    );
  const roleId = `role-${m.principalId}`;

  return (
    <li class="member">
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
              value={m.role}
              disabled={busy.value}
              onChange={(e) => void setRole(e.currentTarget.value as RepoRole)}
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
        {view.canManage || isMe ? (
          <Button
            size="sm"
            variant="quiet"
            icon={isMe ? "log-out" : "trash"}
            busy={busy.value}
            onClick={() => void remove()}
          >
            {isMe ? "Leave" : "Remove"}
          </Button>
        ) : null}
      </div>
      {error.value ? (
        <p class="field__error member__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </li>
  );
}

export function MembersPage({ repoId }: { repoId: string }) {
  const { route } = useLocation();
  const res = useResource(() => Promise.all([api.repo(repoId), membersApi.list(repoId)]), [repoId]);
  const st = res.state.value;
  const crumbs = [{ href: "/", label: "Repositories" }];

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
  const [detail, view] = st.data;
  const me = principal.value?.id ?? null;
  const yours = view.viewerRole ? ROLE_COPY[view.viewerRole].label.toLowerCase() : "not a member";
  return (
    <Page
      title="Members"
      crumbs={[...crumbs, { href: `/repos/${repoId}`, label: detail.repo.name }]}
      meta={
        <span>
          {detail.repo.name} · you are {view.viewerRole === "owner" ? "an owner" : `a ${yours}`}
        </span>
      }
    >
      <div class="members">
        <section class="section" aria-labelledby="members-list">
          <h2 id="members-list" class="sr-only">
            People with access
          </h2>
          <ul class="rows members__list">
            {view.members.map((m) => (
              <MemberRow
                key={m.principalId}
                repoId={repoId}
                m={m}
                view={view}
                isMe={m.principalId === me}
                now={minuteClock.value}
                onChanged={res.reload}
                onLeft={() => route("/")}
              />
            ))}
          </ul>
          <p class="members__note">
            Agents act with the role of the person who runs them, and never approve or review
            anything.
          </p>
        </section>
        {view.canManage ? <AddMember repoId={repoId} onAdded={res.reload} /> : null}
        <RoleGuide />
      </div>
    </Page>
  );
}
