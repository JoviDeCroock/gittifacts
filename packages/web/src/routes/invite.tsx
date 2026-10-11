/**
 * /invite/:token — a person joins a repo an owner invited their e-mail to (DECISIONS 2026-10-11).
 *
 * Readable signed out (the link is the secret): which repo, which role, who sent it, and the
 * invited e-mail partly hidden. Joining needs a signed-in person whose account e-mail is the
 * invited one; anyone else is told which account to use. One decision: Join.
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ApiError, inlineError, newIdempotencyKey } from "../api/client.js";
import { type InviteLink, membersApi, ROLE_COPY } from "../api/members.js";
import { ConsentFrame, ConsentOutcome } from "../components/ConsentPanel.js";
import { Button, ErrorState, LinkButton, Loading } from "../components/ui.js";
import { signInHref } from "../lib/nav.js";
import { useResource } from "../state/resource.js";
import { session, signOut } from "../state/session.js";
import "../styles/account.css";

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

export function InvitePage({ token }: { token: string }) {
  const res = useResource(() => membersApi.inviteLink(token), [token]);
  const joined = useSignal<{ repoId: string; role: InviteLink["role"] } | null>(null);
  const st = res.state.value;
  const s = session.value;

  useEffect(() => {
    document.title =
      st.status === "ok" ? `Join ${st.data.repo.name} · gittifacts` : "Join a repo · gittifacts";
  }, [st]);

  return (
    <ConsentFrame class="invite-frame">
      {st.status === "loading" || s.status === "loading" ? (
        <Loading label="Loading the invite" lines={4} />
      ) : null}
      {st.status === "error" ? <LoadFailed error={st.error} onRetry={res.reload} /> : null}
      {st.status === "ok" && s.status !== "loading" ? (
        joined.value ? (
          <Joined name={st.data.repo.name} {...joined.value} />
        ) : (
          <Stage token={token} view={st.data} onJoined={(j) => (joined.value = j)} onStale={res.reload} />
        )
      ) : null}
    </ConsentFrame>
  );
}

function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <ConsentOutcome tone="neutral" title="This invite link doesn't work">
        <p>Check you copied all of it, or ask the repo's owner to add you again for a new link.</p>
      </ConsentOutcome>
    );
  }
  return <ErrorState error={error} what="this invite" onRetry={onRetry} />;
}

function Joined({ name, repoId, role }: { name: string; repoId: string; role: InviteLink["role"] }) {
  const label = ROLE_COPY[role].label.toLowerCase();
  return (
    <ConsentOutcome
      tone="ok"
      title={`You're ${article(label)} ${label} of ${name}`}
      action={
        <LinkButton href={`/repos/${encodeURIComponent(repoId)}`} variant="primary" icon="arrow-up-right">
          Open the repo
        </LinkButton>
      }
    >
      <p>{ROLE_COPY[role].may}</p>
    </ConsentOutcome>
  );
}

function Stage({
  token,
  view,
  onJoined,
  onStale,
}: {
  token: string;
  view: InviteLink;
  onJoined: (j: { repoId: string; role: InviteLink["role"] }) => void;
  onStale: () => void;
}) {
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const key = useSignal(newIdempotencyKey());
  const here = `/invite/${encodeURIComponent(token)}`;
  const name = view.repo.name;
  const label = ROLE_COPY[view.role].label.toLowerCase();

  if (view.status === "accepted" && view.viewer.role) {
    return <Joined name={name} repoId={view.repo.id} role={view.viewer.role} />;
  }
  if (view.status !== "pending") {
    const why = {
      accepted: "This invite was already used: an invite link works once.",
      revoked: "The repo's owner revoked this invite.",
      expired: "This invite expired: invite links work for a week.",
    }[view.status];
    return (
      <ConsentOutcome tone="neutral" title={`This invite to ${name} is closed`}>
        <p>{why}</p>
        <p>Ask {view.invitedBy.name} to add you again; they get a new link to send you.</p>
      </ConsentOutcome>
    );
  }

  async function join() {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      const r = await membersApi.acceptInvite(token, key.value);
      onJoined({ repoId: r.repoId, role: r.role });
    } catch (err) {
      error.value = inlineError(err);
      key.value = newIdempotencyKey();
      if (err instanceof ApiError && err.status === 409) onStale();
    } finally {
      busy.value = false;
    }
  }

  const ask = (
    <p>
      {view.invitedBy.name} invited <b>{view.emailHint}</b> to {name} as {article(label)} {label}.{" "}
      {ROLE_COPY[view.role].may}
    </p>
  );

  if (!view.viewer.signedIn) {
    return (
      <ConsentOutcome
        tone="neutral"
        title={`Join ${name}`}
        action={
          <>
            <LinkButton href={`/signin?mode=signup&next=${encodeURIComponent(here)}`} variant="primary" icon="user">
              Create an account
            </LinkButton>
            <LinkButton href={signInHref(here)} variant="secondary">
              Sign in
            </LinkButton>
          </>
        }
      >
        {ask}
        <p>Use the invited e-mail. You'll come straight back here to join.</p>
      </ConsentOutcome>
    );
  }

  if (!view.viewer.emailMatches) {
    const me = session.value.status === "authed" ? session.value.me.user?.email : null;
    return (
      <ConsentOutcome
        tone="neutral"
        title="This invite is for another e-mail"
        action={
          <Button variant="primary" icon="log-out" onClick={() => void signOut(signInHref(here))}>
            Sign out and switch account
          </Button>
        }
      >
        {ask}
        <p>
          You're signed in{me ? ` as ${me}` : ""}. Only someone signed in with {view.emailHint} can
          join with this link.
        </p>
      </ConsentOutcome>
    );
  }

  return (
    <ConsentOutcome
      tone="neutral"
      title={`Join ${name}`}
      action={
        <Button variant="primary" icon="check" busy={busy.value} busyLabel="Joining…" onClick={() => void join()}>
          Join as {article(label)} {label}
        </Button>
      }
    >
      {ask}
      {view.viewer.role ? (
        <p>You're already {article(view.viewer.role)} {view.viewer.role} here; joining keeps that role.</p>
      ) : null}
      <p>Joining is recorded in the repo's audit log.</p>
      {error.value ? (
        <p class="field__error" role="alert">
          {error.value}
        </p>
      ) : null}
    </ConsentOutcome>
  );
}
