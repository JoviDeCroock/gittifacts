import { useSignal } from "@preact/signals";
import { inlineError, newIdempotencyKey } from "../api/client.js";
import { membersApi, type RepoInvite, type RepoRole, ROLE_COPY, ROLES } from "../api/members.js";
import { Avatar, Button, Command } from "../components/ui.js";
import { relative } from "../lib/time.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Owners add a person by e-mail; the role defaults to the least that lets them help. Unless an
 * account has verified that e-mail, they get an invite link instead, shown here once (there is no
 * e-mail to send it; an unverified sign-up could be anyone's, security audit M3).
 */
export function AddMember({ repoId, onAdded }: { repoId: string; onAdded: () => void }) {
  const email = useSignal("");
  const role = useSignal<RepoRole>("reviewer");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const added = useSignal<string | null>(null);
  const link = useSignal<{ email: string; url: string; role: RepoRole } | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy.value) return;
    const value = email.value.trim();
    if (!EMAIL.test(value)) {
      error.value = "Enter the e-mail they sign in with.";
      return;
    }
    busy.value = true;
    error.value = null;
    added.value = null;
    link.value = null;
    try {
      const r = await membersApi.add(
        repoId,
        { email: value, role: role.value },
        newIdempotencyKey(),
      );
      email.value = "";
      if ("invite" in r) {
        link.value = { email: r.invite.email, url: r.inviteUrl, role: r.invite.role };
      } else {
        added.value = `${r.member.name} is now a ${ROLE_COPY[r.member.role].label.toLowerCase()}.`;
      }
      onAdded();
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <form
      class="section add-member"
      onSubmit={submit}
      aria-labelledby="add-member-title"
      noValidate
    >
      <h2 id="add-member-title" class="add-member__title">
        Add a person
      </h2>
      <p class="add-member__lede">
        Unless their account's e-mail is verified, you get an invite link to send them. Only people
        are members; their agents act with their role.
      </p>
      <div class="add-member__fields">
        <label class="field">
          <span class="field__label">E-mail</span>
          <input
            class="input"
            type="email"
            value={email.value}
            onInput={(e) => (email.value = e.currentTarget.value)}
            placeholder="name@company.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellcheck={false}
            aria-invalid={error.value ? "true" : undefined}
            aria-describedby={error.value ? "add-member-error" : undefined}
          />
        </label>
        <label class="field">
          <span class="field__label">Role</span>
          <select
            class="input"
            value={role.value}
            onChange={(e) => (role.value = e.currentTarget.value as RepoRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_COPY[r].label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" icon="plus" busy={busy.value} busyLabel="Adding…">
          Add
        </Button>
      </div>
      {error.value ? (
        <p class="field__error" id="add-member-error" role="alert">
          {error.value}
        </p>
      ) : null}
      {added.value ? (
        <p class="add-member__done" role="status">
          {added.value}
        </p>
      ) : null}
      {link.value ? <InviteLinkOnce {...link.value} /> : null}
    </form>
  );
}

/** The new invite's link: the only time it is shown. */
function InviteLinkOnce({ email, url, role }: { email: string; url: string; role: RepoRole }) {
  return (
    <div class="invite-once" role="status">
      <p class="invite-once__title">
        Send {email} this link to join as a {ROLE_COPY[role].label.toLowerCase()}:
      </p>
      <Command text={url} />
      <p class="invite-once__note">
        It works once, for a week, and only for someone signed in as {email}. Copy it now: it isn't
        shown again. Lost it? Add them again for a new link.
      </p>
    </div>
  );
}

/** Open invites, for owners: who was asked, as what, until when; revoke closes the link. */
export function PendingInvites({
  repoId,
  invites,
  now,
  onChanged,
}: {
  repoId: string;
  invites: RepoInvite[];
  now: number;
  onChanged: () => void;
}) {
  if (invites.length === 0) return null;
  return (
    <section class="section invites" aria-labelledby="invites-title">
      <h2 id="invites-title" class="add-member__title">
        Invited
      </h2>
      <ul class="rows members__list">
        {invites.map((i) => (
          <InviteRow key={i.id} repoId={repoId} invite={i} now={now} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function InviteRow({
  repoId,
  invite,
  now,
  onChanged,
}: {
  repoId: string;
  invite: RepoInvite;
  now: number;
  onChanged: () => void;
}) {
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  async function revoke() {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await membersApi.revokeInvite(repoId, invite.id, newIdempotencyKey());
    } catch (err) {
      error.value = inlineError(err);
    } finally {
      busy.value = false;
      onChanged();
    }
  }
  return (
    <li class="member invite">
      <Avatar kind="human" name={invite.email} size={32} />
      <div class="member__who">
        <span class="member__name">{invite.email}</span>
        <span class="member__meta">
          <span>Invited by {invite.invitedBy.name}</span>
          <span>
            {invite.expired ? "Expired " : "Expires "}
            <time dateTime={invite.expiresAt}>{relative(invite.expiresAt, now)}</time>
          </span>
        </span>
      </div>
      <div class="member__role">
        <span class="member__role-label">{ROLE_COPY[invite.role].label}</span>
      </div>
      <div class="member__act">
        <Button
          size="sm"
          variant="quiet"
          icon="trash"
          busy={busy.value}
          busyLabel="Revoking…"
          onClick={() => void revoke()}
        >
          Revoke
        </Button>
      </div>
      {error.value ? (
        <p class="field__error member__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </li>
  );
}

/** What each role may do, lowest first: every role includes the ones above it. */
export function RoleGuide() {
  return (
    <section class="section role-guide" aria-labelledby="role-guide-title">
      <h2 id="role-guide-title" class="role-guide__title">
        What each role may do
      </h2>
      <dl class="role-guide__list">
        {ROLES.map((r) => (
          <div key={r} class="role-guide__row">
            <dt>{ROLE_COPY[r].label}</dt>
            <dd>
              {r === "reader" ? "" : "Everything above, and: "}
              {ROLE_COPY[r].may}
            </dd>
          </div>
        ))}
      </dl>
      <p class="role-guide__note">
        Nobody approves their own plan or change. An unclaimed repo has no members until someone
        claims it.
      </p>
    </section>
  );
}
